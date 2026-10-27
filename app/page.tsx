'use client'

import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient, type AppConfig, type Job } from '@/lib/api'
import { type ClipMode } from '@/lib/clip-mode'
import { CAPTION_POSITIONS, COLOR_PRESETS, DEFAULT_CAPTION_OPTIONS, type CaptionOptions } from '@/lib/captions'

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|flv|ts|mpg|mpeg|3gp|ogv|wmv)$/i
const LAST_JOB_KEY = 'cutline:lastJobId'
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

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
  const [subtitleStyle, setSubtitleStyle] = useState('bold')
  const [captionForm, setCaptionForm] = useState<CaptionForm>(DEFAULT_CAPTION_FORM)
  const setCaption = <K extends keyof CaptionForm>(key: K, value: CaptionForm[K]) => setCaptionForm((current) => ({ ...current, [key]: value }))
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [view, setView] = useState<'workspace' | 'history'>('workspace')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [history, setHistory] = useState<Job[]>([])

  const active = job?.status === 'queued' || job?.status === 'processing'
  const jobId = job?.id

  useEffect(() => {
    apiClient.getConfig().then(setConfig).catch(() => setConfig(null))
    const last = window.localStorage.getItem(LAST_JOB_KEY)
    if (last) apiClient.getJob(last).then(setJob).catch(() => window.localStorage.removeItem(LAST_JOB_KEY))
  }, [])

  // Poll the job until it finishes.
  useEffect(() => {
    if (!jobId || !active) return
    const timer = window.setInterval(() => {
      apiClient.getJob(jobId).then(setJob).catch((caught) => {
        setError(caught instanceof Error ? caught.message : 'Lost connection to the processing API.')
        window.clearInterval(timer)
      })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [jobId, active])

  const loadHistory = useCallback(() => apiClient.listJobs().then(setHistory).catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load history.')), [])
  useEffect(() => { if (view === 'history') void loadHistory() }, [view, loadHistory])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === '1') { event.preventDefault(); setView('workspace') }
      if (event.key === '2') { event.preventDefault(); setView('history') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
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
      const options = { clipLength: Number(clipLength), clipMode, subtitleStyle, captions: toCaptionOptions(captionForm) }
      const nextJob = mode === 'upload'
        ? await apiClient.createUploadJob(file!, options)
        : await apiClient.createUrlJob(normalizedUrl, options)
      setJob(nextJob)
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
        <aside className="flex w-full shrink-0 flex-col border-b border-border/70 bg-sidebar/70 px-5 py-5 lg:w-[230px] lg:border-b-0 lg:border-r lg:px-4">
          <div className="flex items-center gap-3 px-2">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground text-sm font-bold">C</div>
            <div><p className="font-semibold tracking-tight">Cutline</p><p className="text-[11px] text-muted-foreground">AI video studio</p></div>
          </div>
          <nav className="mt-8 flex gap-2 lg:flex-col" aria-label="Main navigation">
            <button onClick={() => setView('workspace')} className={`flex flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-sm lg:flex-none ${view === 'workspace' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground transition hover:bg-muted/60 hover:text-foreground'}`}>Workspace <span className="ml-auto hidden text-[10px] text-muted-foreground lg:inline">⌘ 1</span></button>
            <button onClick={() => setView('history')} className={`flex flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-sm lg:flex-none ${view === 'history' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground transition hover:bg-muted/60 hover:text-foreground'}`}>History <span className="ml-auto hidden text-[10px] lg:inline">⌘ 2</span></button>
          </nav>
          <div className="mt-auto hidden rounded-2xl border border-border/70 bg-card p-4 lg:block">
            <p className="text-xs font-medium">Built for the scroll</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Turn long-form video into clips worth sharing.</p>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-border/70 px-5 py-4 md:px-9">
            <div><p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{view === 'workspace' ? 'Workspace' : 'History'}</p><h1 className="mt-1 text-lg font-semibold tracking-tight">{view === 'workspace' ? 'Create clips' : 'Past projects'}</h1></div>
            <div className="flex items-center gap-3"><span className="hidden rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground sm:inline">Pro workspace</span><div className="grid size-8 place-items-center rounded-full bg-muted text-xs font-medium">JD</div></div>
          </header>

          <div className="mx-auto max-w-5xl px-5 py-8 md:px-9 md:py-11">
            {view === 'history' ? <section className="rounded-2xl border border-border/80 bg-card/40 p-5 md:p-6"><p className="text-sm font-semibold">Past projects</p>{history.length ? <ul className="mt-4 flex flex-col gap-2">{history.map((item) => <li key={item.id}><button onClick={() => { setJob(item); setError(''); window.localStorage.setItem(LAST_JOB_KEY, item.id); setView('workspace') }} className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3 text-left transition hover:border-primary/50"><span className="min-w-0"><span className="block truncate text-sm font-medium">{item.sourceName || item.id}</span><span className="mt-1 block text-[11px] text-muted-foreground">{item.createdAt ? new Date(item.createdAt).toLocaleString() : ''} · {item.clips?.length ?? 0} clips</span></span><span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{item.status}</span></button></li>)}</ul> : <p className="mt-4 text-sm text-muted-foreground">No projects yet. Create your first set of clips from the workspace.</p>}{error && <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">{error}</p>}</section> : <>
            <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="mb-2 text-sm font-medium text-primary">New project</p><h2 className="max-w-xl text-3xl font-semibold tracking-[-0.04em] md:text-4xl">Find the moments people will remember.</h2></div><p className="max-w-xs text-sm leading-6 text-muted-foreground">Upload a recording or paste any public video link. Cutline handles the rest.</p></div>

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

              <section className="rounded-2xl border border-border/80 bg-card/60 p-5 md:p-6"><div className="mb-6"><p className="text-sm font-semibold">Clip settings</p><p className="mt-1 text-xs text-muted-foreground">Tune the output for your audience.</p></div><div className="flex flex-col gap-5"><label className="flex flex-col gap-2 text-xs font-medium">Clip mode<select value={clipMode} onChange={(event) => setClipMode(event.target.value as ClipMode)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="sequential">Sequential: back-to-back parts of the whole video</option><option value="highlights">Highlights: best moments only</option></select><span className="text-[11px] font-normal leading-4 text-muted-foreground">{clipMode === 'sequential' ? `Clip 1 is 0–${clipLength}s, clip 2 is ${clipLength}–${Number(clipLength) * 2}s, and so on to the end, with nothing skipped.` : `AI picks the most engaging moments, up to about the clip length each. Parts of the video are skipped.`}</span></label><label className="flex flex-col gap-2 text-xs font-medium">{clipMode === 'sequential' ? 'Clip length' : 'Target clip length'}<select value={clipLength} onChange={(event) => setClipLength(event.target.value)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="30">30 seconds</option><option value="45">45 seconds</option><option value="60">60 seconds</option><option value="90">90 seconds</option></select></label><label className="flex flex-col gap-2 text-xs font-medium">Subtitle style<select value={subtitleStyle} onChange={(event) => setSubtitleStyle(event.target.value)} className="h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary"><option value="bold">Bold creator</option><option value="clean">Clean minimal</option><option value="karaoke">Karaoke highlight</option></select></label>
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
                </div><button onClick={submit} disabled={isSubmitting || active} className="mt-2 flex h-12 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">{isSubmitting ? 'Submitting…' : active ? 'Processing…' : 'Generate clips'}<span className="ml-2">→</span></button><p className="text-center text-[11px] leading-4 text-muted-foreground">Your original file stays private and is processed on your own server.</p></div></section>
            </div>

            <section className="mt-8 rounded-2xl border border-border/80 bg-card/40 p-5 md:p-6"><div className="flex items-center justify-between"><div><p className="text-sm font-semibold">Latest project</p><p className="mt-1 text-xs text-muted-foreground">{statusLabel}</p></div>{job && <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{job.status}</span>}</div>{job ? <div className="mt-5"><div className="mb-2 flex justify-between text-xs text-muted-foreground"><span>{job.status === 'failed' ? 'Processing stopped' : job.stage || 'Processing progress'}</span><span>{progress}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div>{job.status === 'failed' && job.error && <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">{job.error}</p>}{job.warnings?.length ? <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs leading-5 text-muted-foreground">{job.warnings.map((warning) => <p key={warning}>• {warning}</p>)}</div> : null}{job.clips?.length ? <div className="mt-6 grid gap-4 sm:grid-cols-2"><p className="col-span-full text-sm font-medium">Generated clips</p>{orderedClips.map((clip, index) => <article key={clip.id} className="overflow-hidden rounded-xl border border-border bg-background"><video controls preload="metadata" src={clip.previewUrl} className="aspect-video w-full bg-black" /><div className="flex items-center justify-between gap-3 p-3"><div><p className="text-xs font-medium">Clip {index + 1}: {clip.title}</p><p className="mt-1 text-[11px] text-muted-foreground">{clip.durationSeconds}s · {clip.sourceEndSeconds !== undefined ? `${clip.sourceStartSeconds}s–${clip.sourceEndSeconds}s` : `${clip.sourceStartSeconds}s`} source{clip.captioned ? ' · captions' : ''}</p>{clip.reason && <p className="mt-1 text-[11px] leading-4 text-muted-foreground/80">{clip.reason}</p>}</div><a href={clip.downloadUrl} download className="rounded-lg bg-muted px-3 py-2 text-xs font-semibold hover:bg-muted/70">Download</a></div></article>)}</div> : <p className="mt-5 text-sm text-muted-foreground">{job.status === 'failed' ? 'No clips were produced.' : 'Clip previews will appear here as soon as they are rendered.'}</p>}</div> : <div className="mt-5 rounded-xl border border-dashed border-border px-5 py-8 text-center"><p className="text-sm font-medium">No project yet</p><p className="mt-1 text-xs text-muted-foreground">Your processing queue and finished clips will appear here.</p></div>}</section>
            </>}
          </div>
        </section>
      </div>
    </main>
  )
}
