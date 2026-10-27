import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { enqueue } from './pipeline'
import { saveJob, type JobRecord } from './store'

export const jsonError = (message: string, status = 400) => NextResponse.json({ detail: message }, { status, headers: { 'Cache-Control': 'no-store' } })

export function parseOptions(clipLength: unknown, subtitleStyle: unknown) {
  const length = Number(clipLength ?? 45)
  if (!Number.isFinite(length) || length < 10 || length > 300) throw new Error('clip_length must be between 10 and 300 seconds.')
  const style = String(subtitleStyle ?? 'bold')
  if (style !== 'bold' && style !== 'clean' && style !== 'karaoke') throw new Error('subtitle_style must be bold, clean, or karaoke.')
  return { clipLength: Math.round(length), subtitleStyle: style } as JobRecord['options']
}

export function newJob(options: JobRecord['options'], source: JobRecord['source'], sourceName: string, id = randomUUID()): JobRecord {
  const job: JobRecord = {
    id,
    status: 'queued',
    progress: 0,
    stage: 'Queued',
    sourceName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options,
    source,
    clips: [],
    warnings: [],
  }
  saveJob(job)
  return job
}

export { enqueue }
