import { getConfig } from './config'
import { currentSignal, run } from './proc'

export type MediaInfo = { duration: number; width: number; height: number; hasAudio: boolean; hasVideo: boolean; fps: number }

export async function probe(file: string): Promise<MediaInfo> {
  const { ffprobePath } = getConfig()
  const r = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
  if (r.code !== 0) throw new Error('This file could not be read as a video. It may be corrupted or in an unsupported format.')
  const data = JSON.parse(r.stdout) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string; r_frame_rate?: string; tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }>
  }
  const streams = data.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0)
  if (!video) throw new Error('No video stream found in this file.')
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine the video duration.')
  const rate = (value?: string) => {
    const [n, d] = String(value ?? '').split('/').map(Number)
    return n > 0 && d > 0 ? n / d : 0
  }
  const fps = rate(video.avg_frame_rate) || rate(video.r_frame_rate)
  // phone videos are often stored sideways with a rotation flag; ffmpeg rotates them, so swap the size to match what is rendered
  const rotation = Math.abs(Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0)) % 180
  const width = video.width || 1280
  const height = video.height || 720
  return { duration, width: rotation === 90 ? height : width, height: rotation === 90 ? width : height, hasAudio: Boolean(audio), hasVideo: true, fps }
}

/** 16 kHz mono low-bitrate MP3: small enough for the 25 MB API upload limit in 10-minute chunks. */
export async function extractAudio(input: string, output: string) {
  const { ffmpegPath } = getConfig()
  const r = await run(ffmpegPath, ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', output])
  if (r.code !== 0) throw new Error(`Audio extraction failed: ${r.stderr.trim().split('\n').pop()}`)
}

export async function splitAudio(input: string, outPattern: string, seconds: number) {
  const { ffmpegPath } = getConfig()
  const r = await run(ffmpegPath, ['-y', '-v', 'error', '-i', input, '-f', 'segment', '-segment_time', String(seconds), '-c', 'copy', '-reset_timestamps', '1', outPattern])
  if (r.code !== 0) throw new Error(`Audio split failed: ${r.stderr.trim().split('\n').pop()}`)
}

/** Loudness (RMS, 0..1) per second of audio, decoded to 8 kHz mono PCM. */
export async function loudnessPerSecond(input: string): Promise<number[]> {
  const { ffmpegPath } = getConfig()
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true, signal: currentSignal() })
    const out: number[] = []
    let sum = 0
    let count = 0
    let leftover: Buffer = Buffer.alloc(0)
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk
      const usable = buf.length - (buf.length % 2)
      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i) / 32768
        sum += v * v
        if (++count === 8000) {
          out.push(Math.sqrt(sum / count))
          sum = 0
          count = 0
        }
      }
      leftover = buf.subarray(usable)
    })
    child.on('error', reject)
    child.on('close', () => {
      if (count > 800) out.push(Math.sqrt(sum / count))
      resolve(out)
    })
  })
}
