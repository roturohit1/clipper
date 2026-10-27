// Watermark, trim / crop and music options. Shared by the UI (client) and the pipeline (server): no Node imports here.
import type { CropEdges } from './aspect'

// ---------- watermark (your own logo / page name only) ----------
export const WATERMARK_POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number]

export type WatermarkOptions = {
  /** overlay the saved logo (data/branding) */
  logo: boolean
  /** overlay this text (for example your page name) */
  text: string
  position: WatermarkPosition
  /** logo width as % of the frame width (text size scales with it) */
  sizePct: number
  /** 10..100 */
  opacity: number
  /** distance from the frame edge, % of the frame width */
  marginPct: number
}

export const DEFAULT_WATERMARK: WatermarkOptions = { logo: false, text: '', position: 'top-right', sizePct: 18, opacity: 85, marginPct: 3 }
export const WATERMARK_POSITION_LABELS: Record<WatermarkPosition, string> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right',
}

// ---------- trim ----------
export type TrimOptions = {
  /** seconds skipped at the start of the source */
  start: number
  /** where the source ends for clipping, in seconds; 0 = the end of the video */
  end: number
}

// ---------- audio ----------
export const AUDIO_MODES = ['original', 'replace', 'mix'] as const
export type AudioMode = (typeof AUDIO_MODES)[number]
export type AudioOptions = { mode: AudioMode; musicId?: string; /** 0..100 */ volumePct: number }
export const DEFAULT_MUSIC_VOLUME = 60
export const MUSIC_ID_RE = /^[a-f0-9]{16}$/
export const MUSIC_FADE_SECONDS = 1.5

export type MusicTrack = { id: string; name: string; sizeBytes: number; durationSeconds: number; url: string }
export type BrandingInfo = { logo: null | { name: string; width: number; height: number; url: string } }

// ---------- parsing (API fields are snake_case strings) ----------
const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === ''

function num(value: unknown, fallback: number, min: number, max: number, name: string) {
  if (blank(value)) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`)
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}.`)
  return n
}

const flag = (value: unknown, fallback: boolean) => (blank(value) ? fallback : ['true', '1', 'on', 'yes'].includes(String(value).trim().toLowerCase()))

export function parseWatermark(input: Record<string, unknown>): WatermarkOptions | undefined {
  const logo = flag(input.watermark_logo, false)
  const text = blank(input.watermark_text) ? '' : String(input.watermark_text).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 60)
  if (!logo && !text) return undefined
  const position = blank(input.watermark_position) ? DEFAULT_WATERMARK.position : String(input.watermark_position).trim().toLowerCase()
  if (!(WATERMARK_POSITIONS as readonly string[]).includes(position)) throw new Error('watermark_position must be one of ' + WATERMARK_POSITIONS.join(', ') + '.')
  return {
    logo,
    text,
    position: position as WatermarkPosition,
    sizePct: num(input.watermark_size, DEFAULT_WATERMARK.sizePct, 5, 60, 'watermark_size'),
    opacity: num(input.watermark_opacity, DEFAULT_WATERMARK.opacity, 10, 100, 'watermark_opacity'),
    marginPct: num(input.watermark_margin, DEFAULT_WATERMARK.marginPct, 0, 15, 'watermark_margin'),
  }
}

export function parseTrim(input: Record<string, unknown>): TrimOptions | undefined {
  const start = num(input.trim_start, 0, 0, 86400, 'trim_start')
  const end = num(input.trim_end, 0, 0, 86400, 'trim_end')
  if (end > 0 && end < start + 3) throw new Error('trim_end must be at least 3 seconds after trim_start (or 0 for the end of the video).')
  return start > 0 || end > 0 ? { start, end } : undefined
}

export function parseCropEdges(input: Record<string, unknown>): CropEdges | undefined {
  const crop = {
    top: num(input.crop_top, 0, 0, 45, 'crop_top'),
    bottom: num(input.crop_bottom, 0, 0, 45, 'crop_bottom'),
    left: num(input.crop_left, 0, 0, 45, 'crop_left'),
    right: num(input.crop_right, 0, 0, 45, 'crop_right'),
  }
  if (crop.top + crop.bottom > 80 || crop.left + crop.right > 80) throw new Error('Cropping opposite edges must leave at least 20% of the picture.')
  return crop.top || crop.bottom || crop.left || crop.right ? crop : undefined
}

/** Music id existence is checked on the server; this only validates the shape. */
export function parseAudio(input: Record<string, unknown>): AudioOptions {
  const mode = blank(input.audio_mode) ? 'original' : String(input.audio_mode).trim().toLowerCase()
  if (!(AUDIO_MODES as readonly string[]).includes(mode)) throw new Error('audio_mode must be original, replace, or mix.')
  const volumePct = num(input.music_volume, DEFAULT_MUSIC_VOLUME, 0, 100, 'music_volume')
  if (mode === 'original') return { mode: 'original', volumePct }
  const musicId = blank(input.music_id) ? '' : String(input.music_id).trim().toLowerCase()
  if (!MUSIC_ID_RE.test(musicId)) throw new Error('Choose a music track for audio_mode ' + mode + ' (music_id).')
  return { mode: mode as AudioMode, musicId, volumePct }
}

