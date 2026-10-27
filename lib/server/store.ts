import fs from 'node:fs'
import path from 'node:path'
import type { Clip, Job } from '@/lib/api'
import type { CaptionOptions } from '@/lib/captions'
import type { Aspect, AspectFit } from '@/lib/aspect'
import type { ClipMode } from '@/lib/clip-mode'
import { getConfig } from './config'
import { deleteJob, folderFor, hasJob, readJob, readJobs, upsertJob } from './db'

/** Server-side job record (superset of the public Job shape). */
export type JobRecord = Omit<Job, 'clips'> & {
  clips: Array<Clip & { file: string }>
  options: { clipLength: number; subtitleStyle: 'bold' | 'clean' | 'karaoke'; /** absent on older jobs, which behave like 'highlights' */ clipMode?: ClipMode; /** output frame shape; absent on older jobs, which kept the source size */ aspect?: Aspect; aspectFit?: AspectFit; /** absent on jobs created before caption options existed */ captions?: CaptionOptions }
  source: { type: 'upload' | 'url'; url?: string; file?: string }
  updatedAt: string
}

const g = globalThis as unknown as {
  __avcpJobs?: Map<string, JobRecord>
  __avcpFolders?: Map<string, string>
  __avcpIndexed?: boolean
  __avcpDbSynced?: boolean
  __avcpDeleted?: Set<string>
}
const cache = (g.__avcpJobs ??= new Map<string, JobRecord>())
/** Ids of deleted projects: a still-running job must never write its record or folder back. */
const deleted = (g.__avcpDeleted ??= new Set<string>())
export const isDeleted = (id: string) => deleted.has(id)
/** Job id → folder name under data/projects (for example "001-my-video"). */
const folderById = (g.__avcpFolders ??= new Map<string, string>())

