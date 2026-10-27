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

/**
 * ffmpeg -filter_complex graph that ends in the labelled output [v]: square pixels (SAR 1:1), exactly the output size,
 * no black bars, optional fps cap, burned ASS captions (drawn at the output size, so they match PlayResX/Y), yuv420p.
 */
export function videoFilterGraph(o: { aspect: Aspect; fit: AspectFit; width: number; height: number; capFps: boolean; ass?: string | null }): string {
  const { width: W, height: H } = o
  // bake a non-square source pixel aspect into the picture first, and make the dimensions even
  const normalize = 'scale=trunc(iw*sar/2)*2:trunc(ih/2)*2,setsar=1'
  const tail = [o.capFps ? 'fps=30' : null, 'setsar=1', o.ass ? `ass=${o.ass}` : null, 'format=yuv420p'].filter(Boolean).join(',')
  if (o.aspect === 'original') return `[0:v]${normalize},${tail}[v]`
  if (o.fit === 'blur') {
    // the background is built small, blurred, then scaled up: cheap and very smooth
    const sw = Math.round(W / 4)
    const sh = Math.round(H / 4)
    return [
      `[0:v]${normalize},split[a][b]`,
      `[a]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},boxblur=10:2,scale=${W}:${H}[bg]`,
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,${tail}[v]`,
    ].join(';')
  }
  return `[0:v]${normalize},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},${tail}[v]`
}
