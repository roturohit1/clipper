import { jsonError } from '@/lib/server/http'
import { brandingInfo, removeLogo, saveLogo } from '@/lib/server/assets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'no-store' }

export function GET() {
  return Response.json(brandingInfo(), { headers })
}

/** Upload (replace) the reusable logo: multipart field "logo", PNG only. */
export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const file = form.get('logo')
    if (!(file instanceof File)) return jsonError('Choose a PNG logo to upload (field "logo").', 400)
    saveLogo(Buffer.from(await file.arrayBuffer()), file.name)
    return Response.json(brandingInfo(), { headers })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not save the logo.', 400)
  }
}

export function DELETE() {
  removeLogo()
  return Response.json(brandingInfo(), { headers })
}
