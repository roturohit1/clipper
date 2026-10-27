'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { apiClient, type JobOptions } from '@/lib/api'
import {
  AUDIO_MODES,
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_WATERMARK,
  WATERMARK_POSITIONS,
  WATERMARK_POSITION_LABELS,
  type AudioMode,
  type BrandingInfo,
  type MusicTrack,
  type WatermarkPosition,
} from '@/lib/branding'

/** Form state for the Branding, Crop & trim and Audio groups. Numbers are strings so inputs can be empty while typing. */
export type ExtrasForm = {
  useLogo: boolean
  text: string
  position: WatermarkPosition
  size: string
  opacity: string
  margin: string
  trimStart: string
  trimEnd: string
  cropTop: string
  cropBottom: string
  cropLeft: string
  cropRight: string
  audioMode: AudioMode
  musicId: string
  musicVolume: string
}

export const DEFAULT_EXTRAS: ExtrasForm = {
  useLogo: false,
  text: '',
  position: DEFAULT_WATERMARK.position,
  size: String(DEFAULT_WATERMARK.sizePct),
  opacity: String(DEFAULT_WATERMARK.opacity),
  margin: String(DEFAULT_WATERMARK.marginPct),
  trimStart: '',
  trimEnd: '',
  cropTop: '',
  cropBottom: '',
  cropLeft: '',
  cropRight: '',
  audioMode: 'original',
  musicId: '',
  musicVolume: String(DEFAULT_MUSIC_VOLUME),
}

const num = (value: string, fallback: number) => {
  const n = Number(value)
  return value.trim() === '' || !Number.isFinite(n) ? fallback : n
}

export function extrasToOptions(form: ExtrasForm): Pick<JobOptions, 'watermark' | 'trim' | 'crop' | 'audio'> {
  const text = form.text.trim()
  const watermark = form.useLogo || text
    ? { logo: form.useLogo, text, position: form.position, sizePct: num(form.size, DEFAULT_WATERMARK.sizePct), opacity: num(form.opacity, DEFAULT_WATERMARK.opacity), marginPct: num(form.margin, DEFAULT_WATERMARK.marginPct) }
    : undefined
  const start = num(form.trimStart, 0)
  const end = num(form.trimEnd, 0)
  const crop = { top: num(form.cropTop, 0), bottom: num(form.cropBottom, 0), left: num(form.cropLeft, 0), right: num(form.cropRight, 0) }
  return {
    watermark,
    trim: start > 0 || end > 0 ? { start, end } : undefined,
    crop: crop.top || crop.bottom || crop.left || crop.right ? crop : undefined,
    audio: { mode: form.audioMode, musicId: form.audioMode === 'original' ? undefined : form.musicId, volumePct: num(form.musicVolume, DEFAULT_MUSIC_VOLUME) },
  }
}

const field = 'h-11 rounded-lg border border-input bg-background px-3 text-sm font-normal outline-none focus:border-primary'
const group = 'flex flex-col gap-4 rounded-xl border border-border/70 bg-background/40 p-4'
const label = 'flex flex-col gap-2 text-xs font-medium'
const hint = 'text-[11px] font-normal leading-4 text-muted-foreground'
const smallButton = 'rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold transition hover:border-primary/50 disabled:opacity-60'

