// End-to-end API smoke test against a RUNNING server (pnpm dev / pnpm start).
// Usage: pnpm smoke [video-file] [base-url]     (defaults: generated sample, http://localhost:3000)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const base = (process.argv[3] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
let video = process.argv[2]
if (!video) {
  video = path.join('data', 'smoke-sample.mp4')
  fs.mkdirSync('data', { recursive: true })
  const r = spawnSync(process.execPath, ['scripts/make-sample.mjs', video, '75'], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(1)
}
const fail = (message) => { console.error(`FAIL: ${message}`); process.exit(1) }

const config = await fetch(`${base}/api/config`).then((r) => r.json()).catch(() => fail(`cannot reach ${base}. Start the server first.`))
console.log('Config:', JSON.stringify({ ffmpeg: config.ffmpeg, ytDlp: config.ytDlp, transcription: config.transcription, aiSelection: config.aiSelection }))
config.notices.forEach((n) => console.log('  notice:', n))
if (!config.ffmpeg) fail('FFmpeg not available to the server.')

const form = new FormData()
form.append('clip_length', '30')
form.append('subtitle_style', 'bold')
form.append('video', await fs.openAsBlob(video), path.basename(video))
const created = await fetch(`${base}/api/jobs/upload`, { method: 'POST', body: form })
const job0 = await created.json()
if (!created.ok) fail(`upload rejected: ${job0.detail}`)
console.log(`Job ${job0.id} created`)

let job
for (let i = 0; i < 1200; i++) {
  job = await fetch(`${base}/api/jobs/${job0.id}`).then((r) => r.json())
  process.stdout.write(`\r  ${job.status} ${job.progress}% ${job.stage || ''}            `)
  if (job.status === 'completed' || job.status === 'failed') break
  await new Promise((r) => setTimeout(r, 1500))
}
console.log()
if (job.status !== 'completed') fail(job.error || 'job did not finish')
job.warnings?.forEach((w) => console.log('  warning:', w))
if (!job.clips?.length) fail('no clips produced')

const outDir = path.join('data', 'smoke-output')
fs.mkdirSync(outDir, { recursive: true })
for (const clip of job.clips) {
  const res = await fetch(`${base}${clip.downloadUrl}`)
  if (!res.ok) fail(`download failed for ${clip.id}`)
  const file = path.join(outDir, `${clip.id}.mp4`)
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  const seconds = Number.parseFloat(probe.stdout)
  if (!(seconds > 1)) fail(`${file} is not a valid video`)
  console.log(`  OK ${clip.id}: "${clip.title}" ${seconds.toFixed(1)}s (starts at ${clip.sourceStartSeconds}s, captions: ${clip.captioned}) -> ${file}`)
}
console.log('PASS: upload -> clips -> preview/download all work.')
