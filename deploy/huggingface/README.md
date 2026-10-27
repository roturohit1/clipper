---
title: Cutline
emoji: ✂️
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Cutline on Hugging Face Spaces

Cutline turns a long video into captioned short clips. This folder deploys it as a **Docker Space** (free CPU: 2 vCPU, 16 GB RAM, port 7860).

> Hugging Face reads the Space settings from the **front-matter at the top of the Space's root `README.md`** (the block above, `sdk: docker`, `app_port: 7860`). This file is that README. When you push to the Space, the steps below put it at the root.

## 1. Create the Space

1. Go to <https://huggingface.co/new-space>.
2. **Space name:** `cutline`. **SDK:** *Docker* → *Blank*. **Hardware:** *CPU basic · 2 vCPU · 16 GB · Free*.
3. **Visibility: choose _Private_.** Cutline has no login of its own. In a public Space anyone who finds the URL can burn your Groq quota. (A private Space is only reachable while you are signed in to Hugging Face.)
4. Click **Create Space**.

## 2. Add your secret

Space → **Settings** → **Variables and secrets** → **New secret**:

| Name | Value |
| --- | --- |
| `OPENAI_API_KEY` | your Groq key (`gsk_…`) |

Everything else already has a default in the `Dockerfile` (no secrets): `OPENAI_BASE_URL=https://api.groq.com/openai/v1`, `OPENAI_CHAT_MODEL=openai/gpt-oss-120b`, `OPENAI_TRANSCRIPTION_MODEL=whisper-large-v3-turbo`, `MAX_UPLOAD_MB=1024`, `MAX_CLIPS=5`, `JOB_CONCURRENCY=1`. To change one, add it under **Variables** with the same name.

## 3. Push the code to the Space

Create a **write** token at <https://huggingface.co/settings/tokens>. Then run this in PowerShell (replace `YOURNAME` and the token). It works in a fresh copy, so it does not touch your project folder:

```powershell
$env:HF_TOKEN = "hf_..."          # do not commit or share this
git clone --branch feature/rohit-clipper --single-branch https://github.com/roturohit1/clipper cutline-space
cd cutline-space
Copy-Item deploy\huggingface\README.md README.md -Force
git add README.md
git commit -m "Space config"
git push --force "https://YOURNAME:$($env:HF_TOKEN)@huggingface.co/spaces/YOURNAME/cutline" HEAD:main
```

The Space builds the image (about 5-8 minutes the first time). Watch **Logs** → **Build**. When it says **Running**, open the app from the Space page.

To update later, delete the `cutline-space` folder and run the same block again.

## What to know

- **Storage is temporary.** Uploads and clips live on the Space's disk and are **deleted when the Space restarts or sleeps** (free Spaces sleep after about 48 hours without visitors). Download clips you want to keep. If you attach a persistent *Storage Bucket* mounted at `/data`, Cutline uses `/data/cutline` automatically; otherwise it uses `/tmp/cutline`.
- **Upload size.** The default limit is 1024 MB. Large uploads over the Space proxy can be slow or time out; for big files, paste a direct video link instead.
- **YouTube links** are blocked from Hugging Face's datacenter IPs by default ("Sign in to confirm you're not a bot"). Add YouTube cookies (next section) to make them work. Uploads and direct `.mp4` links never need cookies.
- **Speed.** 2 vCPUs encode slower than a laptop; a 3-minute video takes roughly a few minutes to cut and caption.
- **Runs as user 1000** (the Dockerfile's `node` user), as Hugging Face requires.
- **Logs:** Space page → **Logs** → **Container**.

## YouTube links: add cookies

YouTube refuses anonymous downloads from cloud servers. Giving Cutline the cookies of a signed-in YouTube session fixes it.

1. **Use a throwaway Google account** (not your main one). Downloading with cookies can get an account flagged, and these cookies give access to that account.
2. In Chrome or Firefox, open a **private/incognito window**, sign in to <https://www.youtube.com> with that account, then in the *same* window open `https://www.youtube.com/robots.txt` (this stops YouTube from rotating the cookies).
3. Install the extension **Get cookies.txt LOCALLY** (Chrome) or **cookies.txt** (Firefox), open it on the youtube.com tab and **Export** (Netscape format). Close the private window afterwards without signing out.
4. Convert the file to one line so it pastes cleanly. In PowerShell:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\cookies.txt")) | Set-Clipboard
   ```
5. In the Space: **Settings** → **Variables and secrets** → **New secret**: name `YTDLP_COOKIES_B64`, value = paste. (Pasting the raw file as `YTDLP_COOKIES` also works; Cutline repairs lost tabs and the header.) The Space restarts.
6. Paste a YouTube link in Cutline. If it later says the cookies expired, repeat steps 2-5.

Cutline writes the cookies to a private temp file (permissions 600) and passes `--cookies` to yt-dlp. They are never logged or stored in the repo.

Other settings (all optional, Space variables):

| Name | Effect |
| --- | --- |
| `YTDLP_COOKIES_FILE` | path to a cookies.txt already on disk (instead of the secrets above) |
| `YTDLP_PROXY` | e.g. `http://user:pass@host:port`: a residential proxy is the most reliable fix if Hugging Face's IPs stay blocked even with cookies |
| `YTDLP_EXTRA_ARGS` | replaces the default `--extractor-args youtube:player_client=web_safari,mweb,tv`; set to `none` to pass nothing |
| `YTDLP_AUTO_UPDATE` | `0` stops the automatic yt-dlp upgrade at every boot (default: upgrade) |

**Honest limits:** cookies are not a guarantee. YouTube may still block shared Hugging Face IPs, and cookies expire after days to weeks. Uploading the file always works.
