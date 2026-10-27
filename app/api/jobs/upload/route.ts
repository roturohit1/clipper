import busboy from 'busboy'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { NextResponse } from 'next/server'
import { getConfig } from '@/lib/server/config'
import { enqueue, jsonError, newJob, parseOptions } from '@/lib/server/http'
import { allocateProject, removeJobFiles, toPublic } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EXT_RE = /^\.(mp4|m4v|mov|webm|mkv|avi|flv|ts|mpg|mpeg|3gp|ogv|wmv)$/i

export async function POST(request: Request) {
  const cfg = getConfig()
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.startsWith('multipart/form-data') || !request.body) return jsonError('Send the video as multipart/form-data with a "video" field.')
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > cfg.maxUploadBytes + 1024 * 1024) return jsonError(`Videos must be smaller than ${cfg.maxUploadMb} MB.`, 413)

  const id = randomUUID()
  const fields: Record<string, string> = {}
  let savedName = ''
  let originalName = ''
  let tooLarge = false
  let badType = false
  let writing: Promise<void> | null = null

  try {
    await new Promise<void>((resolve, reject) => {
      const parser = busboy({ headers: Object.fromEntries(request.headers), limits: { files: 1, fileSize: cfg.maxUploadBytes, fields: 20 } })
      parser.on('field', (name, value) => {
        fields[name] = value
      })
      parser.on('file', (name, stream, info) => {
        const ext = path.extname(info.filename || '').toLowerCase()
        if (name !== 'video' || (!EXT_RE.test(ext) && !info.mimeType.startsWith('video/'))) {
          badType = true
          stream.resume()
          return
        }
        originalName = path.basename(info.filename || 'video')
        savedName = `source${EXT_RE.test(ext) ? ext : '.mp4'}`
        let dir: string
        try {
          dir = allocateProject(id, originalName).dir
        } catch (error) {
          stream.resume()
          reject(error)
          return
        }
        const out = fs.createWriteStream(path.join(dir, savedName))
        stream.on('limit', () => {
          tooLarge = true
          out.destroy()
        })
        writing = new Promise<void>((res, rej) => {
          out.on('close', res)
          out.on('error', rej)
        })
        stream.pipe(out)
      })
      parser.on('error', reject)
      parser.on('close', resolve)
      Readable.fromWeb(request.body as never).on('error', reject).pipe(parser)
    })
    if (writing) await writing
    if (tooLarge) throw Object.assign(new Error(`Videos must be smaller than ${cfg.maxUploadMb} MB.`), { status: 413 })
    if (badType || !savedName) throw new Error('Upload a video file (MP4, MOV, WebM, MKV…) in the "video" field.')
    const options = parseOptions(fields.clip_length, fields.subtitle_style, fields)
    const job = newJob(options, { type: 'upload', file: savedName }, originalName, id)
    enqueue(job.id)
    return NextResponse.json(toPublic(job), { status: 202 })
  } catch (error) {
    removeJobFiles(id)
    const status = (error as { status?: number }).status ?? 400
    return jsonError(error instanceof Error ? error.message : 'Upload failed.', status)
  }
}