export const ID_RE = /^[a-f0-9-]{36}$/
export const CLIP_ID_RE = /^clip-\d{1,3}$/
/** Numbered project folders we create. Never accept a folder name from the client. */
const FOLDER_RE = /^(\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*$/

export const jobsRoot = () => path.join(getConfig().dataDir, 'jobs')
export const projectsRoot = () => path.join(getConfig().dataDir, 'projects')

export function projectTitle(sourceName: string) {
  const leaf = sourceName.split(/[/\\]/).filter(Boolean).pop() ?? sourceName
  const base = leaf.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim()
  return (base || 'Untitled video').slice(0, 80)
}

function slugifyProject(sourceName: string) {
  const slug = projectTitle(sourceName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'video'
}

function safeFolder(folder: string | undefined | null) {
  return folder && FOLDER_RE.test(folder) ? folder : null
}

/** Read project folders once per process so a restart can still find each video's directory. */
function indexProjects() {
  if (g.__avcpIndexed) return
  g.__avcpIndexed = true
  let names: string[] = []
  try {
    names = fs.readdirSync(projectsRoot())
  } catch {
    return
  }
  for (const name of names) {
    if (!safeFolder(name)) continue
    try {
      const job = JSON.parse(fs.readFileSync(path.join(projectsRoot(), name, 'job.json'), 'utf8')) as JobRecord
      if (job?.id && ID_RE.test(job.id)) folderById.set(job.id, safeFolder(job.folder) ?? name)
    } catch {
      // A folder with no job file yet is an upload still in progress, or a failed one.
    }
  }
}

/**
 * Create the next project folder for one video. Calling again with the same id returns that folder
 * so the upload can reserve it before the job record is saved.
 */
export function allocateProject(id: string, sourceName: string) {
  if (!ID_RE.test(id)) throw new Error('Invalid project id.')
  const existing = safeFolder(folderById.get(id))
  if (existing) {
    return {
      folder: existing,
      projectNumber: Number(/^(\d+)/.exec(existing)?.[1] ?? 0),
      projectName: projectTitle(sourceName),
      dir: path.join(projectsRoot(), existing),
    }
  }
  const root = projectsRoot()
  fs.mkdirSync(root, { recursive: true })
  let max = 0
  for (const name of fs.readdirSync(root)) {
    const match = /^(\d{3,})-/.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  const slug = slugifyProject(sourceName)
  let number = max + 1
  let folder = ''
  for (;;) {
    folder = `${String(number).padStart(3, '0')}-${slug}`
    try {
      fs.mkdirSync(path.join(root, folder))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        number += 1
        continue
      }
      throw error
    }
  }
  folderById.set(id, folder)
  return { folder, projectNumber: number, projectName: projectTitle(sourceName), dir: path.join(root, folder) }
}

export function jobDir(id: string) {
  if (!ID_RE.test(id)) return path.join(jobsRoot(), 'invalid')
  const known = safeFolder(folderById.get(id))
  if (known) return path.join(projectsRoot(), known)
  const stored = safeFolder(folderFor(id))
  if (stored) {
    folderById.set(id, stored)
    return path.join(projectsRoot(), stored)
  }
  indexProjects()
  const indexed = safeFolder(folderById.get(id))
  if (indexed) return path.join(projectsRoot(), indexed)
  // Jobs created before projects existed stay in data/jobs/<id>.
  return path.join(jobsRoot(), id)
}

export function ensureJobDir(id: string) {
  const dir = jobDir(id)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Delete a job directory that never became a saved project (failed upload). */
export function removeJobFiles(id: string) {
  if (!ID_RE.test(id)) return
  const dir = path.resolve(jobDir(id))
  const root = path.resolve(getConfig().dataDir)
  if (dir !== root && dir.startsWith(root + path.sep)) fs.rmSync(dir, { recursive: true, force: true })
  folderById.delete(id)
  cache.delete(id)
  try {
    deleteJob(id)
  } catch {
    // The database row may not exist yet for an upload that failed before the project was saved.
  }
}

/** True when `target` is a strict descendant of `parent` (after resolving both). */
function isInside(parent: string, target: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(target))
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function removePath(target: string) {
  // Retries cover Windows briefly holding a file open right after its process was killed.
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}

/**
 * Delete a project: its record and its whole folder (source upload, clips, captions, transcript, job.json).
 * The folder is derived from the id (never from client input) and must be a direct child of data/projects or data/jobs.
 */
export function deleteProject(id: string) {
  if (!ID_RE.test(id)) throw new Error('Invalid project id.')
  const dir = path.resolve(jobDir(id))
  const roots = [projectsRoot(), jobsRoot()].map((root) => path.resolve(root))
  if (!roots.some((root) => path.dirname(dir) === root && isInside(root, dir))) throw new Error('Refusing to delete a folder outside the data folder.')
  deleted.add(id)
  removePath(dir)
  folderById.delete(id)
  cache.delete(id)
  try {
    deleteJob(id)
  } catch {
    // Nothing to remove if the row never existed.
  }
}

/** Delete one clip's video (and its caption file) and drop it from the project. Other clips keep their ids. */
export function deleteClip(job: JobRecord, clipId: string): boolean {
  if (!CLIP_ID_RE.test(clipId)) throw new Error('Invalid clip id.')
  const index = job.clips.findIndex((clip) => clip.id === clipId)
  if (index === -1) return false
  const dir = path.resolve(jobDir(job.id))
  const targets = [path.resolve(dir, job.clips[index].file), path.resolve(dir, `${clipId}.ass`), path.resolve(dir, 'clips', `${clipId}.mp4`)]
  for (const target of targets) {
    if (!isInside(dir, target)) throw new Error('Refusing to delete a file outside the project folder.')
    removePath(target)
  }
  job.clips.splice(index, 1)
  saveJob(job)
  return true
}

export function saveJob(job: JobRecord) {
  if (deleted.has(job.id)) return
  job.updatedAt = new Date().toISOString()
  const folder = safeFolder(job.folder)
  if (folder) folderById.set(job.id, folder)
  cache.set(job.id, job)
  upsertJob(job)
  const dir = ensureJobDir(job.id)
  const tmp = path.join(dir, 'job.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2))
  try {
    fs.renameSync(tmp, path.join(dir, 'job.json'))
  } catch {
    // Windows can refuse to replace a file that is briefly locked (antivirus/indexer); fall back to a direct write.
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2))
  }
}

function jobFiles(): JobRecord[] {
  const records: JobRecord[] = []
  const read = (dir: string) => {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')) as JobRecord
      if (job?.id && ID_RE.test(job.id)) records.push(job)
    } catch {
      // Skip folders that are still uploading or have no project record.
    }
  }
  try {
    for (const name of fs.readdirSync(projectsRoot())) {
      if (safeFolder(name)) read(path.join(projectsRoot(), name))
    }
  } catch {
    // No project directory yet.
  }
  try {
    for (const name of fs.readdirSync(jobsRoot())) {
      if (ID_RE.test(name)) read(path.join(jobsRoot(), name))
    }
  } catch {
    // No legacy job directory yet.
  }
  return records
}

/** Copy existing folder records into SQLite once per process. The database is the list after that. */
function syncFromDisk() {
  if (g.__avcpDbSynced) return
  g.__avcpDbSynced = true
  for (const job of jobFiles()) {
    const folder = safeFolder(job.folder)
    if (folder) folderById.set(job.id, folder)
    if (hasJob(job.id)) continue
    if (job.status === 'queued' || job.status === 'processing') {
      job.status = 'failed'
      job.error = 'This job was interrupted by a server restart. Please submit it again.'
    }
    job.clips = job.clips ?? []
    job.warnings = job.warnings ?? []
    job.updatedAt = job.updatedAt || new Date().toISOString()
    upsertJob(job)
    cache.set(job.id, job)
  }
}

function finishLoad(job: JobRecord) {
  const folder = safeFolder(job.folder)
  if (folder) folderById.set(job.id, folder)
  // A job that was running when the server stopped can never finish. The in-memory cache skips this.
  if (job.status === 'queued' || job.status === 'processing') {
    job.status = 'failed'
    job.error = 'This job was interrupted by a server restart. Please submit it again.'
    saveJob(job)
    return job
  }
  cache.set(job.id, job)
  return job
}

export function loadJob(id: string): JobRecord | null {
  if (!ID_RE.test(id) || deleted.has(id)) return null
  const cached = cache.get(id)
  if (cached) return cached
  const stored = readJob(id)
  if (stored) return finishLoad(stored)
  const file = path.join(jobDir(id), 'job.json')
  if (!fs.existsSync(file)) return null
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8')) as JobRecord
    job.clips = job.clips ?? []
    job.warnings = job.warnings ?? []
    return finishLoad(job)
  } catch {
    return null
  }
}

