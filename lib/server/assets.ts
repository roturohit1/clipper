import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MUSIC_ID_RE, type BrandingInfo, type MusicTrack } from '../branding'
import { getConfig } from './config'
import { audioDuration } from './media'

// Reusable assets shared by every project: your own logo (data/branding) and your licensed music (data/music).

export const brandingDir = () => path.join(getConfig().dataDir, 'branding')
export const musicDir = () => path.join(getConfig().dataDir, 'music')

export const MAX_LOGO_BYTES = 5 * 1024 * 1024
export const MAX_MUSIC_BYTES = 60 * 1024 * 1024
export const MAX_MUSIC_TRACKS = 100

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function removeFile(file: string) {
  fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 100 })
}

// ---------- logo ----------
const logoFile = () => path.join(brandingDir(), 'logo.png')
const logoMeta = () => path.join(brandingDir(), 'logo.json')

function pngSize(buffer: Buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Path of the saved logo, or null when none was uploaded. */
export function logoPath(): string | null {
  return fs.existsSync(logoFile()) ? logoFile() : null
}

export function logoAspect(): number {
  try {
    const { width, height } = pngSize(fs.readFileSync(logoFile()).subarray(0, 32))
    return width > 0 && height > 0 ? height / width : 1
  } catch {
    return 1
  }
}

export function brandingInfo(): BrandingInfo {
  const file = logoPath()
  if (!file) return { logo: null }
  try {
    const { width, height } = pngSize(fs.readFileSync(file).subarray(0, 32))
    let name = 'logo.png'
    try {
      name = String((JSON.parse(fs.readFileSync(logoMeta(), 'utf8')) as { name?: string }).name || name)
    } catch {
      // no metadata: keep the default name
    }
    return { logo: { name, width, height, url: `/api/branding/logo?v=${Math.floor(fs.statSync(file).mtimeMs)}` } }
  } catch {
    return { logo: null }
  }
}

export function saveLogo(data: Buffer, originalName: string) {
  if (data.length > MAX_LOGO_BYTES) throw new Error('The logo is too large (5 MB maximum).')
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('The logo must be a PNG file.')
  const { width, height } = pngSize(data)
  if (!width || !height || width > 8000 || height > 8000) throw new Error('The logo dimensions are not supported (8000 px maximum).')
  fs.mkdirSync(brandingDir(), { recursive: true })
  fs.writeFileSync(logoFile(), data)
  fs.writeFileSync(logoMeta(), JSON.stringify({ name: path.basename(originalName).slice(0, 120) || 'logo.png' }))
}

export function removeLogo() {
  removeFile(logoFile())
  removeFile(logoMeta())
}

// ---------- music ----------
const MUSIC_EXT = ['mp3', 'wav'] as const

/** Path of a saved track. The id must be 16 hex characters and is only ever looked up inside data/music. */
export function musicPath(id: string): string | null {
  if (!MUSIC_ID_RE.test(id)) return null
  for (const ext of MUSIC_EXT) {
    const file = path.join(musicDir(), `${id}.${ext}`)
    if (fs.existsSync(file)) return file
  }
  return null
}

function musicExtFor(data: Buffer, originalName: string): 'mp3' | 'wav' | null {
  if (data.length > 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav'
  const id3 = data.subarray(0, 3).toString('latin1') === 'ID3'
  const frame = data.length > 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0
  if ((id3 || frame) && /\.mp3$/i.test(originalName)) return 'mp3'
  return null
}

export function listMusic(): MusicTrack[] {
  let files: string[] = []
  try {
    files = fs.readdirSync(musicDir())
  } catch {
    return []
  }
  const tracks: Array<MusicTrack & { createdAt: string }> = []
  for (const file of files) {
    const match = /^([a-f0-9]{16})\.(mp3|wav)$/.exec(file)
    if (!match) continue
    let meta: { name?: string; durationSeconds?: number; createdAt?: string } = {}
    try {
      meta = JSON.parse(fs.readFileSync(path.join(musicDir(), `${match[1]}.json`), 'utf8'))
    } catch {
      // sidecar missing: fall back to defaults
    }
    tracks.push({
      id: match[1],
      name: meta.name || file,
      sizeBytes: fs.statSync(path.join(musicDir(), file)).size,
      durationSeconds: meta.durationSeconds ?? 0,
      url: `/api/music/${match[1]}`,
      createdAt: meta.createdAt || '',
    })
  }
  return tracks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ createdAt: _createdAt, ...track }) => track)
}

export async function saveMusic(data: Buffer, originalName: string): Promise<MusicTrack> {
  if (data.length > MAX_MUSIC_BYTES) throw new Error('The track is too large (60 MB maximum).')
  const ext = musicExtFor(data, originalName)
  if (!ext) throw new Error('Upload an MP3 or WAV file.')
  if (listMusic().length >= MAX_MUSIC_TRACKS) throw new Error('The music library is full. Delete a track first.')
  fs.mkdirSync(musicDir(), { recursive: true })
  const id = randomBytes(8).toString('hex')
  const file = path.join(musicDir(), `${id}.${ext}`)
  fs.writeFileSync(file, data)
  let durationSeconds = 0
  try {
    durationSeconds = await audioDuration(file)
  } catch {
    durationSeconds = 0
  }
  if (!(durationSeconds > 0)) {
    removeFile(file)
    throw new Error('This audio file could not be read. Try another MP3 or WAV.')
  }
  const name = path.basename(originalName).replace(/\.(mp3|wav)$/i, '').slice(0, 120) || 'Track'
  fs.writeFileSync(path.join(musicDir(), `${id}.json`), JSON.stringify({ name, durationSeconds: Math.round(durationSeconds * 10) / 10, createdAt: new Date().toISOString() }))
  return { id, name, sizeBytes: data.length, durationSeconds: Math.round(durationSeconds * 10) / 10, url: `/api/music/${id}` }
}

export function removeMusic(id: string): boolean {
  const file = musicPath(id)
  if (!file) return false
  removeFile(file)
  removeFile(path.join(musicDir(), `${id}.json`))
  return true
}
