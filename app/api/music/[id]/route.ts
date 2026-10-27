import fs from 'node:fs'
import { jsonError } from '@/lib/server/http'
import { musicPath, removeMusic } from '@/lib/server/assets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Streams a track (for the preview player in the UI). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const file = musicPath(id)
  if (!file) return jsonError('Track not found.', 404)
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { 'Content-Type': file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' } })
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  try {
    if (!removeMusic(id)) return jsonError('Track not found.', 404)
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not delete the track.', 500)
  }
  return Response.json({ ok: true, id }, { headers: { 'Cache-Control': 'no-store' } })
}
