import { DEFAULT_CAPTION_OPTIONS, SIZE_SCALE, type CaptionOptions } from '../captions'
import type { Segment, Word } from './transcribe'

export type SubtitleStyle = 'bold' | 'clean' | 'karaoke'

const cs = (t: number) => Math.max(0, Math.round(t * 100))
function stamp(t: number) {
  const total = cs(t)
  const h = Math.floor(total / 360000)
  const m = Math.floor((total % 360000) / 6000)
  const s = Math.floor((total % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(total % 100).padStart(2, '0')}`
}
const EMOJI_FONT = process.platform === 'win32' ? 'Segoe UI Symbol' : 'Symbola'
const clean = (text: string) => text.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim()

/** Words that fall inside [start, end]; segments without word timing are spread evenly by character length. */
function wordsInRange(segments: Segment[], start: number, end: number, strict = false): Word[] {
  const out: Word[] = []
  for (const seg of segments) {
    if (seg.end <= start || seg.start >= end) continue
    let words = seg.words
    if (!words?.length) {
      const tokens = seg.text.split(/\s+/).filter(Boolean)
      const total = tokens.reduce((n, t) => n + t.length + 1, 0) || 1
      let cursor = seg.start
      words = tokens.map((token) => {
        const dur = ((token.length + 1) / total) * (seg.end - seg.start)
        const w = { start: cursor, end: cursor + dur, word: token }
        cursor += dur
        return w
      })
    }
    for (const w of words) {
      // strict (contiguous clips): a word belongs to exactly one clip, the one containing its midpoint, so nothing is dropped or doubled at a boundary
      const inside = strict ? (w.start + w.end) / 2 >= start && (w.start + w.end) / 2 < end : w.start >= start - 0.05 && w.end <= end + 0.25
      if (inside) out.push({ ...w, word: clean(w.word) })
    }
  }
  // Whisper sometimes emits punctuation-led tokens (",000", "'s", "%"): glue them to the previous word.
  const merged: Word[] = []
  for (const w of out) {
    const prev = merged[merged.length - 1]
    if (prev && /^[,.;:!?'’%)]/.test(w.word)) {
      prev.word += w.word
      prev.end = w.end
    } else merged.push({ ...w })
  }
  return merged.filter((w) => w.word)
}

type Cue = { start: number; end: number; words: Word[] }

function buildCues(words: Word[], maxWords = 7): Cue[] {
  const cues: Cue[] = []
  let current: Word[] = []
  const flush = () => {
    if (current.length) cues.push({ start: current[0].start, end: current[current.length - 1].end, words: current })
    current = []
  }
  for (const w of words) {
    const last = current[current.length - 1]
    if (last && (w.start - last.end > 0.8 || current.length >= maxWords || w.end - current[0].start > 3.4)) flush()
    current.push(w)
    if (current.length >= 3 && /[.!?]$/.test(w.word)) flush()
  }
  flush()
  return cues
}

/** Larger text needs fewer words per caption line so it still fits on screen. Medium and below keep the original 7. */
const maxWordsFor = (caption: CaptionOptions) => (caption.size === 'xl' ? 4 : caption.size === 'large' ? 5 : 7)

function clipCues(segments: Segment[], clipStart: number, clipEnd: number, caption: CaptionOptions, strict = false): Cue[] {
  const words = wordsInRange(segments, clipStart, clipEnd, strict).map((w) => ({ ...w, start: strict ? Math.max(0, w.start - clipStart) : w.start - clipStart, end: Math.min(w.end, clipEnd) - clipStart }))
  return buildCues(words, maxWordsFor(caption))
}

/** The plain text of every caption line of a clip (same order as buildAss), e.g. to ask an LLM for emojis. */
export function captionLines(segments: Segment[], clipStart: number, clipEnd: number, caption: CaptionOptions = DEFAULT_CAPTION_OPTIONS, strict = false): string[] {
  return clipCues(segments, clipStart, clipEnd, caption, strict).map((cue) => cue.words.map((w) => w.word).join(' '))
}

/** #RRGGBB -> ASS &HAABBGGRR */
const ass = (hex: string, alpha = '00') => `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`

/**
 * Build an ASS subtitle file for one clip. Returns null if there is no speech in range.
 * `emojis` holds one emoji string per caption line (see captionLines); the defaults reproduce the original output.
 */
export function buildAss(
  segments: Segment[],
  clipStart: number,
  clipEnd: number,
  style: SubtitleStyle,
  width: number,
  height: number,
  caption: CaptionOptions = DEFAULT_CAPTION_OPTIONS,
  emojis: string[] = [],
  strict = false,
): string | null {
  const cues = clipCues(segments, clipStart, clipEnd, caption, strict)
  if (!cues.length) return null

  const base = Math.round(Math.min(width, height * 1.6) * (style === 'bold' ? 0.055 : 0.042) * SIZE_SCALE[caption.size])
  const upper = caption.uppercase === 'auto' ? style === 'bold' : caption.uppercase
  // karaoke fills words with the highlight colour (default yellow); other styles only highlight when a highlight colour is chosen.
  const highlight = caption.highlightColor ?? (style === 'karaoke' ? '#FFE500' : null)
  const text = caption.textColor ?? '#FFFFFF'
  const progressive = style === 'karaoke' || Boolean(highlight)
  const primary = progressive && highlight ? ass(highlight) : ass(text)
  const secondary = ass(text)
  // 2 = bottom centre, 5 = middle centre, 8 = top centre
  const alignment = caption.position === 'top' ? 8 : caption.position === 'middle' ? 5 : 2
  const margin = (ratio: number) => (caption.position === 'middle' ? 0 : Math.round(height * ratio))
  const styles: Record<SubtitleStyle, string> = {
    // &HAABBGGRR
    bold: `Style: Default,Arial,${base},${primary},${secondary},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(base / 9))},0,${alignment},40,40,${margin(0.08)},1`,
    clean: `Style: Default,Arial,${base},${primary},${secondary},&H00000000,&H99000000,0,0,0,0,100,100,0,0,3,${Math.max(2, Math.round(base / 14))},0,${alignment},40,40,${margin(0.06)},1`,
    karaoke: `Style: Default,Arial,${base},${primary},${secondary},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(base / 10))},0,${alignment},40,40,${margin(0.08)},1`,
  }

  const lines = cues.map((cue, i) => {
    const next = cues[i + 1]
    const end = Math.max(cue.end, cue.start + 0.4)
    const stop = next ? Math.min(end + 0.25, next.start) : end + 0.25
    let line: string
    if (progressive) {
      // \kf sweeps across the word (karaoke); \k switches colour as the word starts (highlight on other styles)
      const tag = style === 'karaoke' ? 'kf' : 'k'
      line = cue.words
        .map((w, k) => {
          const nextStart = cue.words[k + 1]?.start ?? w.end
          return `{\\${tag}${Math.max(1, cs(nextStart - w.start))}}${upper ? w.word.toUpperCase() : w.word}`
        })
        .join(' ')
    } else {
      line = cue.words.map((w) => w.word).join(' ')
      if (upper) line = line.toUpperCase()
    }
    const emoji = caption.emoji ? (emojis[i] ?? '').trim() : ''
    // Arial has no emoji glyphs; Segoe UI Symbol (Windows) or Symbola (Linux, package fonts-symbola) does. libass cannot draw colour emoji fonts.
    if (emoji) line += ` {\\r}{\\fn${EMOJI_FONT}}${emoji}`
    return `Dialogue: 0,${stamp(cue.start)},${stamp(Math.max(stop, cue.start + 0.4))},Default,,0,0,0,,${line}`
  })

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    styles[style],
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...lines,
    '',
  ].join('\n')
}
