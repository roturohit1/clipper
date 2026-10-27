# Cutline — AI video clipping studio

Upload a video (or paste a link), and Cutline finds the best moments, cuts them into short clips,
burns in captions, and lets you preview and download them. Everything runs on **your own machine**
inside this Next.js app — there is no separate backend to deploy.

```
Browser (app/page.tsx)
   │  POST /api/jobs/upload | /api/jobs/url      GET /api/jobs/:id (polled)      GET /api/jobs/:id/clips/:clip
   ▼
Next.js route handlers (app/api/**)  ──►  in-process job queue (lib/server/pipeline.ts)
                                            1. ingest        upload stream to disk / yt-dlp / direct download
                                            2. ffprobe       duration, size, audio?
                                            3. transcribe    OpenAI Whisper API  or  local faster-whisper  or none
                                            4. choose clips  LLM (OpenAI-compatible)  or  free audio-energy heuristic
                                            5. render        ffmpeg: cut + H.264/AAC + burned-in ASS captions
                                          Files + job.json live in DATA_DIR (default ./data/jobs/<id>/)
```

## What works without any API key

Only **FFmpeg** is required. With no keys at all you can upload/import a video and get rendered, downloadable clips,
chosen by audio loudness and speech density (no captions). Add a key *or* local Whisper to get captions and
AI-chosen clips. The UI shows a notice for every feature that is switched off, and why.

| Capability | Needs | Cost |
|---|---|---|
| Upload → cut → preview → download | FFmpeg | free |
| Import from a direct `.mp4`/`.webm` link | nothing extra | free |
| Import from YouTube and similar pages | `yt-dlp` | free |
| Captions (3 styles: bold / clean / karaoke) | OpenAI key **or** local Whisper | paid / free |
| AI picks the best moments | `OPENAI_API_KEY` (or any OpenAI-compatible endpoint) | paid (cheap: `gpt-4o-mini`) |

## Setup

Prerequisites: **Node.js 20.9+**, **pnpm** (`npm i -g pnpm`), **FFmpeg** (with `ffprobe`).

```bash
pnpm install
cp .env.example .env.local      # Windows (cmd): copy .env.example .env.local
# edit .env.local - everything is optional except FFmpeg being installed
pnpm dev                        # http://localhost:3000
# or production mode:
pnpm build && pnpm start
```

### Install FFmpeg
- **Windows:** `winget install Gyan.FFmpeg` (then open a **new** terminal), or download from https://www.gyan.dev/ffmpeg/builds/ , unzip, and either add its `bin` folder to PATH or set `FFMPEG_PATH` / `FFPROBE_PATH` in `.env.local`.
- macOS: `brew install ffmpeg` · Debian/Ubuntu: `sudo apt install ffmpeg`
- Check: `ffmpeg -version` and `ffprobe -version`.

### Optional: yt-dlp (import from YouTube etc.)
Windows: `winget install yt-dlp.yt-dlp` · or `pip install yt-dlp`. Only import videos you own or have permission to use.

