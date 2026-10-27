import fs from 'node:fs'
import path from 'node:path'
import { getConfig, MISSING_KEY_MESSAGE } from './config'
import { splitAudio } from './media'
import { run } from './proc'

export type Word = { start: number; end: number; word: string }
export type Segment = { start: number; end: number; text: string; words?: Word[] }
export type Transcript = { provider: 'openai' | 'local'; language?: string; segments: Segment[] }

const CHUNK_SECONDS = 600

export async function localWhisperAvailable(): Promise<boolean> {
  const { localPython } = getConfig()
  try {
    const r = await run(localPython, ['-c', 'import faster_whisper'])
    return r.code === 0
  } catch {
    return false
  }
}

/** Decide which transcription provider to use; throws a clear error when an explicit choice is unusable. */
export async function resolveProvider(): Promise<'openai' | 'local' | 'none'> {
  const cfg = getConfig()
  switch (cfg.transcriptionProvider) {
    case 'none':
      return 'none'
    case 'openai':
      if (!cfg.apiKey) throw new Error(MISSING_KEY_MESSAGE)
      return 'openai'
    case 'local':
      if (!(await localWhisperAvailable()))
        throw new Error(`Local Whisper is not available. Run: ${cfg.localPython} -m pip install faster-whisper "av<17" (or set LOCAL_WHISPER_PYTHON).`)
      return 'local'
    default:
      if (cfg.apiKey) return 'openai'
      if (await localWhisperAvailable()) return 'local'
      return 'none'
  }
}

export async function transcribe(audioFile: string, workDir: string, provider: 'openai' | 'local', onProgress: (fraction: number) => void): Promise<Transcript> {
  return provider === 'openai' ? transcribeOpenAI(audioFile, workDir, onProgress) : transcribeLocal(audioFile, onProgress)
}

type OpenAIWord = { word: string; start: number; end: number }
type OpenAISegment = { start: number; end: number; text: string }

async function transcribeOpenAI(audioFile: string, workDir: string, onProgress: (f: number) => void): Promise<Transcript> {
  const cfg = getConfig()
  if (!cfg.apiKey) throw new Error(MISSING_KEY_MESSAGE)
  const chunkDir = path.join(workDir, 'chunks')
  fs.mkdirSync(chunkDir, { recursive: true })
  await splitAudio(audioFile, path.join(chunkDir, 'chunk-%03d.mp3'), CHUNK_SECONDS)
  const chunks = fs.readdirSync(chunkDir).filter((f) => f.endsWith('.mp3')).sort()
  const segments: Segment[] = []
  let language: string | undefined

  for (let index = 0; index < chunks.length; index++) {
    const offset = index * CHUNK_SECONDS
    const form = new FormData()
    form.append('file', new Blob([fs.readFileSync(path.join(chunkDir, chunks[index]))], { type: 'audio/mpeg' }), chunks[index])
    form.append('model', cfg.transcriptionModel)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')

    const response = await fetchWithRetry(`${cfg.openaiBaseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: form }, 'Transcription')
    const data = (await response.json()) as { language?: string; segments?: OpenAISegment[]; words?: OpenAIWord[]; text?: string }
    language ??= data.language
    const words = data.words ?? []
    for (const s of data.segments ?? []) {
      const inSeg = words.filter((w) => w.start >= s.start - 0.05 && w.end <= s.end + 0.2)
      segments.push({
        start: s.start + offset,
        end: s.end + offset,
        text: s.text.trim(),
        words: inSeg.length ? inSeg.map((w) => ({ start: w.start + offset, end: w.end + offset, word: w.word.trim() })) : undefined,
      })
    }
    onProgress((index + 1) / chunks.length)
  }
  return { provider: 'openai', language, segments: segments.filter((s) => s.text) }
}

async function transcribeLocal(audioFile: string, onProgress: (f: number) => void): Promise<Transcript> {
  const cfg = getConfig()
  const script = path.join(/* turbopackIgnore: true */ process.cwd(), 'scripts', 'transcribe_local.py')
  const r = await run(cfg.localPython, [script, audioFile, cfg.localModel, cfg.localDevice], {
    onStderrLine: (line) => {
      const m = /^PROGRESS (\d+(?:\.\d+)?)/.exec(line)
      if (m) onProgress(Math.min(1, Number(m[1])))
    },
    maxBuffer: 200 * 1024 * 1024,
  })
  if (r.code !== 0) {
    const lines = r.stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/^PROGRESS|Warning:|^\^+$/.test(l))
    throw new Error(`Local Whisper failed: ${lines.slice(-2).join(' ')}. If the model download seems stuck, retry with HF_HUB_DISABLE_XET=1 set in the environment.`)
  }
  const data = JSON.parse(r.stdout) as { language?: string; segments: Segment[] }
  return { provider: 'local', language: data.language, segments: data.segments.filter((s) => s.text?.trim()) }
}

class FatalApiError extends Error {}

/** fetch with retry on 429/5xx and readable errors (never leaks the API key). */
export async function fetchWithRetry(url: string, init: RequestInit, label: string, attempts = 3): Promise<Response> {
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init)
      if (response.ok) return response
      const body = await response.text().catch(() => '')
      let detail = body.slice(0, 300)
      try {
        detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail
      } catch {}
      if (response.status === 401) throw new FatalApiError(`${label} failed: the API key was rejected (401). Check OPENAI_API_KEY. ${detail}`)
      if (response.status === 429 && /quota|billing/i.test(detail)) throw new FatalApiError(`${label} failed: API quota exceeded. ${detail}`)
      lastError = `${label} failed (${response.status}): ${detail}`
      if (response.status !== 429 && response.status < 500) throw new FatalApiError(lastError)
    } catch (error) {
      if (error instanceof FatalApiError) throw error
      lastError = `${label} request error: ${error instanceof Error ? error.message : String(error)}`
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
  throw new Error(lastError)
}
