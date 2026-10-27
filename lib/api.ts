import { DEFAULT_CAPTION_OPTIONS, type CaptionOptions } from './captions'
import type { Aspect, AspectFit, CropEdges } from './aspect'
import type { AudioOptions, BrandingInfo, MusicTrack, TrimOptions, WatermarkOptions } from './branding'
import type { ClipMode } from './clip-mode'

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type Clip = {
  id: string
  title: string
  durationSeconds: number
  sourceStartSeconds: number
  /** End of this clip in the source video (seconds). */
  sourceEndSeconds?: number
  previewUrl: string
  downloadUrl: string
  reason?: string
  captioned?: boolean
}

export type Job = {
  id: string
  status: JobStatus
  progress: number
  stage?: string
  error?: string
  warnings?: string[]
  sourceName?: string
  /** Display name of this video's project. */
  projectName?: string
  /** 1-based folder number. Absent on projects created before folders were numbered. */
  projectNumber?: number
  /** Folder name under data/projects, such as "001-my-video". */
  folder?: string
  /** Where this project's rendered videos are saved, relative to the data directory. */
  clipsFolder?: string
  createdAt?: string
  transcription?: 'openai' | 'local' | 'none'
  selection?: 'ai' | 'heuristic' | 'sequential'
  clips?: Clip[]
}

export type AppConfig = {
  ffmpeg: boolean
  ytDlp: boolean
  transcription: 'openai' | 'local' | 'none'
  aiSelection: boolean
  maxUploadMb: number
  maxClips: number
  notices: string[]
}

export type JobOptions = { clipLength: number; subtitleStyle: string; clipMode?: ClipMode; aspect?: Aspect; aspectFit?: AspectFit; watermark?: WatermarkOptions; trim?: TrimOptions; crop?: CropEdges; audio?: AudioOptions; captions?: CaptionOptions }

/** Caption options as the snake_case API fields (colours are #RRGGBB or omitted for the style default). */
function captionFields(captions: CaptionOptions = DEFAULT_CAPTION_OPTIONS): Record<string, string> {
  return {
    captions: String(captions.enabled),
    caption_uppercase: String(captions.uppercase),
    caption_text_color: captions.textColor ?? 'default',
    caption_highlight_color: captions.highlightColor ?? 'default',
    caption_size: captions.size,
    caption_position: captions.position,
    caption_emoji: String(captions.emoji),
  }
}

/** Branding, trim / crop and audio options as the snake_case API fields. */
function extraFields(options: JobOptions): Record<string, string> {
  const fields: Record<string, string> = {}
  const w = options.watermark
  if (w) {
    fields.watermark_logo = String(w.logo)
    fields.watermark_text = w.text
    fields.watermark_position = w.position
    fields.watermark_size = String(w.sizePct)
    fields.watermark_opacity = String(w.opacity)
    fields.watermark_margin = String(w.marginPct)
  }
  if (options.trim) {
    fields.trim_start = String(options.trim.start)
    fields.trim_end = String(options.trim.end)
  }
  if (options.crop) {
    fields.crop_top = String(options.crop.top)
    fields.crop_bottom = String(options.crop.bottom)
    fields.crop_left = String(options.crop.left)
    fields.crop_right = String(options.crop.right)
  }
  if (options.audio) {
    fields.audio_mode = options.audio.mode
    fields.music_volume = String(options.audio.volumePct)
    if (options.audio.musicId) fields.music_id = options.audio.musicId
  }
  return fields
}

class ApiClient {
  // Optional. Leave NEXT_PUBLIC_API_URL empty to use the built-in Next.js API routes (same origin).
  private readonly baseUrl = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '')

  private resolve(url: string) {
    return /^https?:\/\//i.test(url) ? url : `${this.baseUrl}${url}`
  }

  private normalize(job: Job): Job {
    return {
      ...job,
      clips: job.clips?.map((clip) => ({ ...clip, previewUrl: this.resolve(clip.previewUrl), downloadUrl: this.resolve(clip.downloadUrl) })),
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, credentials: this.baseUrl ? 'include' : 'same-origin', cache: 'no-store' })
    } catch {
      throw new Error('Could not reach the processing API. Is the server running?')
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(payload?.detail || payload?.message || payload?.error || `API request failed (${response.status}).`)
    return payload as T
  }

  getConfig() {
    return this.request<AppConfig>('/api/config')
  }
  async createUploadJob(file: File, options: JobOptions) {
    const body = new FormData()
    body.append('clip_length', String(options.clipLength))
    body.append('subtitle_style', options.subtitleStyle)
    if (options.clipMode) body.append('clip_mode', options.clipMode)
    if (options.aspect) body.append('aspect', options.aspect)
    if (options.aspectFit) body.append('aspect_fit', options.aspectFit)
    for (const [key, value] of Object.entries(captionFields(options.captions))) body.append(key, value)
    for (const [key, value] of Object.entries(extraFields(options))) body.append(key, value)
    body.append('video', file) // keep the file last so the server can validate options before streaming it
    return this.normalize(await this.request<Job>('/api/jobs/upload', { method: 'POST', body }))
  }
  async createUrlJob(url: string, options: JobOptions) {
    return this.normalize(
      await this.request<Job>('/api/jobs/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, clip_length: options.clipLength, subtitle_style: options.subtitleStyle, ...(options.clipMode ? { clip_mode: options.clipMode } : {}), ...(options.aspect ? { aspect: options.aspect } : {}), ...(options.aspectFit ? { aspect_fit: options.aspectFit } : {}), ...captionFields(options.captions), ...extraFields(options) }),
      }),
    )
  }
  async getJob(id: string) {
    return this.normalize(await this.request<Job>(`/api/jobs/${encodeURIComponent(id)}`))
  }
  getBranding() {
    return this.request<BrandingInfo>('/api/branding')
  }
  uploadLogo(file: File) {
    const body = new FormData()
    body.append('logo', file)
    return this.request<BrandingInfo>('/api/branding', { method: 'POST', body })
  }
  deleteLogo() {
    return this.request<BrandingInfo>('/api/branding', { method: 'DELETE' })
  }
  listMusic() {
    return this.request<MusicTrack[]>('/api/music')
  }
  uploadMusic(file: File) {
    const body = new FormData()
    body.append('track', file)
    return this.request<MusicTrack>('/api/music', { method: 'POST', body })
  }
  async deleteMusic(id: string) {
    await this.request<{ ok: boolean }>(`/api/music/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  async deleteJob(id: string) {
    await this.request<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  async deleteClip(id: string, clipId: string) {
    return this.normalize(await this.request<Job>(`/api/jobs/${encodeURIComponent(id)}/clips/${encodeURIComponent(clipId)}`, { method: 'DELETE' }))
  }
  async deleteAllJobs() {
    return this.request<{ ok: boolean; deleted: number }>('/api/jobs', { method: 'DELETE' })
  }
  async listJobs() {
    const jobs = await this.request<Job[]>('/api/jobs')
    return jobs.map((job) => this.normalize(job))
  }
  openProjectFolder(id: string) {
    return this.request<{ ok: boolean; folder: string }>(`/api/jobs/${encodeURIComponent(id)}/folder`, { method: 'POST' })
  }
}

export const apiClient = new ApiClient()
