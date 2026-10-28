import fs from 'node:fs'
import path from 'node:path'
import { getConfig, MISSING_KEY_MESSAGE } from './config'
import { croppedSize, outputSize, videoFilterGraph } from '../aspect'
import { audioFilterGraph, buildWatermarkAss, EMPTY_MUSIC_LIBRARY_MESSAGE, logoOverlayPosition, watermarkLayout } from '../branding'
import { DEFAULT_CAPTION_OPTIONS } from '../captions'
import { listMusic, logoAspect, logoPath, musicPath } from './assets'
import { emojisForLines } from './emoji'
import { downloadFromUrl } from './ingest'
import { extractAudio, probe } from './media'
import { commandExists, jobContext, run } from './proc'
import { clipCountFor, selectHeuristic, selectSequential, selectWithAI, type ClipPlan } from './select-clips'
import { ensureJobDir, isDeleted, loadJob, saveJob, type JobRecord } from './store'
import { buildAss, captionLines } from './subtitles'
import { resolveProvider, transcribe, type Transcript } from './transcribe'

function update(job: JobRecord, progress: number, stage: string) {
  job.progress = Math.max(job.progress, Math.min(99, progress))
  job.stage = stage
  saveJob(job)
}

const warn = (job: JobRecord, message: string) => {
  job.warnings = [...(job.warnings ?? []), message]
}

// ---- simple in-process queue (state kept on globalThis so all route bundles share it) ----
const g = globalThis as unknown as { __avcpQueue?: { pending: string[]; running: number } }
const queue = (g.__avcpQueue ??= { pending: [], running: 0 })
const gr = globalThis as unknown as { __avcpRuns?: Map<string, { controller: AbortController; done: Promise<void> }> }
const runs = (gr.__avcpRuns ??= new Map<string, { controller: AbortController; done: Promise<void> }>())

/** Stop a queued or running job: drop it from the queue and kill its ffmpeg / yt-dlp / download, then wait for it to let go of its files. */
export async function cancelJob(id: string) {
  const queued = queue.pending.indexOf(id)
  if (queued !== -1) queue.pending.splice(queued, 1)
  const active = runs.get(id)
  if (!active) return
  active.controller.abort()
  await Promise.race([active.done, new Promise((resolve) => setTimeout(resolve, 10_000))])
}

/** Throws once the project has been deleted so a running job stops at its next step. */
function assertActive(job: JobRecord) {
  if (isDeleted(job.id)) throw new Error('This project was deleted.')
}

export function enqueue(jobId: string) {
  queue.pending.push(jobId)
  pump()
}

function pump() {
  const limit = getConfig().concurrency
  while (queue.running < limit && queue.pending.length) {
    const id = queue.pending.shift()!
    queue.running++
    const controller = new AbortController()
    const done = jobContext
      .run({ signal: controller.signal }, () => processJob(id))
      .catch((error) => console.error('[pipeline] unexpected error', error))
      .finally(() => {
        runs.delete(id)
        queue.running--
        pump()
      })
    runs.set(id, { controller, done })
  }
}

async function processJob(id: string) {
  const job = loadJob(id)
  if (!job) return
  job.status = 'processing'
  job.progress = 1
  job.stage = 'Starting'
  saveJob(job)
  try {
    await run_(job)
    job.status = 'completed'
    job.progress = 100
    job.stage = 'Done'
    saveJob(job)
  } catch (error) {
    if (isDeleted(id)) return // cancelled because the project was deleted
    console.error(`[pipeline] job ${id} failed:`, error)
    job.status = 'failed'
    job.error = error instanceof Error ? error.message : 'Processing failed.'
    job.stage = 'Failed'
    saveJob(job)
  }
}

