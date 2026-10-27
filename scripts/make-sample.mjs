// Generates a short test video (colour bars + a tone that pulses, so there are loud and quiet parts) with FFmpeg.
// Usage: pnpm sample [output.mp4] [seconds]
// NOTE: a tone has no speech, so it exercises upload -> clip selection -> render, but not captions.
// For captions, test with a real clip of someone talking.
import { spawnSync } from 'node:child_process'

const out = process.argv[2] || 'sample.mp4'
const seconds = process.argv[3] || '75'
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const args = [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
  '-af', "volume='if(lt(mod(t,20),8),1,0.15)':eval=frame",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
]
const r = spawnSync(ffmpeg, args, { stdio: 'inherit' })
if (r.error || r.status !== 0) {
  console.error('FFmpeg failed. Is it installed and on PATH (or FFMPEG_PATH set)?')
  process.exit(1)
}
console.log(`Created ${out}`)