export function listJobs(limit = 200): JobRecord[] {
  syncFromDisk()
  const jobs = readJobs(limit).filter((job) => !deleted.has(job.id))
  for (const job of jobs) {
    const folder = safeFolder(job.folder)
    if (folder) folderById.set(job.id, folder)
    cache.set(job.id, job)
  }
  return jobs
}

/** Clips in play order (clip index). The download number everywhere (1.mp4, 2.mp4, ...) is the position in this list + 1. */
export function orderedClips(job: JobRecord) {
  const sequence = (id: string) => Number(/^clip-(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER)
  return [...job.clips].sort((a, b) => sequence(a.id) - sequence(b.id))
}

/** Filesystem-safe name for downloads. */
export function safeDownloadName(value: string, fallback: string) {
  const cleaned = value.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 60)
  return cleaned || fallback
}

export function toPublic(job: JobRecord): Job {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress),
    stage: job.stage,
    error: job.error,
    warnings: job.warnings,
    sourceName: job.sourceName,
    projectName: job.projectName,
    projectNumber: job.projectNumber,
    folder: safeFolder(job.folder) ?? undefined,
    clipsFolder: job.folder && safeFolder(job.folder) ? `projects/${job.folder}/clips` : `jobs/${job.id}/clips`,
    createdAt: job.createdAt,
    transcription: job.transcription,
    selection: job.selection,
    clips: job.clips.map(({ file: _file, ...clip }) => clip),
  }
}
