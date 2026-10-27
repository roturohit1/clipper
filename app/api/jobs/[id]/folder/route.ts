import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { jsonError } from '@/lib/server/http'
import { jobDir, loadJob } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Open this project's clip folder in the system file browser. The path always comes from the job, never the request. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = loadJob(id)
  if (!job) return jsonError('Project not found.', 404)
  const dir = path.join(jobDir(id), 'clips')
  fs.mkdirSync(dir, { recursive: true })
  const folder = job.folder ? `projects/${job.folder}/clips` : `jobs/${job.id}/clips`
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not open the project folder.')
  }
  return Response.json({ ok: true, folder }, { headers: { 'Cache-Control': 'no-store' } })
}
