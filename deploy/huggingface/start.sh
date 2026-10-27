#!/bin/sh
# Start Cutline on a Hugging Face Space.
# Storage: use the persistent bucket at /data when the Space has one attached, else the ephemeral disk.
# Either way, files are lost when the Space restarts unless /data is persistent, so download your clips.
if [ -z "$DATA_DIR" ]; then
  if [ -d /data ] && [ -w /data ]; then DATA_DIR=/data/cutline; else DATA_DIR=/tmp/cutline; fi
fi
mkdir -p "$DATA_DIR"
# Keep yt-dlp current: YouTube breaks old versions often. Disable with YTDLP_AUTO_UPDATE=0.
if [ "${YTDLP_AUTO_UPDATE:-1}" != "0" ]; then
  timeout 90 /opt/yt-dlp-venv/bin/pip install --quiet --disable-pip-version-check -U "yt-dlp[default]" >/dev/null 2>&1 \
    && echo "yt-dlp $(/opt/yt-dlp-venv/bin/yt-dlp --version)" || echo "yt-dlp upgrade skipped"
fi
export DATA_DIR
echo "Cutline: data in $DATA_DIR, port ${PORT:-7860}"
[ -n "$OPENAI_API_KEY" ] || echo "WARNING: OPENAI_API_KEY is not set. Add it as a Space secret to enable captions and AI clip choice."
exec node node_modules/next/dist/bin/next start -p "${PORT:-7860}" -H 0.0.0.0
