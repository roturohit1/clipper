import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { jsonError } from '@/lib/server/http'
import { CLIP_ID_RE, deleteClip, jobDir, loadJob, toPublic } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Serves a rendered clip with HTTP Range support (needed for seeking in <video>). ?download=1 forces a file download. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string; clipId: string }> }) {
  const { id, clipId } = await ctx.params
  const job = loadJob(id)
  const clip = CLIP_ID_RE.test(clipId) ? job?.clips.find((c) => c.id === clipId) : undefined
  if (!job || !clip) return jsonError('Clip not found.', 404)
  const file = path.join(jobDir(id), clip.file)
  let size: number
  try {
    size = fs.statSync(file).size
  } catch {
    return jsonError('The clip file is no longer available.', 404)
  }

  const download = new URL(request.url).searchParams.get('download') === '1'
  const base = (job.sourceName || 'clip').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 40)
  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${base}-${clipId}.mp4"`,
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
  let start = 0
  let end = size - 1
  let status = 200
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1])
      if (range[2]) end = Math.min(Number(range[2]), size - 1)
    } else {
      start = Math.max(0, size - Number(range[2]))
    }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = String(end - start + 1)
  const stream = fs.createReadStream(file, { start, end })
  request.signal.addEventListener('abort', () => stream.destroy())
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers })
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string; clipId: string }> }) {
  const { id, clipId } = await ctx.params
  if (!CLIP_ID_RE.test(clipId)) return jsonError('Video not found.', 404)
  const job = loadJob(id)
  if (!job) return jsonError('Project not found.', 404)
  if (job.status === 'queued' || job.status === 'processing') return jsonError('This project is still processing. Wait for it to finish, or delete the whole project.', 409)
  try {
    if (!deleteClip(job, clipId)) return jsonError('Video not found.', 404)
  } catch (error) {
    return jsonError(error instanceof Error ? `Could not delete the video: ${error.message}` : 'Could not delete the video.', 500)
  }
  return Response.json(toPublic(job), { headers: { 'Cache-Control': 'no-store' } })
}
