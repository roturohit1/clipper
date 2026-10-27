import fs from 'node:fs'
import path from 'node:path'
import { getConfig, MISSING_KEY_MESSAGE } from './config'
import { DEFAULT_CAPTION_OPTIONS } from '../captions'
import { emojisForLines } from './emoji'
import { downloadFromUrl } from './ingest'
import { extractAudio, probe } from './media'
import { commandExists, run } from './proc'
import { clipCountFor, selectHeuristic, selectSequential, selectWithAI, type ClipPlan } from './select-clips'
import { ensureJobDir, loadJob, saveJob, type JobRecord } from './store'
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

export function enqueue(jobId: string) {
  queue.pending.push(jobId)
  pump()
}

function pump() {
  const limit = getConfig().concurrency
  while (queue.running < limit && queue.pending.length) {
    const id = queue.pending.shift()!
    queue.running++
    void processJob(id)
      .catch((error) => console.error('[pipeline] unexpected error', error))
      .finally(() => {
        queue.running--
        pump()
      })
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
  if (!source || !fs.existsSync(source)) throw new Error('The source video is missing.')

  // 2. Probe
  update(job, 15, 'Analyzing video')
  const info = await probe(source)

  // 3. Audio + transcription
  let transcript: Transcript | null = null
  let audioFile: string | null = null
  if (info.hasAudio) {
    update(job, 18, 'Extracting audio')
    audioFile = path.join(dir, 'audio.mp3')
    await extractAudio(source, audioFile)
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
  update(job, 52, 'Choosing the best moments')
  const target = job.options.clipLength
  const count = clipCountFor(info.duration, target, cfg.maxClips)
  let plans: ClipPlan[] = []
  const wantAI = cfg.selectionProvider !== 'heuristic'
  const sequential = job.options.clipMode === 'sequential'
  if (sequential) {
    // contiguous parts 0-L, L-2L, ... to the end of the video: no AI, no clip cap
    plans = selectSequential(info.duration, target)
    job.selection = 'sequential'
  } else if (transcript && wantAI && cfg.apiKey) {
    try {
      plans = await selectWithAI(transcript, info.duration, target, count)
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
    plans = await selectHeuristic(audioFile, info.hasAudio, transcript, info.duration, target, count)
    job.selection = 'heuristic'
  }
  if (!plans.length) throw new Error('Could not find any clip in this video.')

  // 5. Render
  const caption = { ...DEFAULT_CAPTION_OPTIONS, ...job.options.captions }
  job.clips = []
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    const n = i + 1
    const from = 55 + (i / plans.length) * 44
    const span = 44 / plans.length
    const stage = `Rendering clip ${n} of ${plans.length}`
    update(job, from, stage)

    const outName = `clip-${n}.mp4`
    const duration = plan.end - plan.start
    const assName = `clip-${n}.ass`
    let emojis: string[] = []
    if (transcript && caption.enabled && caption.emoji) {
      update(job, from, `Adding emojis to clip ${n} captions`)
      const lines = captionLines(transcript.segments, plan.start, plan.end, caption, sequential)
      const result = await emojisForLines(lines)
      emojis = result.emojis
      if (result.note) warn(job, `Emoji captions used the keyword fallback for clip ${n} (${result.note}).`)
    }
    const ass = transcript && caption.enabled ? buildAss(transcript.segments, plan.start, plan.end, job.options.subtitleStyle, info.width, info.height, caption, emojis, sequential) : null
    if (ass) fs.writeFileSync(path.join(dir, assName), ass)

    const render = async (withCaptions: boolean) => {
      const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-ss', plan.start.toFixed(2), '-i', source]
      // the last contiguous part runs to the end of the file, so no rounding of -t can drop its final frames
      if (!(sequential && i === plans.length - 1)) args.push('-t', duration.toFixed(2))
      if (withCaptions) args.push('-vf', `ass=${assName}`) // relative name + cwd avoids Windows drive-letter escaping problems
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join('clips', outName))
      return run(cfg.ffmpegPath, args, {
        cwd: dir,
        onStdoutLine: (line) => {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
          if (m) update(job, from + Math.min(1, Number(m[1]) / 1e6 / duration) * span, stage)
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
      sourceStartSeconds: Math.round(plan.start * 100) / 100,
      sourceEndSeconds: Math.round(plan.end * 100) / 100,
      previewUrl: `/api/jobs/${job.id}/clips/clip-${n}`,
      downloadUrl: `/api/jobs/${job.id}/clips/clip-${n}?download=1`,
      captioned,
      file: path.join('clips', outName),
    })
    saveJob(job)
  }
}
