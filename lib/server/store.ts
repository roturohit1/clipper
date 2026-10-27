import fs from 'node:fs'
import path from 'node:path'
import type { Clip, Job } from '@/lib/api'
import type { CaptionOptions } from '@/lib/captions'
import type { ClipMode } from '@/lib/clip-mode'
import { getConfig } from './config'

/** Server-side job record (superset of the public Job shape). */
export type JobRecord = Omit<Job, 'clips'> & {
  clips: Array<Clip & { file: string }>
  options: { clipLength: number; subtitleStyle: 'bold' | 'clean' | 'karaoke'; /** absent on older jobs, which behave like 'highlights' */ clipMode?: ClipMode; /** absent on jobs created before caption options existed */ captions?: CaptionOptions }
  source: { type: 'upload' | 'url'; url?: string; file?: string }
  updatedAt: string
}

const g = globalThis as unknown as { __avcpJobs?: Map<string, JobRecord> }
const cache = (g.__avcpJobs ??= new Map<string, JobRecord>())

export const ID_RE = /^[a-f0-9-]{36}$/
export const CLIP_ID_RE = /^clip-\d{1,3}$/

export const jobsRoot = () => path.join(getConfig().dataDir, 'jobs')
export const jobDir = (id: string) => path.join(jobsRoot(), id)

export function ensureJobDir(id: string) {
  fs.mkdirSync(jobDir(id), { recursive: true })
  return jobDir(id)
}

export function saveJob(job: JobRecord) {
  job.updatedAt = new Date().toISOString()
  cache.set(job.id, job)
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

export function loadJob(id: string): JobRecord | null {
  if (!ID_RE.test(id)) return null
  const cached = cache.get(id)
  if (cached) return cached
  try {
    const job = JSON.parse(fs.readFileSync(path.join(jobDir(id), 'job.json'), 'utf8')) as JobRecord
    // A job that was running when the server stopped can never finish.
    if (job.status === 'queued' || job.status === 'processing') {
      job.status = 'failed'
      job.error = 'This job was interrupted by a server restart. Please submit it again.'
      saveJob(job)
    }
    cache.set(id, job)
    return job
  } catch {
    return null
  }
}

export function listJobs(): JobRecord[] {
  let ids: string[] = []
  try {
    ids = fs.readdirSync(jobsRoot()).filter((name) => ID_RE.test(name))
  } catch {
    return []
  }
  return ids
    .map(loadJob)
    .filter((job): job is JobRecord => Boolean(job))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, 30)
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
    createdAt: job.createdAt,
    transcription: job.transcription,
    selection: job.selection,
    clips: job.clips.map(({ file: _file, ...clip }) => clip),
  }
}