### Optional: free local captions (Whisper, no API key)
```bash
python -m pip install faster-whisper "av<17"      # Windows: py -m pip install faster-whisper "av<17"
```
The model (`base`, ~150 MB) downloads on first use, so the first job is slow. Set `LOCAL_WHISPER_PYTHON`
if your Python command is not `python` (e.g. `py`, or a venv's python). `av<17` avoids an incompatibility between
faster-whisper 1.2.x and newer PyAV releases.
If the model download hangs, set the environment variable `HF_HUB_DISABLE_XET=1` and restart.

### Optional: OpenAI (paid) for best captions + AI clip choice
Put your key in `.env.local` (never commit it): `OPENAI_API_KEY=sk-...`. It is used for
Whisper transcription (`whisper-1`) and for choosing clips (`gpt-4o-mini`). Any OpenAI-compatible provider works via
`OPENAI_BASE_URL` (for example a local Ollama at `http://localhost:11434/v1` for the chat part). The transcription model
must support `verbose_json` word timestamps like `whisper-1` (Groq's `whisper-large-v3` does too).

## Environment variables

All variables are documented, with defaults, in [`.env.example`](./.env.example). Summary:

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | *(empty)* | Leave empty to use the built-in API. Set only to point the UI at an external API with the same contract. |
| `DATA_DIR` | `./data` | Uploads, transcripts, clips, job state |
| `MAX_UPLOAD_MB` | `2048` | Upload / import size limit |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Binaries (**required** to exist) |
| `YTDLP_PATH` | `yt-dlp` | Optional link importer |
| `OPENAI_API_KEY` | – | Optional paid key (transcription + clip choice) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` | Model that picks clips |
| `OPENAI_TRANSCRIPTION_MODEL` | `whisper-1` | Model that transcribes |
| `TRANSCRIPTION_PROVIDER` | `auto` | `auto` / `openai` / `local` / `none` |
| `CLIP_SELECTION_PROVIDER` | `auto` | `auto` / `openai` / `heuristic` |
| `MAX_CLIPS` | `5` | Max clips per video |
| `JOB_CONCURRENCY` | `1` | Parallel jobs |
| `LOCAL_WHISPER_PYTHON` / `_MODEL` / `_DEVICE` | `python` / `base` / `cpu` | Local Whisper settings |
| `ALLOW_PRIVATE_URLS` | `false` | Allow importing from localhost/LAN (SSRF guard; testing only) |

`auto` modes pick the best available option and add a visible warning to the job when they fall back. If you force a
provider (`openai`) and the key is missing or rejected, the job fails with a clear message instead.
Env changes need a server restart.

## Test steps

1. Install the prerequisites above, then `pnpm install`, copy `.env.example` to `.env.local`, run `pnpm dev`.
2. Open http://localhost:3000. The banner under the headline lists what is off (captions, AI, yt-dlp) and why.
3. **Automated check** (second terminal, server running): `pnpm smoke` — generates a 75 s sample video with FFmpeg, uploads it,
   waits for processing, downloads the clips, validates them with ffprobe and prints `PASS`.
   Use your own video with `pnpm smoke path\to\video.mp4`.
4. **Manual check in the browser**
   - *Upload video*: drop an MP4 (a 2–10 minute video of someone talking shows captions + AI picking best). Choose clip length and subtitle style → **Generate clips**.
   - Watch the progress bar and stage text; clips appear as they render. Press play to preview; click **Download** to save an MP4.
   - *Paste a link*: use a direct `https://…/video.mp4` URL (or a YouTube URL if yt-dlp is installed).
   - **History** (sidebar) lists past projects; reload the page and your last project is restored.
5. Error paths worth trying: upload a non-video file, paste a bad URL, remove your API key with `TRANSCRIPTION_PROVIDER=openai` — each shows a clear message.
6. Output files are in `data\jobs\<job-id>\clips\`.

`pnpm sample [out.mp4] [seconds]` just creates a test video (colour bars + pulsing tone: no speech, so no captions).
For a speech test video you can record yourself or use any short talking clip.

## API (for reference)

| Method & path | Body | Result |
|---|---|---|
| `GET /api/config` | – | capability report + notices |
| `POST /api/jobs/upload` | multipart: `clip_length` (10–300), `subtitle_style`, [caption options](#caption-options), then `video` | `202` job |
| `POST /api/jobs/url` | JSON `{url, clip_length, subtitle_style, ...caption options}` | `202` job |
| `GET /api/jobs` / `GET /api/jobs/:id` | – | job list / job (`status`, `progress`, `stage`, `warnings`, `clips[]`) |
| `GET /api/jobs/:id/clips/:clipId[?download=1]` | – | MP4 with HTTP Range support |

### Clip mode and caption options

All optional; when omitted the captions look exactly as before. They are fields of both `POST /api/jobs/upload` (multipart, before the `video` field) and `POST /api/jobs/url` (JSON), and the matching controls are in the **Clip settings** panel.

| Field | Values | Default |
|---|---|---|
| `clip_mode` | `sequential` - contiguous parts of `clip_length` seconds covering the whole video (0-45 s, 45-90 s, ... last part = remainder, no AI selection, no clip cap up to 300); `highlights` - AI/energy picks the best moments (up to `MAX_CLIPS`, parts of the video are skipped). The web UI defaults to `sequential`. | `highlights` |
| `captions` | `true` / `false` - burn captions into the clip | `true` |
| `caption_text_color` | `white`, `yellow`, `green`, `cyan`, `pink`, a hex code such as `#FF8800`, or `default` | `default` (white) |
| `caption_highlight_color` | same as above. Karaoke fills words with it as they are spoken (default yellow); Bold/Clean only highlight spoken words when you set one | `default` |
| `caption_size` | `small`, `medium`, `large`, `xl` | `medium` |
| `caption_position` | `top`, `middle`, `bottom` | `bottom` |
| `caption_uppercase` | `auto` (Bold is uppercase, others are not), `true`, `false` | `auto` |
| `caption_emoji` | `true` / `false` - add fitting emojis to caption lines (uses the configured chat model; falls back to a built-in keyword map if there is no key or the model call fails, with a job warning) | `false` |

Emojis are drawn with the Windows "Segoe UI Symbol" font (libass cannot render colour emoji), so they appear as single-colour glyphs in the caption colour.

## Notes and limits

- No auth or database: the project has none in its original design. Jobs are JSON files in `DATA_DIR`; the queue is in-process,
  so a job running during a server restart is marked failed. This is meant for single-user/local use; before exposing it publicly add authentication,
  rate limiting and storage cleanup (clips are never deleted automatically — delete `data/` to reset).
- Clips keep the source aspect ratio (no vertical reframing). Captions are burned in with FFmpeg's libass (needs a build with `libass`; the standard Windows builds have it).
- Imports from private/local network addresses are blocked unless `ALLOW_PRIVATE_URLS=true`.
- `pnpm typecheck` runs TypeScript; the build also type-checks (the old `ignoreBuildErrors` override was removed).

## Troubleshooting

| Message | Fix |
|---|---|
| "ffmpeg/ffprobe were not found" | Install FFmpeg, open a new terminal, or set `FFMPEG_PATH`/`FFPROBE_PATH` |
| "OPENAI_API_KEY is not set" | Add it to `.env.local` and restart, or use `TRANSCRIPTION_PROVIDER=local` / `CLIP_SELECTION_PROVIDER=heuristic` |
| "API key was rejected (401)" | Key is wrong/revoked |
| "Local Whisper is not available" | `python -m pip install faster-whisper "av<17"` or fix `LOCAL_WHISPER_PYTHON` |
| "yt-dlp is not installed" | Install yt-dlp or paste a direct video file link |
| Captions missing but job succeeded | Check the yellow/grey warnings under the job; no speech detected or no transcription provider |
=======
# clipper
this is fully clipper tool that create clips videos from large videos 
