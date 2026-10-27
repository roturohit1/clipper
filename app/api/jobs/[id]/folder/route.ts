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
  // On a headless Linux server (no desktop) there is nothing to open; skip quietly instead of crashing on a missing xdg-open.
  const hasDesktop = process.platform === 'win32' || process.platform === 'darwin' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  let opened = false
  if (hasDesktop) {
    try {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
      const child = spawn(command, [dir], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {}) // a missing launcher emits 'error' asynchronously and would otherwise crash the server
      child.unref()
      opened = true
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : 'Could not open the project folder.')
    }
  }
  return Response.json({ ok: true, opened, folder }, { headers: { 'Cache-Control': 'no-store' } })
}
