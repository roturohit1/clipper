'use client'

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient, type AppConfig, type Job } from '@/lib/api'
import { ASPECT_LABELS, ASPECTS, DEFAULT_ASPECT, DEFAULT_ASPECT_FIT, type Aspect, type AspectFit } from '@/lib/aspect'
import { type ClipMode } from '@/lib/clip-mode'
import { CAPTION_POSITIONS, COLOR_PRESETS, DEFAULT_CAPTION_OPTIONS, type CaptionOptions } from '@/lib/captions'

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|flv|ts|mpg|mpeg|3gp|ogv|wmv)$/i
const LAST_JOB_KEY = 'cutline:lastJobId'
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Trash icon (inline SVG, no icon library needed). */
function Trash2({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  )
}

/** Colour preset picker: '' = style default, a preset name, or a custom #hex value. */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const custom = value.startsWith('#')
  const swatch = (selected: boolean) => `size-7 rounded-full border border-border transition ${selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : 'hover:scale-105'}`
  return (
    <div className="flex flex-col gap-2 text-xs font-medium">
      {label}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={value === ''} onClick={() => onChange('')} className={`h-7 rounded-full border px-3 text-[11px] font-medium ${value === '' ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>Default</button>
        {Object.entries(COLOR_PRESETS).map(([name, hex]) => (
          <button key={name} type="button" title={name} aria-label={name} aria-pressed={value === name} onClick={() => onChange(name)} className={swatch(value === name)} style={{ backgroundColor: hex }} />
        ))}
        <label className={`${swatch(custom)} relative grid cursor-pointer place-items-center overflow-hidden`} title="Custom colour" style={{ background: custom ? value : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}>
          <input type="color" aria-label={`${label} custom colour`} value={HEX_RE.test(value) && value.length === 7 ? value : '#ff8800'} onChange={(event) => onChange(event.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" />
        </label>
      </div>
      {custom && <input type="text" aria-label={`${label} hex code`} value={value} maxLength={7} onChange={(event) => onChange(`#${event.target.value.replace(/[^0-9a-f]/gi, '')}`)} placeholder="#FF8800" className={`h-9 w-28 rounded-lg border bg-background px-3 font-mono text-xs font-normal outline-none focus:border-primary ${HEX_RE.test(value) ? 'border-input' : 'border-destructive'}`} />}
    </div>
  )
}

type CaptionForm = { enabled: boolean; uppercase: 'auto' | 'on' | 'off'; textColor: string; highlightColor: string; size: CaptionOptions['size']; position: CaptionOptions['position']; emoji: boolean }
const DEFAULT_CAPTION_FORM: CaptionForm = { enabled: DEFAULT_CAPTION_OPTIONS.enabled, uppercase: 'auto', textColor: '', highlightColor: '', size: DEFAULT_CAPTION_OPTIONS.size, position: DEFAULT_CAPTION_OPTIONS.position, emoji: DEFAULT_CAPTION_OPTIONS.emoji }

function toCaptionOptions(form: CaptionForm): CaptionOptions {
  const colour = (value: string) => (value === '' ? null : value in COLOR_PRESETS ? COLOR_PRESETS[value as keyof typeof COLOR_PRESETS] : value)
  return { enabled: form.enabled, uppercase: form.uppercase === 'auto' ? 'auto' : form.uppercase === 'on', textColor: colour(form.textColor), highlightColor: colour(form.highlightColor), size: form.size, position: form.position, emoji: form.emoji }
}

