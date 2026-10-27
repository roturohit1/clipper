// How a video is split into clips. Shared by the UI (client) and the pipeline (server): no Node imports here.

export const CLIP_MODES = ['sequential', 'highlights'] as const
export type ClipMode = (typeof CLIP_MODES)[number]

/** API default when `clip_mode` is omitted (the UI sends `sequential` by default). */
export const DEFAULT_CLIP_MODE: ClipMode = 'highlights'

/** Safety cap for sequential mode (for example a 3 hour video cut into 45 s parts is 240 clips). */
export const MAX_SEQUENTIAL_CLIPS = 300

export function parseClipMode(value: unknown): ClipMode {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_CLIP_MODE
  const v = String(value).trim().toLowerCase()
  if ((CLIP_MODES as readonly string[]).includes(v)) return v as ClipMode
  throw new Error('clip_mode must be sequential or highlights.')
}
