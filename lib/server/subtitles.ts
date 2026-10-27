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
const clean = (text: string) => text.replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim()

/** Words that fall inside [start, end]; segments without word timing are spread evenly by character length. */
function wordsInRange(segments: Segment[], start: number, end: number): Word[] {
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
    for (const w of words) if (w.start >= start - 0.05 && w.end <= end + 0.25) out.push({ ...w, word: clean(w.word) })
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

function buildCues(words: Word[]): Cue[] {
  const cues: Cue[] = []
  let current: Word[] = []
  const flush = () => {
    if (current.length) cues.push({ start: current[0].start, end: current[current.length - 1].end, words: current })
    current = []
  }
  for (const w of words) {
    const last = current[current.length - 1]
    if (last && (w.start - last.end > 0.8 || current.length >= 7 || w.end - current[0].start > 3.4)) flush()
    current.push(w)
    if (current.length >= 3 && /[.!?]$/.test(w.word)) flush()
  }
  flush()
  return cues
}

/** Build an ASS subtitle file for one clip. Returns null if there is no speech in range. */
export function buildAss(segments: Segment[], clipStart: number, clipEnd: number, style: SubtitleStyle, width: number, height: number): string | null {
  const words = wordsInRange(segments, clipStart, clipEnd).map((w) => ({ ...w, start: w.start - clipStart, end: Math.min(w.end, clipEnd) - clipStart }))
  const cues = buildCues(words)
  if (!cues.length) return null

  const base = Math.round(Math.min(width, height * 1.6) * (style === 'bold' ? 0.055 : 0.042))
  const styles: Record<SubtitleStyle, string> = {
    // &HAABBGGRR
    bold: `Style: Default,Arial,${base},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(base / 9))},0,2,40,40,${Math.round(height * 0.08)},1`,
    clean: `Style: Default,Arial,${base},&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,0,0,0,0,100,100,0,0,3,${Math.max(2, Math.round(base / 14))},0,2,40,40,${Math.round(height * 0.06)},1`,
    karaoke: `Style: Default,Arial,${base},&H0000E5FF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(base / 10))},0,2,40,40,${Math.round(height * 0.08)},1`,
  }

  const lines = cues.map((cue, i) => {
    const next = cues[i + 1]
    const end = Math.max(cue.end, cue.start + 0.4)
    const stop = next ? Math.min(end + 0.25, next.start) : end + 0.25
    let text: string
    if (style === 'karaoke') {
      text = cue.words
        .map((w, k) => {
          const nextStart = cue.words[k + 1]?.start ?? w.end
          return `{\\kf${Math.max(1, cs(nextStart - w.start))}}${w.word}`
        })
        .join(' ')
    } else {
      text = cue.words.map((w) => w.word).join(' ')
      if (style === 'bold') text = text.toUpperCase()
    }
    return `Dialogue: 0,${stamp(cue.start)},${stamp(Math.max(stop, cue.start + 0.4))},Default,,0,0,0,,${text}`
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