export default function Page() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<'upload' | 'url'>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [clipLength, setClipLength] = useState('45')
  const [clipMode, setClipMode] = useState<ClipMode>('sequential')
  const [aspect, setAspect] = useState<Aspect>(DEFAULT_ASPECT)
  const [aspectFit, setAspectFit] = useState<AspectFit>(DEFAULT_ASPECT_FIT)
  const [subtitleStyle, setSubtitleStyle] = useState('bold')
  const [captionForm, setCaptionForm] = useState<CaptionForm>(DEFAULT_CAPTION_FORM)
  const setCaption = <K extends keyof CaptionForm>(key: K, value: CaptionForm[K]) => setCaptionForm((current) => ({ ...current, [key]: value }))
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [openingFolder, setOpeningFolder] = useState(false)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [projects, setProjects] = useState<Job[]>([])
  const [deleting, setDeleting] = useState<string | null>(null)

  const active = job?.status === 'queued' || job?.status === 'processing'
  const jobId = job?.id
  const projectLabel = (item: Job) => item.projectName || (item.sourceName || 'Untitled project').replace(VIDEO_EXT, '')

  const loadProjects = useCallback(() => {
    return apiClient.listJobs().then((items) => {
      setProjects(items)
      setJob((current) => (current ? items.find((item) => item.id === current.id) ?? current : current))
    }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load projects.'))
  }, [])

  useEffect(() => {
    apiClient.getConfig().then(setConfig).catch(() => setConfig(null))
    void loadProjects()
    const last = window.localStorage.getItem(LAST_JOB_KEY)
    if (last) apiClient.getJob(last).then(setJob).catch(() => { window.localStorage.removeItem(LAST_JOB_KEY); setCreating(true) })
    else setCreating(true)
  }, [loadProjects])

  // Poll the job until it finishes.
  useEffect(() => {
    if (!jobId || !active) return
    const timer = window.setInterval(() => {
      apiClient.getJob(jobId).then((updated) => setJob((current) => (current?.id === updated.id ? updated : current))).catch((caught) => {
        setError(caught instanceof Error ? caught.message : 'Lost connection to the processing API.')
        window.clearInterval(timer)
      })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [jobId, active])

  useEffect(() => {
    if (!job) return
    setProjects((current) => {
      const index = current.findIndex((item) => item.id === job.id)
      if (index === -1) return [job, ...current]
      const next = current.slice()
      next[index] = job
      return next
    })
  }, [job])

  const projectPending = projects.some((item) => item.status === 'queued' || item.status === 'processing')
  useEffect(() => {
    if (!projectPending) return
    const timer = window.setInterval(() => { void loadProjects() }, 2500)
    return () => window.clearInterval(timer)
  }, [projectPending, loadProjects])

  const openProject = (item: Job) => {
    setCreating(false)
    setError('')
    setJob(item)
    window.localStorage.setItem(LAST_JOB_KEY, item.id)
    apiClient.getJob(item.id).then(setJob).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to open this project.'))
  }

  const openFolder = async () => {
    if (!job) return
    setOpeningFolder(true)
    try {
      await apiClient.openProjectFolder(job.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to open the project folder.')
    } finally {
      setOpeningFolder(false)
    }
  }
  const forgetOpenProject = () => {
    setJob(null)
    window.localStorage.removeItem(LAST_JOB_KEY)
    setCreating(true)
  }

  const deleteProject = async (item: Job) => {
    const running = item.status === 'queued' || item.status === 'processing'
    const message = `Delete project "${projectLabel(item)}"?\n\nThis permanently removes its folder, the uploaded video and all ${item.clips?.length ?? 0} generated videos.${running ? '\n\nIt is still processing; processing will be stopped.' : ''}\n\nThis cannot be undone.`
    if (!window.confirm(message)) return
    setDeleting(item.id)
    setError('')
    try {
      await apiClient.deleteJob(item.id)
      setProjects((current) => current.filter((project) => project.id !== item.id))
      if (job?.id === item.id) forgetOpenProject()
      await loadProjects()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to delete this project.')
    } finally {
      setDeleting(null)
    }
  }

  const deleteAllProjects = async () => {
    if (!projects.length) return
    if (!window.confirm(`Delete ALL ${projects.length} projects?\n\nThis permanently removes every project folder, uploaded video and generated video.\n\nThis cannot be undone.`)) return
    setDeleting('all')
    setError('')
    try {
      await apiClient.deleteAllJobs()
      setProjects([])
      forgetOpenProject()
      await loadProjects()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to delete the projects.')
    } finally {
      setDeleting(null)
    }
  }

  const deleteClip = async (clipId: string, label: string) => {
    if (!job) return
    if (!window.confirm(`Delete ${label}?\n\nThe video file is permanently removed from this project. This cannot be undone.`)) return
    setDeleting(clipId)
    setError('')
    try {
      const updated = await apiClient.deleteClip(job.id, clipId)
      setJob(updated)
      await loadProjects()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to delete this video.')
    } finally {
      setDeleting(null)
    }
  }

  const normalizedUrl = (() => {
    const value = url.trim()
    if (!value) return ''
    return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`
  })()
  const canSubmit = mode === 'upload' ? Boolean(file) : (() => {
    try {
      const parsed = new URL(normalizedUrl)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
    } catch {
      return false
    }
  })()
  const progress = job?.progress ?? 0
  const orderedClips = useMemo(
    () => [...(job?.clips ?? [])].sort((a, b) => {
      const sequence = (id: string) => Number(/^clip-(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER)
      return sequence(a.id) - sequence(b.id)
    }),
    [job?.clips],
  )

  const statusLabel = useMemo(() => {
    if (isSubmitting) return 'Submitting source'
    if (!job) return 'Ready to create'
    if (job.status === 'queued') return 'Queued for processing'
    if (job.status === 'processing') return job.stage || 'Finding your best moments'
    if (job.status === 'completed') return 'Clips are ready'
    return 'Processing stopped'
  }, [isSubmitting, job])

  const acceptFile = (candidate?: File) => {
    if (!candidate) return
    if (!candidate.type.startsWith('video/') && !VIDEO_EXT.test(candidate.name)) return setError('Choose a video file in MP4, MOV, WebM, or a similar format.')
    if (candidate.size > 2 * 1024 * 1024 * 1024) return setError('Videos must be smaller than 2 GB.')
    setError('')
    setFile(candidate)
  }

  const submit = async () => {
    setError('')
    if (!canSubmit) return setError(mode === 'upload' ? 'Add a video file first.' : 'Enter a valid video URL.')
    for (const [label, value] of [['Text colour', captionForm.textColor], ['Highlight colour', captionForm.highlightColor]]) {
      if (value.startsWith('#') && !HEX_RE.test(value)) return setError(`${label} must be a hex code like #FF8800.`)
    }
    setIsSubmitting(true)
    try {
      const options = { clipLength: Number(clipLength), clipMode, aspect, aspectFit, subtitleStyle, captions: toCaptionOptions(captionForm) }
      const nextJob = mode === 'upload'
        ? await apiClient.createUploadJob(file!, options)
        : await apiClient.createUrlJob(normalizedUrl, options)
      setJob(nextJob)
      setCreating(false)
      window.localStorage.setItem(LAST_JOB_KEY, nextJob.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to submit this job.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    acceptFile(event.dataTransfer.files?.[0])
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => acceptFile(event.target.files?.[0])

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col lg:flex-row">
        <aside className="flex max-h-[46vh] w-full shrink-0 flex-col border-b border-border/70 bg-sidebar/70 px-5 py-5 lg:sticky lg:top-0 lg:h-screen lg:max-h-none lg:w-[300px] lg:border-b-0 lg:border-r lg:px-4">
          <div className="flex items-center gap-3 px-2">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground text-sm font-bold">C</div>
            <div><p className="font-semibold tracking-tight">Cutline</p><p className="text-[11px] text-muted-foreground">AI video studio</p></div>
          </div>
          <button onClick={() => { setCreating(true); setError('') }} className={`mt-6 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${creating ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground transition hover:bg-muted/60 hover:text-foreground'}`}>+ New project</button>
          <p className="mt-6 px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Projects</p>
          <nav className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-2" aria-label="Projects">
            {projects.length ? projects.map((item) => {
              const selected = !creating && job?.id === item.id
              const count = item.clips?.length ?? 0
              const when = item.createdAt ? new Date(item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : item.status
              return (
                <div key={item.id} className="group relative">
                <button onClick={() => openProject(item)} className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 pr-9 text-left ${selected ? 'bg-primary/10 text-primary' : 'text-foreground transition hover:bg-muted/60'}`}>
                  <span className={`grid size-8 shrink-0 place-items-center rounded-lg text-[10px] font-semibold ${selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{item.projectNumber ? String(item.projectNumber).padStart(2, '0') : '•'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{projectLabel(item)}</span>
                    <span className={`mt-0.5 block truncate text-[11px] ${selected ? 'text-primary/80' : 'text-muted-foreground'}`}>{count} {count === 1 ? 'video' : 'videos'} · {when}</span>
                  </span>
                </button>
                <button onClick={() => void deleteProject(item)} disabled={deleting !== null} title="Delete project" aria-label={`Delete project ${projectLabel(item)}`} className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground opacity-60 transition hover:bg-destructive/10 hover:text-destructive hover:opacity-100 focus:opacity-100 disabled:opacity-30 group-hover:opacity-100"><Trash2 className="size-4" /></button>
              </div>
            )
            }) : <p className="px-2 py-3 text-xs leading-5 text-muted-foreground">No projects yet. Each video you create gets its own folder.</p>}
          </nav>
          {projects.length ? <button onClick={() => void deleteAllProjects()} disabled={deleting !== null} className="mt-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"><Trash2 className="size-3.5" />{deleting === 'all' ? 'Deleting...' : 'Delete all projects'}</button> : null}
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-border/70 px-5 py-4 md:px-9">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{creating ? 'New project' : job?.projectNumber ? `Project ${String(job.projectNumber).padStart(3, '0')}` : 'Project'}</p>
              <h1 className="mt-1 truncate text-lg font-semibold tracking-tight">{creating ? 'Create clips' : job ? projectLabel(job) : 'Choose a project'}</h1>
            </div>
            <div className="flex items-center gap-3"><span className="hidden rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground sm:inline">{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span><div className="grid size-8 place-items-center rounded-full bg-muted text-xs font-medium">JD</div></div>
          </header>

          <div className="mx-auto max-w-5xl px-5 py-8 md:px-9 md:py-11">
            {creating ? <>
            <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="mb-2 text-sm font-medium text-primary">New project</p><h2 className="max-w-xl text-3xl font-semibold tracking-[-0.04em] md:text-4xl">Find the moments people will remember.</h2></div><p className="max-w-xs text-sm leading-6 text-muted-foreground">This video becomes one project. Every clip is saved in that project’s folder. The next video gets a new folder.</p></div>

            {config?.notices.length ? <div role="status" className="mb-5 rounded-xl border border-border bg-card/60 px-4 py-3 text-xs leading-5 text-muted-foreground">{config.notices.map((notice) => <p key={notice}>• {notice}</p>)}</div> : null}

            <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
              <section className="rounded-2xl border border-border/80 bg-card/60 p-4 shadow-2xl shadow-black/10 md:p-6">
                <div className="mb-5 flex rounded-xl bg-muted/60 p-1" role="tablist" aria-label="Source type">
                  <button onClick={() => setMode('upload')} className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition ${mode === 'upload' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`} role="tab" aria-selected={mode === 'upload'}>Upload video</button>
                  <button onClick={() => setMode('url')} className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition ${mode === 'url' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`} role="tab" aria-selected={mode === 'url'}>Paste a link</button>
                </div>
                {mode === 'upload' ? <div onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop} className={`flex min-h-[250px] flex-col items-center justify-center rounded-xl border border-dashed px-5 text-center transition ${dragging ? 'border-primary bg-primary/10' : 'border-border bg-background/45'}`}>
                  <input ref={inputRef} type="file" accept="video/*" className="sr-only" onChange={onFileChange} />
                  <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary"><span className="text-xl">↑</span></div>
                  {file ? <><p className="max-w-full truncate text-sm font-medium">{file.name}</p><p className="mt-1 text-xs text-muted-foreground">{formatBytes(file.size)} · Ready to process</p><button onClick={() => setFile(null)} className="mt-4 text-xs font-medium text-primary hover:underline">Choose another video</button></> : <><p className="text-sm font-medium">Drop your video here</p><p className="mt-1 text-xs text-muted-foreground">MP4, MOV, WebM up to 2 GB</p><button onClick={() => inputRef.current?.click()} className="mt-5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:opacity-90">Browse files</button></>}
                </div> : <div className="flex min-h-[250px] flex-col justify-center rounded-xl border border-border bg-background/45 p-6"><label htmlFor="video-url" className="text-sm font-medium">Video URL</label><input id="video-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://youtube.com/watch?v=..." className="mt-3 h-12 rounded-lg border border-input bg-background px-4 text-sm outline-none transition placeholder:text-muted-foreground/60 focus:border-primary focus:ring-2 focus:ring-primary/20" /><p className="mt-3 text-xs leading-5 text-muted-foreground">Only download sources you own or have permission to use. Private and unsupported links are rejected by the server.</p></div>}
                {error && <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">{error}</p>}
              </section>

              <section className="rounded-2xl border border-border/80 bg-card/60 p-5 md:p-6"><div className="mb-6"><p className="text-sm font-semibold">Clip settings</p><p className="mt-1 text-xs text-muted-foreground">Tune the output for your audience.</p></div><div className="flex flex-col gap-5"><label className="flex flex-col gap-2 text-xs font-medium">Clip mode<select value={clipMode} onChange={(event) => setClipMode(event.target.value as ClipMode)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="sequential">Sequential: back-to-back parts of the whole video</option><option value="highlights">Highlights: best moments only</option></select><span className="text-[11px] font-normal leading-4 text-muted-foreground">{clipMode === 'sequential' ? `Clip 1 is 0–${clipLength}s, clip 2 is ${clipLength}–${Number(clipLength) * 2}s, and so on to the end, with nothing skipped.` : `AI picks the most engaging moments, up to about the clip length each. Parts of the video are skipped.`}</span></label><label className="flex flex-col gap-2 text-xs font-medium">{clipMode === 'sequential' ? 'Clip length' : 'Target clip length'}<select value={clipLength} onChange={(event) => setClipLength(event.target.value)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="30">30 seconds</option><option value="45">45 seconds</option><option value="60">60 seconds</option><option value="90">90 seconds</option></select></label><label className="flex flex-col gap-2 text-xs font-medium">Output format<select value={aspect} onChange={(event) => setAspect(event.target.value as Aspect)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary">{ASPECTS.map((value) => <option key={value} value={value}>{ASPECT_LABELS[value]}</option>)}</select><span className="text-[11px] font-normal leading-4 text-muted-foreground">{aspect === 'original' ? 'Clips keep the size of your source video.' : 'Every clip is exactly this size, so it fills the screen on Facebook, Instagram and YouTube Shorts.'}</span></label>{aspect !== 'original' ? <label className="flex flex-col gap-2 text-xs font-medium">Fit<select value={aspectFit} onChange={(event) => setAspectFit(event.target.value as AspectFit)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="crop">Crop: fill the frame (centre crop)</option><option value="blur">Blur: whole picture over a blurred background</option></select></label> : null}<label className="flex flex-col gap-2 text-xs font-medium">Subtitle style<select value={subtitleStyle} onChange={(event) => setSubtitleStyle(event.target.value)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="bold">Bold creator</option><option value="clean">Clean minimal</option><option value="karaoke">Karaoke highlight</option></select></label>
                <div className="flex flex-col gap-4 rounded-xl border border-border/70 bg-background/40 p-4" aria-label="Caption options">
                  <label className="flex items-center justify-between gap-3 text-xs font-medium">Burn in captions<input type="checkbox" checked={captionForm.enabled} onChange={(event) => setCaption('enabled', event.target.checked)} className="size-4 accent-[var(--primary)]" /></label>
                  {captionForm.enabled && <>
                    <ColorField label="Text colour" value={captionForm.textColor} onChange={(value) => setCaption('textColor', value)} />
                    <ColorField label="Highlight colour" value={captionForm.highlightColor} onChange={(value) => setCaption('highlightColor', value)} />
                    <label className="flex flex-col gap-2 text-xs font-medium">Font size<select value={captionForm.size} onChange={(event) => setCaption('size', event.target.value as CaptionForm['size'])} className="h-10 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option><option value="xl">XL</option></select></label>
                    <div className="flex flex-col gap-2 text-xs font-medium">Position<div className="flex rounded-lg bg-muted/60 p-1" role="radiogroup" aria-label="Caption position">{CAPTION_POSITIONS.map((position) => <button key={position} type="button" role="radio" aria-checked={captionForm.position === position} onClick={() => setCaption('position', position)} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${captionForm.position === position ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}>{position}</button>)}</div></div>
                    <label className="flex flex-col gap-2 text-xs font-medium">Letter case<select value={captionForm.uppercase} onChange={(event) => setCaption('uppercase', event.target.value as CaptionForm['uppercase'])} className="h-10 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="auto">Match style</option><option value="on">UPPERCASE</option><option value="off">As spoken</option></select></label>
                    <label className="flex items-center justify-between gap-3 text-xs font-medium"><span>Emoji captions<span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">AI adds fitting emojis to caption lines</span></span><input type="checkbox" checked={captionForm.emoji} onChange={(event) => setCaption('emoji', event.target.checked)} className="size-4 accent-[var(--primary)]" /></label>
                  </>}
                </div><button onClick={submit} disabled={isSubmitting} className="mt-2 flex h-12 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">{isSubmitting ? 'Submitting…' : 'Generate clips'}<span className="ml-2">→</span></button><p className="text-center text-[11px] leading-4 text-muted-foreground">Your original file stays private and is processed on your own server.</p></div></section>
            </div>
            </> : job ? <section className="rounded-2xl border border-border/80 bg-card/40 p-5 md:p-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <p className="text-sm font-semibold">{projectLabel(job)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{statusLabel}{job.createdAt ? ` · ${new Date(job.createdAt).toLocaleString()}` : ''}</p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">All videos from this project are saved in <span className="font-medium text-foreground">{job.clipsFolder || 'this folder'}</span>. The next video you create goes in a new project folder.</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {job.status === 'completed' && orderedClips.length >= 1 ? <a href={`/api/jobs/${encodeURIComponent(job.id)}/download-all`} download className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true"><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M5 21h14" /></svg>Download all ({orderedClips.length})</a> : null}
                  <button onClick={() => void openFolder()} disabled={openingFolder} className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold transition hover:border-primary/50 disabled:opacity-60">{openingFolder ? 'Opening…' : 'Open folder'}</button>
                  <button onClick={() => void deleteProject(job)} disabled={deleting !== null} className="flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-background px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-60"><Trash2 className="size-3.5" />{deleting === job.id ? 'Deleting...' : 'Delete project'}</button>
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{job.status}</span>
                </div>
              </div>
              <div className="mt-5">
                <div className="mb-2 flex justify-between text-xs text-muted-foreground"><span>{job.status === 'failed' ? 'Processing stopped' : job.stage || 'Processing progress'}</span><span>{progress}%</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div>
                {job.status === 'failed' && job.error && <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">{job.error}</p>}
                {job.warnings?.length ? <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs leading-5 text-muted-foreground">{job.warnings.map((warning) => <p key={warning}>• {warning}</p>)}</div> : null}
                {error && <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">{error}</p>}
                {orderedClips.length ? <div className="mt-6 grid gap-4 sm:grid-cols-2"><p className="col-span-full text-sm font-medium">Videos in this project</p>{orderedClips.map((clip, index) => <article key={clip.id} className="overflow-hidden rounded-xl border border-border bg-background"><video controls preload="metadata" src={clip.previewUrl} className="aspect-video w-full bg-black" /><div className="flex items-center justify-between gap-3 p-3"><div><p className="text-xs font-medium">Clip {index + 1}: {clip.title}</p><p className="mt-1 text-[11px] text-muted-foreground">{clip.durationSeconds}s · {clip.sourceEndSeconds !== undefined ? `${clip.sourceStartSeconds}s?${clip.sourceEndSeconds}s` : `${clip.sourceStartSeconds}s`} source{clip.captioned ? ' · captions' : ''}</p>{clip.reason && <p className="mt-1 text-[11px] leading-4 text-muted-foreground/80">{clip.reason}</p>}</div><div className="flex shrink-0 items-center gap-2"><a href={clip.downloadUrl} download={`${index + 1}.mp4`} className="rounded-lg bg-muted px-3 py-2 text-xs font-semibold hover:bg-muted/70">Download</a><button onClick={() => void deleteClip(clip.id, `Clip ${index + 1}`)} disabled={deleting !== null} aria-label={`Delete clip ${index + 1}`} className="flex items-center gap-1 rounded-lg border border-destructive/40 px-3 py-2 text-xs font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-50"><Trash2 className="size-3.5" />{deleting === clip.id ? 'Deleting...' : 'Delete'}</button></div></div></article>)}</div> : <p className="mt-5 text-sm text-muted-foreground">{job.status === 'failed' ? 'No videos were produced.' : 'Videos will appear in this project as soon as they are rendered.'}</p>}
              </div>
            </section> : <div className="rounded-2xl border border-dashed border-border px-5 py-16 text-center"><p className="text-sm font-medium">No project open</p><p className="mt-1 text-xs text-muted-foreground">Start a new project, or pick one from the list. Each video keeps its clips in its own folder.</p><button onClick={() => setCreating(true)} className="mt-5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground">New project</button></div>}
          </div>
        </section>
      </div>
    </main>
  )
}
