import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { parseCaptionOptions } from '../captions'
import { parseAspect, parseAspectFit } from '../aspect'
import { EMPTY_MUSIC_LIBRARY_MESSAGE, parseAudio, parseCropEdges, parseTrim, parseWatermark } from '../branding'
import { parseClipMode } from '../clip-mode'
import { listMusic, logoPath, musicPath } from './assets'
import { enqueue } from './pipeline'
import { allocateProject, saveJob, type JobRecord } from './store'

export const jsonError = (message: string, status = 400) => NextResponse.json({ detail: message }, { status, headers: { 'Cache-Control': 'no-store' } })

export function parseOptions(clipLength: unknown, subtitleStyle: unknown, captionInput: Record<string, unknown> = {}) {
  const length = Number(clipLength ?? 45)
  if (!Number.isFinite(length) || length < 10 || length > 300) throw new Error('clip_length must be between 10 and 300 seconds.')
  const style = String(subtitleStyle ?? 'bold')
  if (style !== 'bold' && style !== 'clean' && style !== 'karaoke') throw new Error('subtitle_style must be bold, clean, or karaoke.')
  const watermark = parseWatermark(captionInput)
  if (watermark?.logo && !logoPath()) throw new Error('Upload a logo first (Branding), or turn the logo off.')
  const audio = parseAudio(captionInput)
  if (audio.copyrightSafe && !listMusic().length) throw new Error(EMPTY_MUSIC_LIBRARY_MESSAGE)
  if (audio.mode !== 'original' && audio.musicId && !musicPath(audio.musicId)) throw new Error('The chosen music track was not found. Upload it again or pick another.')
  if (audio.mode !== 'original' && !audio.musicId && !audio.copyrightSafe) throw new Error('The chosen music track was not found. Upload it again or pick another.')
  return { clipLength: Math.round(length), subtitleStyle: style, clipMode: parseClipMode(captionInput.clip_mode), aspect: parseAspect(captionInput.aspect), aspectFit: parseAspectFit(captionInput.aspect_fit), captions: parseCaptionOptions(captionInput), watermark, trim: parseTrim(captionInput), crop: parseCropEdges(captionInput), audio } as JobRecord['options']
}

export function newJob(options: JobRecord['options'], source: JobRecord['source'], sourceName: string, id = randomUUID()): JobRecord {
  const project = allocateProject(id, sourceName)
  const job: JobRecord = {
    id,
    status: 'queued',
    progress: 0,
    stage: 'Queued',
    sourceName,
    projectName: project.projectName,
    projectNumber: project.projectNumber,
    folder: project.folder,
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