async function run_(job: JobRecord) {
  const cfg = getConfig()
  const dir = ensureJobDir(job.id)
  const clipsDir = path.join(dir, 'clips')
  fs.mkdirSync(clipsDir, { recursive: true })

  if (!(await commandExists(cfg.ffmpegPath)) || !(await commandExists(cfg.ffprobePath))) {
    throw new Error('ffmpeg/ffprobe were not found. Install FFmpeg and add it to PATH, or set FFMPEG_PATH and FFPROBE_PATH in .env.local.')
  }

  // 1. Source
  let source = job.source.file ? path.join(dir, job.source.file) : ''
  if (job.source.type === 'url') {
    update(job, 2, 'Downloading video')
    source = await downloadFromUrl(job.source.url!, dir, (f) => update(job, 2 + f * 13, 'Downloading video'))
    job.source.file = path.basename(source)
    job.sourceName = job.sourceName || path.basename(source)
  }
  assertActive(job)
  if (!source || !fs.existsSync(source)) throw new Error('The source video is missing.')

  // 2. Probe
  update(job, 15, 'Analyzing video')
  const info = await probe(source)
  assertActive(job)

  // Trim: clip only the window [from, to] of the source. Audio, transcript and clip selection all work in window time
  // (0 = trim start); only the ffmpeg seek and the saved source times add `from` back.
  const trim = job.options.trim
  const from = Math.min(Math.max(0, trim?.start ?? 0), info.duration)
  const to = trim?.end && trim.end > 0 ? Math.min(trim.end, info.duration) : info.duration
  const windowDuration = to - from
  if (windowDuration < 3) throw new Error('Trim leaves less than 3 seconds of video. Check the trim start and end.')
  const trimmed = from > 0 || to < info.duration - 0.05

  // 3. Audio + transcription
  let transcript: Transcript | null = null
  let audioFile: string | null = null
  if (info.hasAudio) {
    update(job, 18, 'Extracting audio')
    audioFile = path.join(dir, 'audio.mp3')
    await extractAudio(source, audioFile, trimmed ? { start: from, duration: windowDuration } : undefined)
    const provider = await resolveProvider()
    if (provider === 'none') {
      job.transcription = 'none'
      warn(job, 'No transcription is configured, so clips have no captions and are chosen by audio energy. Set OPENAI_API_KEY or install local Whisper (see README).')
    } else {
      update(job, 22, provider === 'openai' ? 'Transcribing (OpenAI Whisper)' : 'Transcribing (local Whisper; first run downloads the model)')
      transcript = await transcribe(audioFile, dir, provider, (f) => update(job, 22 + f * 28, provider === 'openai' ? 'Transcribing (OpenAI Whisper)' : 'Transcribing (local Whisper; first run downloads the model)'))
      job.transcription = provider
      fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(transcript, null, 2))
      if (!transcript.segments.length) {
        warn(job, 'No speech was detected, so clips have no captions.')
        transcript = null
      }
    }
  } else {
    job.transcription = 'none'
    warn(job, 'This video has no audio track, so there are no captions and clips are spread evenly.')
  }

  // 4. Choose clips
  assertActive(job)
  update(job, 52, 'Choosing the best moments')
  const target = job.options.clipLength
  const count = clipCountFor(windowDuration, target, cfg.maxClips)
  let plans: ClipPlan[] = []
  const wantAI = cfg.selectionProvider !== 'heuristic'
  const sequential = job.options.clipMode === 'sequential'
  if (sequential) {
    // contiguous parts 0-L, L-2L, ... to the end of the video: no AI, no clip cap
    plans = selectSequential(windowDuration, target)
    job.selection = 'sequential'
  } else if (transcript && wantAI && cfg.apiKey) {
    try {
      plans = await selectWithAI(transcript, windowDuration, target, count)
      if (plans.length) job.selection = 'ai'
      else warn(job, 'The AI returned no usable clips; used the audio-energy fallback instead.')
    } catch (error) {
      if (cfg.selectionProvider === 'openai') throw error
      warn(job, `AI clip selection failed (${error instanceof Error ? error.message : 'unknown error'}); used the audio-energy fallback instead.`)
    }
  } else if (transcript && wantAI && !cfg.apiKey) {
    if (cfg.selectionProvider === 'openai') throw new Error(MISSING_KEY_MESSAGE)
    warn(job, 'AI clip selection is off because OPENAI_API_KEY is not set. Clips were chosen by audio energy and speech density.')
  }
  if (!plans.length) {
    plans = await selectHeuristic(audioFile, info.hasAudio, transcript, windowDuration, target, count)
    job.selection = 'heuristic'
  }
  if (!plans.length) throw new Error('Could not find any clip in this video.')

  // 5. Render
  const caption = { ...DEFAULT_CAPTION_OPTIONS, ...job.options.captions }
  // output frame: older jobs (no aspect saved) keep the source size
  const aspect = job.options.aspect ?? 'original'
  const aspectFit = job.options.aspectFit ?? 'crop'
  const cropped = croppedSize(info.width, info.height, job.options.crop)
  const out = outputSize(aspect, cropped.width, cropped.height)
  const capFps = info.fps > 30.5

  // own watermark (logo from data/branding and/or text), placed after the output fit; captions keep clear of it
  const wm = job.options.watermark
  const logoFile = wm?.logo ? logoPath() : null
  if (wm?.logo && !logoFile) warn(job, 'The saved logo was not found, so no logo was added.')
  const wmLayout = wm && (logoFile || wm.text) ? watermarkLayout(wm, out.width, Boolean(logoFile), logoAspect()) : null
  const wmAss = wm && wm.text && wmLayout ? 'watermark.ass' : null
  if (wm && wmLayout && wmAss) fs.writeFileSync(path.join(dir, wmAss), buildWatermarkAss(wm, wmLayout, out.width, out.height))
  const captionClear = wmLayout && caption.position !== 'middle' && caption.position === wmLayout.edge ? wmLayout.occupiedPx + Math.round(out.height * 0.01) : 0

  // music (from data/music): replace the source audio, or mix it under the voice
  const audio = job.options.audio
  const chosenMusic = audio && audio.mode !== 'original' && audio.musicId ? musicPath(audio.musicId) : null
  const copyrightSafe = Boolean(audio?.copyrightSafe)
  // copyright-safe audio: the source sound is always dropped. With no chosen track, rotate through the library from a random
  // start so consecutive clips get different tracks (and a different one on every job).
  const library = copyrightSafe ? listMusic().map((track) => musicPath(track.id)).filter((file): file is string => Boolean(file)) : []
  if (copyrightSafe && !chosenMusic && !library.length) throw new Error(EMPTY_MUSIC_LIBRARY_MESSAGE)
  const libraryStart = library.length ? Math.floor(Math.random() * library.length) : 0
  if (audio && audio.mode !== 'original' && !chosenMusic && !copyrightSafe) warn(job, 'The chosen music track was not found, so the original audio was kept.')
  if (copyrightSafe && audio?.musicId && !chosenMusic) warn(job, 'The chosen music track was not found, so tracks from your music library were picked automatically.')
  job.clips = []
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    const n = i + 1
    const pctFrom = 55 + (i / plans.length) * 44
    const span = 44 / plans.length
    const stage = `Rendering clip ${n} of ${plans.length}`
    assertActive(job)
    update(job, pctFrom, stage)

    const musicFile = chosenMusic ?? (copyrightSafe && library.length ? library[(libraryStart + i) % library.length] : null)
    const outName = `clip-${n}.mp4`
    const duration = plan.end - plan.start
    const assName = `clip-${n}.ass`
    let emojis: string[] = []
    if (transcript && caption.enabled && caption.emoji) {
      update(job, pctFrom, `Adding emojis to clip ${n} captions`)
      const lines = captionLines(transcript.segments, plan.start, plan.end, caption, sequential)
      const result = await emojisForLines(lines)
      emojis = result.emojis
      if (result.note) warn(job, `Emoji captions used the keyword fallback for clip ${n} (${result.note}).`)
    }
    const ass = transcript && caption.enabled ? buildAss(transcript.segments, plan.start, plan.end, job.options.subtitleStyle, out.width, out.height, caption, emojis, sequential, captionClear) : null
    if (ass) fs.writeFileSync(path.join(dir, assName), ass)

    const render = async (withCaptions: boolean) => {
      const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-ss', (plan.start + from).toFixed(2), '-i', source]
      let nextInput = 1
      let logoInput = 0
      if (logoFile && wmLayout) {
        args.push('-i', logoFile)
        logoInput = nextInput++
      }
      let musicInput = 0
      if (musicFile) {
        args.push('-stream_loop', '-1', '-i', musicFile) // loop short tracks; the graph trims to the clip length
        musicInput = nextInput++
      }
      // the last contiguous part runs to the end of the file, so no rounding of -t can drop its final frames
      if (!(sequential && i === plans.length - 1 && to >= info.duration - 0.05)) args.push('-t', duration.toFixed(2))
      // relative ASS name + cwd avoids Windows drive-letter escaping problems; captions are drawn at the output size
      const videoGraph = videoFilterGraph({
        aspect,
        fit: aspectFit,
        width: out.width,
        height: out.height,
        capFps,
        ass: withCaptions ? assName : null,
        crop: job.options.crop,
        watermarkAss: wmAss,
        logo: logoFile && wmLayout && wm ? { input: logoInput, width: wmLayout.logoWidth, opacity: wm.opacity / 100, ...logoOverlayPosition(wm.position, wmLayout.marginPx) } : undefined,
      })
      const audioGraph = musicFile && audio ? audioFilterGraph({ mode: copyrightSafe ? 'replace' : audio.mode, music: musicInput, hasVoice: info.hasAudio, volumePct: audio.volumePct, duration }) : null
      args.push('-filter_complex', audioGraph ? `${videoGraph};${audioGraph}` : videoGraph, '-map', '[v]', '-map', audioGraph ? '[a]' : '0:a:0?')
      if (audioGraph) args.push('-shortest')
      args.push('-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p')
      args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', path.join('clips', outName))
      return run(cfg.ffmpegPath, args, {
        cwd: dir,
        onStdoutLine: (line) => {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
          if (m) update(job, pctFrom + Math.min(1, Number(m[1]) / 1e6 / duration) * span, stage)
        },
      })
    }

    let captioned = Boolean(ass)
    let result = await render(captioned)
    if (result.code !== 0 && captioned) {
      warn(job, `Captions could not be burned into clip ${n} (${result.stderr.trim().split('\n').pop()}); rendered without captions.`)
      captioned = false
      result = await render(false)
    }
    if (result.code !== 0) throw new Error(`ffmpeg failed on clip ${n}: ${result.stderr.trim().split('\n').pop()}`)

    job.clips.push({
      id: `clip-${n}`,
      title: plan.title,
      reason: plan.reason,
      durationSeconds: Math.round(duration),
      sourceStartSeconds: Math.round((plan.start + from) * 100) / 100,
      sourceEndSeconds: Math.round((plan.end + from) * 100) / 100,
      previewUrl: `/api/jobs/${job.id}/clips/clip-${n}`,
      downloadUrl: `/api/jobs/${job.id}/clips/clip-${n}?download=1`,
      captioned,
      file: path.join('clips', outName),
    })
    saveJob(job)
  }
}
