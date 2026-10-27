import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getConfig } from './config'
import { commandExists, run } from './proc'

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|flv|ts|mpg|mpeg|3gp|ogv)$/i

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const v = ip.toLowerCase()
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7))
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')
}

/** SSRF guard: refuse URLs that resolve to loopback / private networks (unless ALLOW_PRIVATE_URLS=true). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Enter a valid video URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links are supported.')
  if (getConfig().allowPrivateUrls) return url
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => [])
  if (!addresses.length) throw new Error(`Could not resolve host "${host}".`)
  if (addresses.some((a) => isPrivateIp(a.address))) throw new Error('Links to private or local network addresses are not allowed.')
  return url
}

export async function downloadFromUrl(rawUrl: string, dir: string, onProgress: (fraction: number) => void): Promise<string> {
  const cfg = getConfig()
  let url = await assertPublicUrl(rawUrl)
  const looksDirect = VIDEO_EXT.test(url.pathname)
  const hasYtDlp = await commandExists(cfg.ytDlpPath, '--version')

  if (!looksDirect && hasYtDlp) return ytDlpDownload(url.toString(), dir, onProgress)

  // Direct file download, following redirects manually so every hop is checked.
  let response: Response | null = null
  for (let hop = 0; hop < 5; hop++) {
    response = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Cutline)' } })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      url = await assertPublicUrl(new URL(location, url).toString())
      continue
    }
    break
  }
  if (!response || !response.ok || !response.body) throw new Error(`Could not download the link (HTTP ${response?.status ?? 'error'}).`)
  const type = response.headers.get('content-type') ?? ''
  if (!type.startsWith('video/') && !type.includes('octet-stream') && !looksDirect) {
    throw new Error(
      hasYtDlp
        ? 'This link is not a video file.'
        : 'This looks like a web page, not a video file. Paste a direct video link (.mp4/.webm), or install yt-dlp (https://github.com/yt-dlp/yt-dlp) to import from YouTube and similar sites.',
    )
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  if (total > cfg.maxUploadBytes) throw new Error(`The video is larger than the ${cfg.maxUploadMb} MB limit.`)
  const ext = VIDEO_EXT.exec(url.pathname)?.[0] ?? (type.includes('webm') ? '.webm' : '.mp4')
  const dest = path.join(dir, `source${ext.toLowerCase()}`)
  let received = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      if (received > cfg.maxUploadBytes) return cb(new Error(`The video is larger than the ${cfg.maxUploadMb} MB limit.`))
      if (total) onProgress(received / total)
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body as never), counter, fs.createWriteStream(dest))
  return dest
}

async function ytDlpDownload(url: string, dir: string, onProgress: (fraction: number) => void): Promise<string> {
  const cfg = getConfig()
  const args = [
    '--no-playlist', '--no-warnings', '--newline', '--restrict-filenames',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--max-filesize', `${cfg.maxUploadMb}M`,
    '-o', path.join(dir, 'source.%(ext)s'),
  ]
  if (cfg.ffmpegPath !== 'ffmpeg') args.push('--ffmpeg-location', cfg.ffmpegPath)
  args.push('--', url)
  const r = await run(cfg.ytDlpPath, args, {
    onStdoutLine: (line) => {
      const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line)
      if (m) onProgress(Number(m[1]) / 100)
    },
  })
  if (r.code !== 0) {
    const reason = r.stderr.trim().split('\n').filter((l) => /ERROR/.test(l)).pop() ?? r.stderr.trim().split('\n').pop() ?? 'unknown error'
    throw new Error(`Could not import this link: ${reason.replace(/^ERROR:\s*/, '')}`)
  }
  const file = fs.readdirSync(dir).find((f) => f.startsWith('source.') && !f.endsWith('.part'))
  if (!file) throw new Error('The download finished but no video file was produced.')
  return path.join(dir, file)
}
