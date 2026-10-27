import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/server/http'
import { cancelJob } from '@/lib/server/pipeline'
import { deleteProject, listJobs, toPublic } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(listJobs().map(toPublic), { headers: { 'Cache-Control': 'no-store' } })
}

/** Delete every project and all of its videos. */
export async function DELETE() {
  let count = 0
  try {
    for (const job of listJobs(100000)) {
      await cancelJob(job.id)
      deleteProject(job.id)
      count++
    }
  } catch (error) {
    return jsonError(error instanceof Error ? `Could not delete all projects: ${error.message}` : 'Could not delete all projects.', 500)
  }
  return Response.json({ ok: true, deleted: count }, { headers: { 'Cache-Control': 'no-store' } })
}
