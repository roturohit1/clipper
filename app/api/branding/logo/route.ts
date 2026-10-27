import fs from 'node:fs'
import { jsonError } from '@/lib/server/http'
import { logoPath } from '@/lib/server/assets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  const file = logoPath()
  if (!file) return jsonError('No logo uploaded.', 404)
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' } })
}
