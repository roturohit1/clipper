import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import type { Clip } from '@/lib/api'
import type { JobRecord } from './store'
import { getConfig } from './config'

type ProjectRow = {
  id: string
  status: JobRecord['status']
  progress: number
  stage: string | null
  error: string | null
  warnings: string
  source_name: string | null
  project_name: string | null
  project_number: number | null
  folder: string | null
  created_at: string | null
  updated_at: string
  transcription: JobRecord['transcription'] | null
  selection: JobRecord['selection'] | null
  options: string
  source: string
}

type ClipRow = {
  clip_id: string
  position: number
  title: string
  duration_seconds: number
  source_start_seconds: number
  source_end_seconds: number | null
  preview_url: string
  download_url: string
  reason: string | null
  captioned: number | null
  file: string
}

const g = globalThis as unknown as { __avcpDb?: DatabaseSync }

function database() {
  if (g.__avcpDb) return g.__avcpDb
  const dir = getConfig().dataDir
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'cutline.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      stage TEXT,
      error TEXT,
      warnings TEXT NOT NULL DEFAULT '[]',
      source_name TEXT,
      project_name TEXT,
      project_number INTEGER,
      folder TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      transcription TEXT,
      selection TEXT,
      options TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clips (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      clip_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      source_start_seconds INTEGER NOT NULL,
      source_end_seconds INTEGER,
      preview_url TEXT NOT NULL,
      download_url TEXT NOT NULL,
      reason TEXT,
      captioned INTEGER,
      file TEXT NOT NULL,
      PRIMARY KEY (project_id, clip_id)
    );
  `)
  g.__avcpDb = db
  return db
}

function transaction(run: () => void) {
  const db = database()
  db.exec('BEGIN')
  try {
    run()
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction may already be closed.
    }
    throw error
  }
}

function clipsFor(projectId: string): Array<Clip & { file: string }> {
  const rows = database().prepare('SELECT * FROM clips WHERE project_id = ? ORDER BY position ASC').all(projectId) as ClipRow[]
  return rows.map((row) => ({
    id: row.clip_id,
    title: row.title,
    durationSeconds: row.duration_seconds,
    sourceStartSeconds: row.source_start_seconds,
    sourceEndSeconds: row.source_end_seconds ?? undefined,
    previewUrl: row.preview_url,
    downloadUrl: row.download_url,
    reason: row.reason ?? undefined,
    captioned: row.captioned == null ? undefined : Boolean(row.captioned),
    file: row.file,
  }))
}

function toJob(row: ProjectRow): JobRecord {
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    stage: row.stage ?? undefined,
    error: row.error ?? undefined,
    warnings: JSON.parse(row.warnings) as string[],
    sourceName: row.source_name ?? undefined,
    projectName: row.project_name ?? undefined,
    projectNumber: row.project_number ?? undefined,
    folder: row.folder ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at,
    transcription: row.transcription ?? undefined,
    selection: row.selection ?? undefined,
    options: JSON.parse(row.options) as JobRecord['options'],
    source: JSON.parse(row.source) as JobRecord['source'],
    clips: clipsFor(row.id),
  }
}

export function hasJob(id: string) {
  const row = database().prepare('SELECT 1 AS ok FROM projects WHERE id = ?').get(id) as { ok: number } | undefined
  return Boolean(row)
}

export function folderFor(id: string) {
  const row = database().prepare('SELECT folder FROM projects WHERE id = ?').get(id) as { folder: string | null } | undefined
  return row?.folder ?? null
}

export function readJob(id: string): JobRecord | null {
  const row = database().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  return row ? toJob(row) : null
}

export function readJobs(limit = 200): JobRecord[] {
  const rows = database().prepare('SELECT * FROM projects ORDER BY COALESCE(created_at, \'\') DESC LIMIT ?').all(limit) as ProjectRow[]
  return rows.map(toJob)
}

export function deleteJob(id: string) {
  database().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

export function upsertJob(job: JobRecord) {
  transaction(() => {
    const db = database()
    db.prepare(
      `INSERT INTO projects (
        id, status, progress, stage, error, warnings, source_name, project_name, project_number, folder,
        created_at, updated_at, transcription, selection, options, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        progress = excluded.progress,
        stage = excluded.stage,
        error = excluded.error,
        warnings = excluded.warnings,
        source_name = excluded.source_name,
        project_name = excluded.project_name,
        project_number = excluded.project_number,
        folder = excluded.folder,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        transcription = excluded.transcription,
        selection = excluded.selection,
        options = excluded.options,
        source = excluded.source`,
    ).run(
      job.id,
      job.status,
      job.progress,
      job.stage ?? null,
      job.error ?? null,
      JSON.stringify(job.warnings ?? []),
      job.sourceName ?? null,
      job.projectName ?? null,
      job.projectNumber ?? null,
      job.folder ?? null,
      job.createdAt ?? null,
      job.updatedAt,
      job.transcription ?? null,
      job.selection ?? null,
      JSON.stringify(job.options),
      JSON.stringify(job.source),
    )
    db.prepare('DELETE FROM clips WHERE project_id = ?').run(job.id)
    const insert = db.prepare(
      `INSERT INTO clips (
        project_id, clip_id, position, title, duration_seconds, source_start_seconds, source_end_seconds,
        preview_url, download_url, reason, captioned, file
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    job.clips.forEach((clip, position) => {
      insert.run(
        job.id,
        clip.id,
        position,
        clip.title,
        clip.durationSeconds,
        clip.sourceStartSeconds,
        clip.sourceEndSeconds ?? null,
        clip.previewUrl,
        clip.downloadUrl,
        clip.reason ?? null,
        clip.captioned == null ? null : clip.captioned ? 1 : 0,
        clip.file,
      )
    })
  })
}