// ---------- watermark layout ----------
export type WatermarkLayout = {
  marginPx: number
  logoWidth: number
  logoHeight: number
  fontSize: number
  textHeight: number
  /** distance from the frame's top/bottom edge to the far side of the watermark, for keeping captions clear of it */
  occupiedPx: number
  edge: 'top' | 'bottom'
}

/** logoAspect = logo height / width. */
export function watermarkLayout(wm: WatermarkOptions, frameWidth: number, hasLogo: boolean, logoAspect: number): WatermarkLayout {
  const marginPx = Math.round((frameWidth * wm.marginPct) / 100)
  const logoWidth = hasLogo ? Math.max(16, Math.round((frameWidth * wm.sizePct) / 100)) : 0
  const logoHeight = hasLogo ? Math.round(logoWidth * logoAspect) : 0
  const fontSize = wm.text ? Math.max(12, Math.round((frameWidth * wm.sizePct) / 100 * 0.25)) : 0
  const textHeight = wm.text ? Math.round(fontSize * 1.35) : 0
  const gap = hasLogo && wm.text ? Math.round(marginPx / 2) + 4 : 0
  return {
    marginPx,
    logoWidth,
    logoHeight,
    fontSize,
    textHeight,
    occupiedPx: marginPx + logoHeight + gap + textHeight,
    edge: wm.position.startsWith('top') ? 'top' : 'bottom',
  }
}

/** ffmpeg overlay x / y expressions for the logo (W, H = frame, w, h = logo). */
export function logoOverlayPosition(position: WatermarkPosition, marginPx: number) {
  const x = position.endsWith('left') ? `${marginPx}` : position.endsWith('right') ? `W-w-${marginPx}` : '(W-w)/2'
  const y = position.startsWith('top') ? `${marginPx}` : `H-h-${marginPx}`
  return { x, y }
}

const ASS_ALIGN: Record<WatermarkPosition, number> = { 'top-left': 7, 'top-center': 8, 'top-right': 9, 'bottom-left': 1, 'bottom-center': 2, 'bottom-right': 3 }

/** ASS file with only the text watermark, authored at the output frame size (PlayRes = output size). */
export function buildWatermarkAss(wm: WatermarkOptions, layout: WatermarkLayout, width: number, height: number): string {
  const alpha = Math.round(((100 - wm.opacity) / 100) * 255).toString(16).padStart(2, '0').toUpperCase()
  const gap = layout.logoHeight ? layout.logoHeight + Math.round(layout.marginPx / 2) + 4 : 0
  const marginV = layout.marginPx + gap
  const text = wm.text.replace(/\\/g, '/').replace(/[{}]/g, '').replace(/\r?\n/g, ' ')
  const outline = Math.max(1, Math.round(layout.fontSize / 14))
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: WM,Arial,${layout.fontSize},&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H${alpha}000000,&HFF000000,-1,0,0,0,100,100,0,0,1,${outline},0,${ASS_ALIGN[wm.position]},${layout.marginPx},${layout.marginPx},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    `Dialogue: 1,0:00:00.00,9:59:59.00,WM,,0,0,0,,${text}`,
    '',
  ].join('\n')
}

// ---------- audio graph ----------
/**
 * ffmpeg audio graph ending in [a]. `music` is the input index of the (looped) music file; the source audio is [0:a].
 * replace = music only; mix = voice kept, music ducked under it with sidechaincompress.
 */
export function audioFilterGraph(o: { mode: AudioMode; music: number; hasVoice: boolean; volumePct: number; duration: number }): string | null {
  if (o.mode === 'original') return null
  const d = Math.max(1, o.duration)
  const fade = Math.min(MUSIC_FADE_SECONDS, d / 4)
  const volume = (o.volumePct / 100).toFixed(3)
  const music = `[${o.music}:a]atrim=duration=${d.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume},afade=t=in:st=0:d=${fade.toFixed(2)},afade=t=out:st=${(d - fade).toFixed(3)}:d=${fade.toFixed(2)},aformat=sample_rates=48000:channel_layouts=stereo`
  if (o.mode === 'replace' || !o.hasVoice) return `${music}[a]`
  return [
    '[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[vo][sc]',
    `${music}[mu]`,
    '[mu][sc]sidechaincompress=threshold=0.04:ratio=10:attack=20:release=350:makeup=1[duck]',
    '[vo][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[a]',
  ].join(';')
}
