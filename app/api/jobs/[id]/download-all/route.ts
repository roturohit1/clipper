import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { jsonError } from '@/lib/server/http'
import { jobDir, loadJob, orderedClips, safeDownloadName } from '@/lib/server/store'
import { zipSize, zipStore, type ZipEntry } from '@/lib/server/zip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Streams a zip of all rendered clips named 1.mp4, 2.mp4, ... in clip order. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = loadJob(id)
  if (!job) return jsonError('Project not found.', 404)
  const dir = path.resolve(jobDir(id))
  const entries: ZipEntry[] = []
  orderedClips(job).forEach((clip, index) => {
    const file = path.resolve(dir, clip.file)
    const rel = path.relative(dir, file)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) entries.push({ name: `${index + 1}.mp4`, file, size: stat.size, mtime: stat.mtime })
    } catch {
      // A clip whose file is gone is skipped.
    }
  })
  if (!entries.length) return jsonError('This project has no videos to download yet.', 404)

  const base = safeDownloadName(job.projectName || job.sourceName || '', 'project')
  const stream = Readable.from(zipStore(entries))
  request.signal.addEventListener('abort', () => stream.destroy())
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(zipSize(entries)),
      'Content-Disposition': `attachment; filename="${base}-clips.zip"`,
      'Cache-Control': 'no-store',
    },
  })
}
