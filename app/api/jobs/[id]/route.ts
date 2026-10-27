import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/server/http'
import { cancelJob } from '@/lib/server/pipeline'
import { deleteProject, loadJob, toPublic } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = loadJob(id)
  if (!job) return jsonError('Job not found.', 404)
  return NextResponse.json(toPublic(job), { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = loadJob(id)
  if (!job) return jsonError('Project not found.', 404)
  try {
    await cancelJob(id) // stop ffmpeg / yt-dlp first so they release the files
    deleteProject(id)
  } catch (error) {
    return jsonError(error instanceof Error ? `Could not delete the project: ${error.message}` : 'Could not delete the project.', 500)
  }
  return Response.json({ ok: true, id }, { headers: { 'Cache-Control': 'no-store' } })
}