const minutes = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`

export function ExtrasPanels({ value, onChange }: { value: ExtrasForm; onChange: (next: ExtrasForm) => void }) {
  const [branding, setBranding] = useState<BrandingInfo>({ logo: null })
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [busy, setBusy] = useState<'' | 'logo' | 'music'>('')
  const [message, setMessage] = useState('')
  const logoInput = useRef<HTMLInputElement>(null)
  const musicInput = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const set = (patch: Partial<ExtrasForm>) => onChange({ ...value, ...patch })

  const refresh = useCallback(() => {
    apiClient.getBranding().then(setBranding).catch(() => undefined)
    apiClient.listMusic().then(setTracks).catch(() => undefined)
  }, [])
  useEffect(refresh, [refresh])

  const uploadLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy('logo')
    setMessage('')
    try {
      setBranding(await apiClient.uploadLogo(file))
      onChange({ ...valueRef.current, useLogo: true })
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not upload the logo.')
    } finally {
      setBusy('')
    }
  }

  const removeLogo = async () => {
    if (!window.confirm('Remove the saved logo? It will no longer be available for any project.')) return
    setBusy('logo')
    try {
      setBranding(await apiClient.deleteLogo())
      onChange({ ...valueRef.current, useLogo: false })
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not remove the logo.')
    } finally {
      setBusy('')
    }
  }

  const uploadTrack = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy('music')
    setMessage('')
    try {
      const track = await apiClient.uploadMusic(file)
      setTracks(await apiClient.listMusic())
      onChange({ ...valueRef.current, musicId: track.id, audioMode: valueRef.current.audioMode === 'original' ? 'replace' : valueRef.current.audioMode })
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not upload the track.')
    } finally {
      setBusy('')
    }
  }

  const removeTrack = async (track: MusicTrack) => {
    if (!window.confirm(`Delete the track "${track.name}" from your music library?`)) return
    setBusy('music')
    try {
      await apiClient.deleteMusic(track.id)
      setTracks(await apiClient.listMusic())
      if (valueRef.current.musicId === track.id) onChange({ ...valueRef.current, musicId: '' })
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not delete the track.')
    } finally {
      setBusy('')
    }
  }

  const selected = tracks.find((track) => track.id === value.musicId)
  const edge = (name: keyof ExtrasForm, text: string) => (
    <label className={label}>{text}<input type="number" min={0} max={45} step={0.5} inputMode="decimal" placeholder="0" value={value[name] as string} onChange={(event) => set({ [name]: event.target.value } as Partial<ExtrasForm>)} className={field} /></label>
  )

  return (
    <>
      <div className={group}>
        <div><p className="text-sm font-semibold">Branding</p><p className="mt-1 text-xs text-muted-foreground">Add your own logo or page name to every clip. Use only logos and names you own.</p></div>
        <div className="flex flex-wrap items-center gap-3">
          {branding.logo ? <img src={branding.logo.url} alt="Saved logo" className="h-12 max-w-[120px] rounded-md border border-border bg-[repeating-conic-gradient(#8881_0%_25%,transparent_0%_50%)] bg-[length:12px_12px] object-contain p-1" /> : <span className="text-xs text-muted-foreground">No logo saved yet.</span>}
          <input ref={logoInput} type="file" accept="image/png" onChange={(event) => void uploadLogo(event)} className="hidden" />
          <button type="button" onClick={() => logoInput.current?.click()} disabled={busy === 'logo'} className={smallButton}>{busy === 'logo' ? 'Working...' : branding.logo ? 'Replace logo (PNG)' : 'Upload logo (PNG)'}</button>
          {branding.logo ? <button type="button" onClick={() => void removeLogo()} disabled={busy === 'logo'} className={`${smallButton} text-destructive`}>Remove logo</button> : null}
        </div>
        <label className="flex items-center gap-2 text-xs font-medium"><input type="checkbox" checked={value.useLogo && Boolean(branding.logo)} disabled={!branding.logo} onChange={(event) => set({ useLogo: event.target.checked })} />Show the saved logo on clips</label>
        <label className={label}>Text watermark (for example your page name)<input type="text" maxLength={60} value={value.text} onChange={(event) => set({ text: event.target.value })} placeholder="@yourpage" className={field} /></label>
        {value.useLogo || value.text.trim() ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={label}>Position<select value={value.position} onChange={(event) => set({ position: event.target.value as WatermarkPosition })} className={field}>{WATERMARK_POSITIONS.map((position) => <option key={position} value={position}>{WATERMARK_POSITION_LABELS[position]}</option>)}</select></label>
            <label className={label}>Size: {value.size}% of the width<input type="range" min={5} max={60} step={1} value={num(value.size, 18)} onChange={(event) => set({ size: event.target.value })} /></label>
            <label className={label}>Opacity: {value.opacity}%<input type="range" min={10} max={100} step={5} value={num(value.opacity, 85)} onChange={(event) => set({ opacity: event.target.value })} /></label>
            <label className={label}>Margin: {value.margin}% of the width<input type="range" min={0} max={15} step={0.5} value={num(value.margin, 3)} onChange={(event) => set({ margin: event.target.value })} /></label>
            <p className={`${hint} sm:col-span-2`}>The watermark is placed after the output format is applied. Captions move away from it if they would overlap.</p>
          </div>
        ) : null}
      </div>

      <div className={group}>
        <div><p className="text-sm font-semibold">Crop &amp; trim</p><p className="mt-1 text-xs text-muted-foreground">Skip an intro or outro, and cut unwanted edges off the source video before clips are made.</p></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={label}>Skip the first (seconds)<input type="number" min={0} step={1} inputMode="decimal" placeholder="0" value={value.trimStart} onChange={(event) => set({ trimStart: event.target.value })} className={field} /></label>
          <label className={label}>Stop at (seconds, empty = the end)<input type="number" min={0} step={1} inputMode="decimal" placeholder="end of video" value={value.trimEnd} onChange={(event) => set({ trimEnd: event.target.value })} className={field} /></label>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {edge('cropTop', 'Crop top %')}
          {edge('cropBottom', 'Crop bottom %')}
          {edge('cropLeft', 'Crop left %')}
          {edge('cropRight', 'Crop right %')}
        </div>
        <p className={hint}>Trim works with both clip modes: clip 1 starts at the trim start. Edge crop is a percentage of the source picture (0 to 45) and is applied before the output format.</p>
      </div>

      <div className={group}>
        <div><p className="text-sm font-semibold">Audio</p><p className="mt-1 text-xs text-muted-foreground">Keep the original sound, replace it with music, or mix music under the voice.</p></div>
        <label className={label}>Audio<select value={value.audioMode} onChange={(event) => set({ audioMode: event.target.value as AudioMode })} className={field}>
          {AUDIO_MODES.map((mode) => <option key={mode} value={mode}>{mode === 'original' ? 'Original audio' : mode === 'replace' ? 'Replace with music (drop the source audio)' : 'Mix: keep the voice, music ducks under it'}</option>)}
        </select></label>
        {value.audioMode !== 'original' ? (
          <>
            <label className={label}>Track
              <select value={value.musicId} onChange={(event) => set({ musicId: event.target.value })} className={field}>
                <option value="">{tracks.length ? 'Choose a track...' : 'No tracks yet. Upload one below.'}</option>
                {tracks.map((track) => <option key={track.id} value={track.id}>{track.name} ({minutes(track.durationSeconds)})</option>)}
              </select>
            </label>
            {selected ? <div className="flex flex-wrap items-center gap-3"><audio controls preload="none" src={selected.url} className="h-9 max-w-full" /><button type="button" onClick={() => void removeTrack(selected)} disabled={busy === 'music'} className={`${smallButton} text-destructive`}>Delete track</button></div> : null}
            <label className={label}>Music volume: {value.musicVolume}%<input type="range" min={0} max={100} step={5} value={num(value.musicVolume, DEFAULT_MUSIC_VOLUME)} onChange={(event) => set({ musicVolume: event.target.value })} /></label>
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <input ref={musicInput} type="file" accept=".mp3,.wav,audio/mpeg,audio/wav" onChange={(event) => void uploadTrack(event)} className="hidden" />
          <button type="button" onClick={() => musicInput.current?.click()} disabled={busy === 'music'} className={smallButton}>{busy === 'music' ? 'Uploading...' : 'Upload music (MP3 / WAV)'}</button>
          <span className="text-xs text-muted-foreground">{tracks.length} {tracks.length === 1 ? 'track' : 'tracks'} in your library</span>
        </div>
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] leading-4 text-muted-foreground">Only upload music you are licensed to use. Free options: YouTube Audio Library and Pixabay Music. Cutline does not include any music. Tracks loop or trim to each clip and fade in and out.</p>
      </div>
      {message ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">{message}</p> : null}
    </>
  )
}
