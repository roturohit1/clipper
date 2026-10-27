import { NextResponse } from 'next/server'
import type { AppConfig } from '@/lib/api'
import { getConfig } from '@/lib/server/config'
import { commandExists } from '@/lib/server/proc'
import { localWhisperAvailable, resolveProvider } from '@/lib/server/transcribe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const cfg = getConfig()
  const [ffmpeg, ffprobe, ytDlp] = await Promise.all([commandExists(cfg.ffmpegPath), commandExists(cfg.ffprobePath), commandExists(cfg.ytDlpPath, '--version')])
  const notices: string[] = []
  if (!ffmpeg || !ffprobe) notices.push('FFmpeg was not found. Install it and add it to PATH, or set FFMPEG_PATH / FFPROBE_PATH in .env.local, then restart the server.')

  let transcription: AppConfig['transcription'] = 'none'
  try {
    transcription = await resolveProvider()
  } catch (error) {
    notices.push(error instanceof Error ? error.message : 'Transcription is misconfigured.')
  }
  if (transcription === 'none' && cfg.transcriptionProvider === 'auto') {
    const local = await localWhisperAvailable()
    notices.push(
      local
        ? 'Captions are off.'
        : 'Captions are off: no OPENAI_API_KEY is set and local Whisper (faster-whisper) is not installed. Clips will be chosen by audio energy without captions.',
    )
  }
  const aiSelection = Boolean(cfg.apiKey) && cfg.selectionProvider !== 'heuristic' && transcription !== 'none'
  if (!cfg.apiKey && cfg.selectionProvider !== 'heuristic') notices.push('AI clip selection is off: OPENAI_API_KEY is not set. Clips will be picked by audio energy and speech density instead.')
  if (!ytDlp) notices.push('yt-dlp is not installed: only direct video file links (.mp4, .webm…) can be imported, not YouTube-style pages.')

  const body: AppConfig = { ffmpeg: ffmpeg && ffprobe, ytDlp, transcription, aiSelection, maxUploadMb: cfg.maxUploadMb, maxClips: cfg.maxClips, notices }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
