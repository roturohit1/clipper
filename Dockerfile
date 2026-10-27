# Cutline on Hugging Face Spaces (Docker SDK). Port 7860, runs as uid 1000 ("node").
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates curl git fontconfig fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
# Monochrome emoji font for emoji captions (optional; skipped if the package is unavailable).
RUN (apt-get update && apt-get install -y --no-install-recommends fonts-symbola && rm -rf /var/lib/apt/lists/*) || true
RUN fc-cache -f

# yt-dlp for YouTube-style links (direct .mp4 links and uploads do not need it).
RUN python3 -m venv /opt/yt-dlp-venv \
 && /opt/yt-dlp-venv/bin/pip install --no-cache-dir "yt-dlp[default]" \
 && ln -s /opt/yt-dlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp \
 && echo '--js-runtimes node' > /etc/yt-dlp.conf

RUN npm install -g pnpm

# Non-secret defaults. Add OPENAI_API_KEY as a Space *secret* (Settings -> Variables and secrets).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=7860 \
    HOME=/home/node \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    OPENAI_BASE_URL=https://api.groq.com/openai/v1 \
    OPENAI_CHAT_MODEL=openai/gpt-oss-120b \
    OPENAI_TRANSCRIPTION_MODEL=whisper-large-v3-turbo \
    TRANSCRIPTION_PROVIDER=auto \
    CLIP_SELECTION_PROVIDER=auto \
    MAX_UPLOAD_MB=1024 \
    MAX_CLIPS=5 \
    JOB_CONCURRENCY=1 \
    ALLOW_PRIVATE_URLS=false

USER node
RUN mkdir -p /home/node/app
WORKDIR /home/node/app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN CI=1 pnpm install --frozen-lockfile

COPY --chown=node:node . .
RUN pnpm build && chmod +x deploy/huggingface/start.sh

EXPOSE 7860
CMD ["./deploy/huggingface/start.sh"]
