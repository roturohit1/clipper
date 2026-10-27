import { DEFAULT_CAPTION_OPTIONS, type CaptionOptions } from './captions'
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

export type JobOptions = { clipLength: number; subtitleStyle: string; clipMode?: ClipMode; captions?: CaptionOptions }

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
    for (const [key, value] of Object.entries(captionFields(options.captions))) body.append(key, value)
    body.append('video', file) // keep the file last so the server can validate options before streaming it
    return this.normalize(await this.request<Job>('/api/jobs/upload', { method: 'POST', body }))
  }
  async createUrlJob(url: string, options: JobOptions) {
    return this.normalize(
      await this.request<Job>('/api/jobs/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, clip_length: options.clipLength, subtitle_style: options.subtitleStyle, ...(options.clipMode ? { clip_mode: options.clipMode } : {}), ...captionFields(options.captions) }),
      }),
    )
  }
  async getJob(id: string) {
    return this.normalize(await this.request<Job>(`/api/jobs/${encodeURIComponent(id)}`))
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
