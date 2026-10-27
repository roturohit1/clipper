import { getConfig } from './config'
import { fetchWithRetry } from './transcribe'

const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*/gu
const MAX_PER_LINE = 2

/** Keyword -> emoji map used when no LLM is available (or it fails). First matches win, at most two per line. */
const KEYWORDS: Array<[RegExp, string]> = [
  [/\b(money|dollars?|cash|rich|wealth|profit|paid|salary|income|revenue|million|billion|invest\w*)\b/i, '💰'],
  [/\b(love|loved|loving|heart|passion|adore)\b/i, '❤️'],
  [/\b(fire|hot|burn\w*|lit|incredible|insane|crazy|wild)\b/i, '🔥'],
  [/\b(amazing|awesome|great|wonderful|fantastic|best|win|won|winning|success\w*|champion)\b/i, '🏆'],
  [/\b(happy|joy|fun|smile|laugh\w*|funny|haha|excited|celebrat\w*)\b/i, '😄'],
  [/\b(sad|cry\w*|tears|pain|hurt|lonely|loss|lost|grief)\b/i, '😢'],
  [/\b(angry|hate|mad|furious|rage|annoy\w*)\b/i, '😡'],
  [/\b(think|thought|idea|ideas|mind|brain|smart|clever|learn\w*|knowledge|understand)\b/i, '🧠'],
  [/\b(time|clock|hours?|minutes?|deadline|late|early|wait\w*)\b/i, '⏰'],
  [/\b(world|global|planet|earth|country|countries|international)\b/i, '🌍'],
  [/\b(work|working|job|career|business|company|office|boss|team)\b/i, '💼'],
  [/\b(grow\w*|increase\w*|rise|rising|higher|scale|boost)\b/i, '📈'],
  [/\b(fall|falling|down|drop\w*|decline|crash\w*|fail\w*|failure)\b/i, '📉'],
  [/\b(goal|target|aim|focus\w*|mission|purpose)\b/i, '🎯'],
  [/\b(power\w*|strong|strength|energy|force|fight\w*)\b/i, '💪'],
  [/\b(danger\w*|warning|careful|risk\w*|careless|stop)\b/i, '⚠️'],
  [/\b(secret|hidden|mystery|surprise\w*|unexpected|shock\w*|wow)\b/i, '😮'],
  [/\b(question|why|how|wonder\w*|curious)\b/i, '🤔'],
  [/\b(food|eat\w*|dinner|lunch|breakfast|cook\w*|hungry|delicious)\b/i, '🍽️'],
  [/\b(music|song|songs|sing\w*|dance|dancing|band)\b/i, '🎵'],
  [/\b(phone|app|apps|computer|software|tech\w*|digital|internet|online|code|coding|ai|data)\b/i, '💻'],
  [/\b(car|cars|drive|driving|road|travel\w*|trip|journey|fly|flight)\b/i, '🚗'],
  [/\b(home|house|family|kids?|children|mother|father|mom|dad|parents?)\b/i, '🏠'],
  [/\b(friend|friends|together|community|people|everyone|help\w*)\b/i, '🤝'],
  [/\b(star|stars|famous|dream\w*|magic\w*|wish)\b/i, '✨'],
  [/\b(health\w*|doctor|sleep|medicine|exercise|workout|body)\b/i, '🩺'],
  [/\b(sun|sunny|summer|beach|light|bright)\b/i, '☀️'],
  [/\b(book|books|read\w*|write|writing|story|stories|school|student\w*|teach\w*)\b/i, '📚'],
  [/\b(yes|agree\w*|correct|true|exactly|perfect)\b/i, '✅'],
  [/\b(never|wrong|false|don't|dont)\b/i, '🚫'],
  [/\b(thank\w*|please|welcome|hello|hey)\b/i, '🙏'],
]

export function keywordEmojis(line: string): string {
  const found: string[] = []
  for (const [re, emoji] of KEYWORDS) {
    if (re.test(line) && !found.includes(emoji)) found.push(emoji)
    if (found.length >= MAX_PER_LINE) break
  }
  return found.slice(0, 1).join('') // one emoji per line from the map keeps captions readable
}

/** Keep only real emoji from whatever the model returned. */
function sanitize(value: unknown): string {
  if (typeof value !== 'string') return ''
  return (value.match(EMOJI_RE) ?? []).slice(0, MAX_PER_LINE).join('')
}

async function llmEmojis(lines: string[]): Promise<string[]> {
  const cfg = getConfig()
  const system =
    'You add emojis to video captions. For each numbered caption line choose 0 to 2 emojis that match its meaning or emotion. ' +
    'Skip (empty string) lines where no emoji fits naturally; do not add an emoji to every line. Respond with JSON only.'
  const user =
    `Return {"emojis":[...]} with exactly ${lines.length} strings, in order (an empty string means no emoji).\n\nLines:\n` +
    lines.map((line, i) => `${i + 1}. ${line}`).join('\n')
  const response = await fetchWithRetry(
    `${cfg.openaiBaseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.chatModel, temperature: 0.5, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    },
    'Emoji captions',
  )
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content ?? ''
  const parsed = JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim()) as { emojis?: unknown }
  if (!Array.isArray(parsed.emojis) || parsed.emojis.length !== lines.length) throw new Error('the model returned an unexpected shape')
  return parsed.emojis.map(sanitize)
}

export type EmojiResult = { emojis: string[]; source: 'ai' | 'keywords'; note?: string }

/** One emoji string per caption line. Uses the configured LLM, and falls back to the keyword map. */
export async function emojisForLines(lines: string[]): Promise<EmojiResult> {
  if (!lines.length) return { emojis: [], source: 'keywords' }
  const cfg = getConfig()
  if (cfg.apiKey) {
    try {
      const emojis = await llmEmojis(lines)
      if (emojis.some(Boolean)) return { emojis, source: 'ai' }
      return { emojis: lines.map(keywordEmojis), source: 'keywords', note: 'The AI suggested no emojis' }
    } catch (error) {
      return { emojis: lines.map(keywordEmojis), source: 'keywords', note: error instanceof Error ? error.message : 'unknown error' }
    }
  }
  return { emojis: lines.map(keywordEmojis), source: 'keywords' }
}
