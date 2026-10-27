// Output frame shape for rendered clips. Shared by the UI (client) and the pipeline (server): no Node imports here.

export const ASPECTS = ['9:16', '1:1', '4:5', '16:9', 'original'] as const
export type Aspect = (typeof ASPECTS)[number]
/** crop = centre crop to fill the frame; blur = whole picture over a blurred, zoomed copy of itself. */
export const ASPECT_FITS = ['crop', 'blur'] as const
export type AspectFit = (typeof ASPECT_FITS)[number]

/** 9:16 (Reels / Shorts / TikTok / Facebook full screen) unless the caller asks otherwise. */
export const DEFAULT_ASPECT: Aspect = '9:16'
export const DEFAULT_ASPECT_FIT: AspectFit = 'crop'

export const ASPECT_LABELS: Record<Aspect, string> = {
  '9:16': '9:16 Reels / Shorts (1080x1920)',
  '1:1': '1:1 Square (1080x1080)',
  '4:5': '4:5 Portrait feed (1080x1350)',
  '16:9': '16:9 Landscape (1920x1080)',
  original: 'Original (keep source size)',
}

export function parseAspect(value: unknown): Aspect {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_ASPECT
  const v = String(value).trim().toLowerCase().replace(/x/, ':')
  if ((ASPECTS as readonly string[]).includes(v)) return v as Aspect
  throw new Error('aspect must be 9:16, 1:1, 4:5, 16:9, or original.')
}

export function parseAspectFit(value: unknown): AspectFit {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_ASPECT_FIT
  const v = String(value).trim().toLowerCase()
  if ((ASPECT_FITS as readonly string[]).includes(v)) return v as AspectFit
  throw new Error('aspect_fit must be crop or blur.')
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Exact output pixel size. 'original' keeps the (rotation-corrected) source size, rounded to even numbers for H.264. */
export function outputSize(aspect: Aspect, sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  switch (aspect) {
    case '9:16':
      return { width: 1080, height: 1920 }
    case '1:1':
      return { width: 1080, height: 1080 }
    case '4:5':
      return { width: 1080, height: 1350 }
    case '16:9':
      return { width: 1920, height: 1080 }
    default:
      return { width: even(sourceWidth), height: even(sourceHeight) }
  }
}

/** Percent of the source picture removed from each edge before the output fit. */
export type CropEdges = { top: number; bottom: number; left: number; right: number }

const evenDown = (n: number) => Math.max(2, Math.floor(n / 2) * 2)

/** Picture size after cropping (same arithmetic as the ffmpeg crop filter below). */
export function croppedSize(width: number, height: number, crop?: CropEdges) {
  if (!crop) return { width, height }
  return {
    width: evenDown((width * (1 - (crop.left + crop.right) / 100))),
    height: evenDown((height * (1 - (crop.top + crop.bottom) / 100))),
  }
}

function cropFilter(crop?: CropEdges) {
  if (!crop) return ''
  const { top: T, bottom: B, left: L, right: R } = crop
  return `crop=w=trunc(iw*(1-(${L}+${R})/100)/2)*2:h=trunc(ih*(1-(${T}+${B})/100)/2)*2:x=trunc(iw*${L}/100/2)*2:y=trunc(ih*${T}/100/2)*2`
}

/**
 * ffmpeg -filter_complex graph that ends in the labelled output [v]: square pixels (SAR 1:1), the manual edge crop,
 * exactly the output size and no black bars, then the logo overlay (input `logo.input`), an optional fps cap, burned ASS
 * text watermark and captions (drawn at the output size, so they match PlayResX/Y), and yuv420p.
 */
export function videoFilterGraph(o: {
  aspect: Aspect
  fit: AspectFit
  width: number
  height: number
  capFps: boolean
  ass?: string | null
  crop?: CropEdges
  /** logo overlay: ffmpeg input index, target width in px, opacity 0..1, overlay x / y expressions */
  logo?: { input: number; width: number; opacity: number; x: string; y: string }
  /** ASS file holding only the text watermark */
  watermarkAss?: string | null
}): string {
  const { width: W, height: H } = o
  // bake a non-square source pixel aspect into the picture first, and make the dimensions even
  const pre = ['scale=trunc(iw*sar/2)*2:trunc(ih/2)*2', 'setsar=1', cropFilter(o.crop)].filter(Boolean).join(',')
  const tail = [o.capFps ? 'fps=30' : null, 'setsar=1', o.watermarkAss ? `ass=${o.watermarkAss}` : null, o.ass ? `ass=${o.ass}` : null, 'format=yuv420p'].filter(Boolean).join(',')
  const parts: string[] = []
  if (o.aspect === 'original') {
    parts.push(`[0:v]${pre}[s]`)
  } else if (o.fit === 'blur') {
    // the background is built small, blurred, then scaled up: cheap and very smooth
    const sw = Math.round(W / 4)
    const sh = Math.round(H / 4)
    parts.push(
      `[0:v]${pre},split[a][b]`,
      `[a]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},boxblur=10:2,scale=${W}:${H}[bg]`,
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[s]`,
    )
  } else {
    parts.push(`[0:v]${pre},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[s]`)
  }
  if (o.logo) {
    parts.push(
      `[${o.logo.input}:v]format=rgba,scale=${o.logo.width}:-2,colorchannelmixer=aa=${o.logo.opacity.toFixed(3)}[wm]`,
      `[s][wm]overlay=x=${o.logo.x}:y=${o.logo.y}[s2]`,
    )
    parts.push(`[s2]${tail}[v]`)
  } else {
    parts.push(`[s]${tail}[v]`)
  }
  return parts.join(';')
}
