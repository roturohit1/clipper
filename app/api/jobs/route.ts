import { NextResponse } from 'next/server'
import { listJobs, toPublic } from '@/lib/server/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json(listJobs().map(toPublic), { headers: { 'Cache-Control': 'no-store' } })
}
