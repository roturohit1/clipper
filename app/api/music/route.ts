import { jsonError } from '@/lib/server/http'
import { listMusic, saveMusic } from '@/lib/server/assets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store' }

export function GET() {
  return Response.json(listMusic(), { headers })
}

/** Upload a track you are licensed to use: multipart field "track", MP3 or WAV. */
export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const file = form.get('track')
    if (!(file instanceof File)) return jsonError('Choose an MP3 or WAV file to upload (field "track").', 400)
    const track = await saveMusic(Buffer.from(await file.arrayBuffer()), file.name)
    return Response.json(track, { status: 201, headers })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not save the track.', 400)
  }
}
