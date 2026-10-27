// Caption options shared by the UI (client) and the render pipeline (server). Keep this file free of Node imports.

export const CAPTION_SIZES = ['small', 'medium', 'large', 'xl'] as const
export const CAPTION_POSITIONS = ['top', 'middle', 'bottom'] as const
export type CaptionSize = (typeof CAPTION_SIZES)[number]
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number]

/** Named colour presets accepted by the API (any other value must be a #RGB / #RRGGBB hex code). */
export const COLOR_PRESETS = {
  white: '#FFFFFF',
  yellow: '#FFE500',
  green: '#39FF14',
  cyan: '#00E5FF',
  pink: '#FF4FD8',
} as const

/** Font size multiplier relative to the original (medium = unchanged) size. */
export const SIZE_SCALE: Record<CaptionSize, number> = { small: 0.8, medium: 1, large: 1.3, xl: 1.6 }

export type CaptionOptions = {
  /** Burn captions into the clip. */
  enabled: boolean
  /** 'auto' keeps each style's own behaviour (Bold is uppercase, the others are not). */
  uppercase: 'auto' | boolean
  /** #RRGGBB, or null to keep the style's own colour. */
  textColor: string | null
  /** #RRGGBB, or null to keep the style's own behaviour (Karaoke = yellow, others = no highlight). */
  highlightColor: string | null
  size: CaptionSize
  position: CaptionPosition
  /** Add relevant emojis to caption lines (LLM, with a keyword-map fallback). */
  emoji: boolean
}

/** Defaults reproduce the behaviour from before these options existed. */
export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = {
  enabled: true,
  uppercase: 'auto',
  textColor: null,
  highlightColor: null,
  size: 'medium',
  position: 'bottom',
  emoji: false,
}

const present = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== ''

function parseBool(value: unknown, fallback: boolean, name: string): boolean {
  if (!present(value)) return fallback
  const v = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  throw new Error(`${name} must be true or false.`)
}

export function parseColor(value: unknown, name: string): string | null {
  if (!present(value)) return null
  const v = String(value).trim().toLowerCase()
  if (v === 'default' || v === 'auto' || v === 'none') return null
  if (v in COLOR_PRESETS) return COLOR_PRESETS[v as keyof typeof COLOR_PRESETS]
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)
  if (!m) throw new Error(`${name} must be white, yellow, green, cyan, pink, or a hex colour like #FF8800.`)
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
  return `#${hex.toUpperCase()}`
}

/** Validate raw API input (multipart fields or JSON body); missing values fall back to the defaults. */
export function parseCaptionOptions(input: Record<string, unknown>): CaptionOptions {
  const d = DEFAULT_CAPTION_OPTIONS
  const size = present(input.caption_size) ? String(input.caption_size).trim().toLowerCase() : d.size
  if (!(CAPTION_SIZES as readonly string[]).includes(size)) throw new Error('caption_size must be small, medium, large, or xl.')
  const position = present(input.caption_position) ? String(input.caption_position).trim().toLowerCase() : d.position
  if (!(CAPTION_POSITIONS as readonly string[]).includes(position)) throw new Error('caption_position must be top, middle, or bottom.')
  const upperRaw = present(input.caption_uppercase) ? String(input.caption_uppercase).trim().toLowerCase() : 'auto'
  return {
    enabled: parseBool(input.captions, d.enabled, 'captions'),
    uppercase: upperRaw === 'auto' ? 'auto' : parseBool(upperRaw, false, 'caption_uppercase'),
    textColor: parseColor(input.caption_text_color, 'caption_text_color'),
    highlightColor: parseColor(input.caption_highlight_color, 'caption_highlight_color'),
    size: size as CaptionSize,
    position: position as CaptionPosition,
    emoji: parseBool(input.caption_emoji, d.emoji, 'caption_emoji'),
  }
}
