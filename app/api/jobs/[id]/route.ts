import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/server/http'
import { loadJob, toPublic } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = loadJob(id)
  if (!job) return jsonError('Job not found.', 404)
  return NextResponse.json(toPublic(job), { headers: { 'Cache-Control': 'no-store' } })
}
