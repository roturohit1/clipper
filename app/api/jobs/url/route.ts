import { NextResponse } from 'next/server'
import { assertPublicUrl } from '@/lib/server/ingest'
import { enqueue, jsonError, newJob, parseOptions } from '@/lib/server/http'
import { toPublic } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: string; clip_length?: unknown; subtitle_style?: unknown } | null
  if (!body?.url || typeof body.url !== 'string') return jsonError('A video URL is required.')
  try {
    const options = parseOptions(body.clip_length, body.subtitle_style)
    const url = await assertPublicUrl(body.url.trim())
    const job = newJob(options, { type: 'url', url: url.toString() }, url.hostname + url.pathname)
    enqueue(job.id)
    return NextResponse.json(toPublic(job), { status: 202 })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Invalid request.')
  }
}
