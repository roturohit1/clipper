import path from 'node:path'

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const bool = (value: string | undefined) => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
const text = (value: string | undefined, fallback = '') => (value ?? '').trim() || fallback

/** Read env lazily so changes in .env are picked up per request in dev and nothing is baked in at build time. */
export function getConfig() {
  const env = process.env
  const apiKey = text(env.OPENAI_API_KEY)
  return {
    dataDir: path.resolve(/* turbopackIgnore: true */ text(env.DATA_DIR, './data')),
    ffmpegPath: text(env.FFMPEG_PATH, 'ffmpeg'),
    ffprobePath: text(env.FFPROBE_PATH, 'ffprobe'),
    ytDlpPath: text(env.YTDLP_PATH, 'yt-dlp'),
    apiKey,
    openaiBaseUrl: text(env.OPENAI_BASE_URL, 'https://api.openai.com/v1').replace(/\/$/, ''),
    chatModel: text(env.OPENAI_CHAT_MODEL, 'gpt-4o-mini'),
    transcriptionModel: text(env.OPENAI_TRANSCRIPTION_MODEL, 'whisper-1'),
    transcriptionProvider: text(env.TRANSCRIPTION_PROVIDER, 'auto').toLowerCase() as 'auto' | 'openai' | 'local' | 'none',
    selectionProvider: text(env.CLIP_SELECTION_PROVIDER, 'auto').toLowerCase() as 'auto' | 'openai' | 'heuristic',
    localPython: text(env.LOCAL_WHISPER_PYTHON, process.platform === 'win32' ? 'python' : 'python3'),
    localModel: text(env.LOCAL_WHISPER_MODEL, 'base'),
    localDevice: text(env.LOCAL_WHISPER_DEVICE, 'cpu'),
    maxClips: Math.min(int(env.MAX_CLIPS, 5), 20),
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 2048) * 1024 * 1024,
    maxUploadMb: int(env.MAX_UPLOAD_MB, 2048),
    concurrency: int(env.JOB_CONCURRENCY, 1),
    allowPrivateUrls: bool(env.ALLOW_PRIVATE_URLS),
  }
}

export const MISSING_KEY_MESSAGE =
  'OPENAI_API_KEY is not set. Add it to .env.local (see .env.example), or use the free local options (TRANSCRIPTION_PROVIDER=local, CLIP_SELECTION_PROVIDER=heuristic).'
