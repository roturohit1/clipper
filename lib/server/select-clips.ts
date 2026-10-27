import { MAX_SEQUENTIAL_CLIPS } from '../clip-mode'
import { getConfig } from './config'
import { loudnessPerSecond } from './media'
import type { Segment, Transcript } from './transcribe'
import { fetchWithRetry } from './transcribe'

export type ClipPlan = { start: number; end: number; title: string; reason?: string }

const MIN_CLIP = 8

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
const round1 = (n: number) => Math.round(n * 10) / 10

/** Snap a plan to sentence boundaries so clips do not start or end mid-sentence, then clamp to the media. */
function snap(plan: ClipPlan, segments: Segment[], duration: number, target: number): ClipPlan | null {
  let { start, end } = plan
  if (segments.length) {
    const s = segments.find((seg) => seg.end > start && seg.start <= start + 4) ?? segments.find((seg) => seg.start >= start)
    if (s && Math.abs(s.start - start) < 6) start = s.start
    const eSeg = [...segments].reverse().find((seg) => seg.start < end && seg.end >= end - 4) ?? [...segments].reverse().find((seg) => seg.end <= end)
    if (eSeg && Math.abs(eSeg.end - end) < 6) end = eSeg.end
  }
  start = Math.max(0, start)
  end = Math.min(duration, end)
  const max = target * 1.5
  if (end - start > max) end = start + max
  if (end - start < MIN_CLIP) {
    end = Math.min(duration, start + Math.min(target, Math.max(MIN_CLIP, end - start)))
    if (end - start < MIN_CLIP) start = Math.max(0, end - MIN_CLIP)
  }
  if (end - start < Math.min(MIN_CLIP, duration)) return null
  return { ...plan, start: round1(start), end: round1(end) }
}

function dedupe(plans: ClipPlan[], limit: number): ClipPlan[] {
  const out: ClipPlan[] = []
  for (const p of plans) {
    if (out.some((o) => p.start < o.end && p.end > o.start)) continue
    out.push(p)
    if (out.length >= limit) break
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * Contiguous fixed-length parts: 0-L, L-2L, ... up to the end of the video, with no gaps or overlaps.
 * The last part is whatever remains (a tail shorter than MIN_TAIL seconds is folded into the previous part
 * instead of becoming an unwatchable sliver).
 */
const MIN_TAIL = 2
export function selectSequential(duration: number, target: number): ClipPlan[] {
  const plans: ClipPlan[] = []
  let start = 0
  while (start < duration - 0.05) {
    let end = Math.min(duration, start + target)
    if (duration - end < MIN_TAIL) end = duration
    plans.push({ start, end, title: `Part ${plans.length + 1} (${fmt(start)}-${fmt(end)})` })
    start = end
  }
  if (plans.length > MAX_SEQUENTIAL_CLIPS) throw new Error(`This video would be cut into ${plans.length} parts (limit ${MAX_SEQUENTIAL_CLIPS}). Choose a longer clip length.`)
  return plans
}

export function clipCountFor(duration: number, target: number, max: number) {
  return Math.max(1, Math.min(max, Math.floor(duration / target)))
}

/** LLM-based selection (OpenAI-compatible chat API). Returns [] when the model gives nothing usable. */
export async function selectWithAI(transcript: Transcript, duration: number, target: number, count: number): Promise<ClipPlan[]> {
  const cfg = getConfig()
  let text = transcript.segments.map((s) => `[${fmt(s.start)}|${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n')
  if (text.length > 120_000) text = text.slice(0, 120_000)
  const system =
    'You are an expert short-form video editor. From a timestamped transcript you choose the most engaging, self-contained moments ' +
    '(strong hook, a complete thought, emotional or surprising payoff) to turn into standalone clips. Respond with JSON only.'
  const user =
    `Video length: ${duration.toFixed(1)} seconds. Pick up to ${count} non-overlapping clips, each about ${target} seconds long ` +
    `(between ${Math.round(target * 0.6)} and ${Math.round(target * 1.4)} seconds). Start at the beginning of a sentence and end at the end of a sentence. ` +
    `Use the second values in the transcript timestamps. Return {"clips":[{"start":<seconds>,"end":<seconds>,"title":"<catchy title, max 8 words>","reason":"<one short sentence>"}]}.\n\nTranscript:\n${text}`

  const response = await fetchWithRetry(
    `${cfg.openaiBaseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.chatModel, temperature: 0.4, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    },
    'AI clip selection',
  )
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content ?? ''
  let parsed: { clips?: Array<{ start?: unknown; end?: unknown; title?: unknown; reason?: unknown }> }
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim())
  } catch {
    return []
  }
  const plans: ClipPlan[] = []
  for (const c of parsed.clips ?? []) {
    const start = Number(c.start)
    const end = Number(c.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const snapped = snap({ start, end, title: String(c.title ?? '').trim().slice(0, 90) || 'Highlight', reason: c.reason ? String(c.reason).slice(0, 200) : undefined }, transcript.segments, duration, target)
    if (snapped) plans.push(snapped)
  }
  return dedupe(plans, count)
}

/** Free fallback: pick the loudest / most talkative windows. No API needed. */
export async function selectHeuristic(audioFile: string | null, hasAudio: boolean, transcript: Transcript | null, duration: number, target: number, count: number): Promise<ClipPlan[]> {
  const len = Math.min(target, duration)
  if (duration <= target * 1.15) return [{ start: 0, end: round1(duration), title: 'Full video' }]

  const seconds = Math.ceil(duration)
  let loud: number[] = []
  if (audioFile && hasAudio) {
    try {
      loud = await loudnessPerSecond(audioFile)
    } catch {}
  }
  const words = new Array<number>(seconds).fill(0)
  for (const s of transcript?.segments ?? []) {
    const n = s.text.split(/\s+/).length
    const dur = Math.max(s.end - s.start, 0.5)
    for (let t = Math.floor(s.start); t < Math.min(seconds, Math.ceil(s.end)); t++) words[t] += n / dur
  }
  const maxLoud = Math.max(...loud, 1e-6)
  const maxWords = Math.max(...words, 1e-6)
  const prefix = [0]
  for (let t = 0; t < seconds; t++) prefix.push(prefix[t] + (loud[t] ?? 0) / maxLoud + (words[t] / maxWords) * 0.7)

  const step = Math.max(1, Math.floor(len / 6))
  const candidates: Array<{ start: number; end: number; score: number }> = []
  for (let start = 0; start + len <= duration + 0.01; start += step) {
    const a = Math.floor(start)
    const b = Math.min(seconds, Math.floor(start + len))
    candidates.push({ start, end: Math.min(duration, start + len), score: (prefix[b] - prefix[a]) / Math.max(1, b - a) })
  }
  candidates.sort((x, y) => y.score - x.score)
  const snapped = candidates.map((c) => snap({ start: c.start, end: c.end, title: '' }, transcript?.segments ?? [], duration, target)).filter((c): c is ClipPlan => Boolean(c))
  const chosen = dedupe(snapped, count)
  return chosen.map((plan, i) => {
    const firstWords = transcript?.segments.filter((s) => s.end > plan.start && s.start < plan.end).map((s) => s.text).join(' ').split(/\s+/).slice(0, 7).join(' ')
    return { ...plan, title: firstWords ? `${firstWords.replace(/[.,;:!?]+$/, '')}…` : `Highlight ${i + 1} (${fmt(plan.start)})`, reason: 'Selected by audio energy and speech density (no AI key configured).' }
  })
}
