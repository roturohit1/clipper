#!/usr/bin/env bash
# Cutline: one-shot, idempotent installer for an Oracle Cloud Always Free Ampere A1 VM
# (ARM64, Ubuntu 22.04 / 24.04). Safe to run again: it only changes what is missing or different.
#
# Usage (as a normal sudo user, e.g. "ubuntu"):
#   curl -fsSL https://raw.githubusercontent.com/roturohit1/clipper/feature/rohit-clipper/deploy/oracle/setup.sh -o /tmp/cutline-setup.sh \
#     && sudo bash /tmp/cutline-setup.sh --branch feature/rohit-clipper
#
# Options (or the matching environment variables):
#   --branch NAME     git branch to deploy                (BRANCH, default: main)
#   --domain NAME     public domain pointing at this VM   (DOMAIN, default: <ip-with-dashes>.sslip.io)
#   --repo URL        git repository                      (REPO_URL)
#   --auth-user NAME  protect the site with a login       (AUTH_USER) - strongly recommended, see README
#   --auth-pass PASS  password for that login             (AUTH_PASS) - prompted for if only the user is given
# Secrets via environment (never put them on the command line): GROQ_API_KEY (or OPENAI_API_KEY).
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/roturohit1/clipper}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-}"
AUTH_USER="${AUTH_USER:-}"
AUTH_PASS="${AUTH_PASS:-}"
INSTALL_LOCAL_WHISPER="${INSTALL_LOCAL_WHISPER:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --auth-user) AUTH_USER="$2"; shift 2 ;;
    --auth-pass) AUTH_PASS="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

APP_USER=cutline
APP_DIR=/opt/cutline
DATA_DIR=/var/lib/cutline
ENV_DIR=/etc/cutline
ENV_FILE="$ENV_DIR/cutline.env"
SERVICE=cutline
PORT=3000
MAX_UPLOAD_MB="${MAX_UPLOAD_MB:-2048}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "Failed at line $LINENO. Fix the problem and run the script again (it is safe to re-run)."' ERR

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash setup.sh ..."
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "Tested on Ubuntu only (found ${ID:-unknown}); continuing."
ARCH="$(dpkg --print-architecture)"
[ "$ARCH" = "arm64" ] || warn "Expected arm64 (Ampere A1), found $ARCH; continuing."
export DEBIAN_FRONTEND=noninteractive

as_app() { sudo -H -u "$APP_USER" "$@"; }

# Read a value from the terminal even if stdin is not a terminal.
ask() { # ask VAR "prompt" [silent]
  local var="$1" prompt="$2" silent="${3:-}" value=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    if [ -n "$silent" ]; then read -r -s -p "$prompt" value </dev/tty >/dev/tty || true; echo >/dev/tty
    else read -r -p "$prompt" value </dev/tty >/dev/tty || true; fi
  fi
  printf -v "$var" '%s' "$value"
}

# Keep values from a previous run so re-running never asks twice.
env_get() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }

# ---------------------------------------------------------------------------
log "1/9 System packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git ffmpeg python3 python3-pip python3-venv \
  debian-keyring debian-archive-keyring apt-transport-https iptables fontconfig \
  fonts-liberation fonts-dejavu-core
# Monochrome emoji font used for emoji captions (libass cannot draw colour emoji). Optional.
apt-get install -y fonts-symbola >/dev/null 2>&1 || warn "fonts-symbola not available; emoji captions may show blanks."
fc-cache -f >/dev/null 2>&1 || true

# Small VMs (not the 24 GB A1 shape) need swap to survive "next build".
if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 6000 ] && [ ! -f /swapfile ]; then
  log "Low memory detected: adding a 4 GB swap file"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------------------
log "2/9 Node.js 22 and pnpm"
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node_ok || die "Node.js 22.5+ is required (node:sqlite) but found $(node -v 2>/dev/null || echo none)."
NODE_BIN="$(command -v node)"
echo "node $(node -v)"
if ! command -v pnpm >/dev/null 2>&1; then npm install -g pnpm; fi
echo "pnpm $(pnpm -v)"

# ---------------------------------------------------------------------------
log "3/9 yt-dlp (for YouTube-style links)"
python3 -m venv /opt/yt-dlp-venv
/opt/yt-dlp-venv/bin/pip install --quiet --upgrade pip
/opt/yt-dlp-venv/bin/pip install --quiet --upgrade "yt-dlp[default]"
ln -sf /opt/yt-dlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp
# Newer yt-dlp needs a JavaScript runtime for YouTube; Node is already installed.
echo '--js-runtimes node' > /etc/yt-dlp.conf
yt-dlp --version

WHISPER_PY="$(env_get LOCAL_WHISPER_PYTHON)"
if [ "$INSTALL_LOCAL_WHISPER" = "1" ]; then
  log "Installing optional local Whisper (faster-whisper)"
  python3 -m venv /opt/whisper-venv
  /opt/whisper-venv/bin/pip install --quiet --upgrade pip
  /opt/whisper-venv/bin/pip install --quiet faster-whisper "av<17"
  WHISPER_PY=/opt/whisper-venv/bin/python
fi

# ---------------------------------------------------------------------------
log "4/9 App user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR" "$ENV_DIR" "$APP_DIR"
chown "$APP_USER:$APP_USER" "$DATA_DIR" "$APP_DIR"
chmod 750 "$DATA_DIR"

# ---------------------------------------------------------------------------
log "5/9 Fetch the code ($REPO_URL @ $BRANCH)"
if [ -d "$APP_DIR/.git" ]; then
  as_app git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  as_app git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  as_app git -C "$APP_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  [ -z "$(ls -A "$APP_DIR")" ] || die "$APP_DIR exists and is not empty or a git checkout."
  as_app git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
echo "at $(as_app git -C "$APP_DIR" log --oneline -1)"

# ---------------------------------------------------------------------------
log "6/9 Configuration ($ENV_FILE)"
KEY="${GROQ_API_KEY:-${OPENAI_API_KEY:-}}"
[ -n "$KEY" ] || KEY="$(env_get OPENAI_API_KEY)"
if [ -z "$KEY" ]; then
  ask KEY "Paste your Groq API key (starts with gsk_; input is hidden): " silent
fi
[ -n "$KEY" ] || warn "No API key set. Captions and AI clip choice will be off until you add OPENAI_API_KEY to $ENV_FILE and run: systemctl restart $SERVICE"

if [ -z "$DOMAIN" ]; then DOMAIN="$(env_get SITE_DOMAIN)"; fi
if [ -z "$DOMAIN" ]; then
  PUBLIC_IP="$(curl -4fsS --max-time 10 https://api.ipify.org || curl -4fsS --max-time 10 https://ifconfig.me || true)"
  [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Could not detect the public IP. Pass --domain yourname.example.com"
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
fi
echo "site address: https://$DOMAIN"

[ -n "$AUTH_USER" ] || AUTH_USER="$(env_get SITE_AUTH_USER)"
AUTH_HASH="$(env_get SITE_AUTH_HASH)"

umask 027
cat > "$ENV_FILE" <<ENV
# Written by deploy/oracle/setup.sh. Edit, then: sudo systemctl restart $SERVICE
NODE_ENV=production
DATA_DIR=$DATA_DIR
MAX_UPLOAD_MB=$MAX_UPLOAD_MB
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
YTDLP_PATH=/usr/local/bin/yt-dlp
OPENAI_API_KEY=$KEY
OPENAI_BASE_URL=${OPENAI_BASE_URL:-$(env_get OPENAI_BASE_URL | grep . || echo https://api.groq.com/openai/v1)}
OPENAI_CHAT_MODEL=${OPENAI_CHAT_MODEL:-$(env_get OPENAI_CHAT_MODEL | grep . || echo openai/gpt-oss-120b)}
OPENAI_TRANSCRIPTION_MODEL=${OPENAI_TRANSCRIPTION_MODEL:-$(env_get OPENAI_TRANSCRIPTION_MODEL | grep . || echo whisper-large-v3-turbo)}
TRANSCRIPTION_PROVIDER=${TRANSCRIPTION_PROVIDER:-$(env_get TRANSCRIPTION_PROVIDER | grep . || echo auto)}
CLIP_SELECTION_PROVIDER=${CLIP_SELECTION_PROVIDER:-$(env_get CLIP_SELECTION_PROVIDER | grep . || echo auto)}
MAX_CLIPS=${MAX_CLIPS:-$(env_get MAX_CLIPS | grep . || echo 5)}
JOB_CONCURRENCY=${JOB_CONCURRENCY:-$(env_get JOB_CONCURRENCY | grep . || echo 1)}
ALLOW_PRIVATE_URLS=false
${WHISPER_PY:+LOCAL_WHISPER_PYTHON=$WHISPER_PY}
# Used only by setup.sh / update.sh (not by the app):
SITE_DOMAIN=$DOMAIN
SITE_AUTH_USER=$AUTH_USER
ENV
chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
umask 022

# ---------------------------------------------------------------------------
log "7/9 Build"
as_app env HOME="$DATA_DIR" CI=1 bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile && pnpm build"

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Cutline (video clipper)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=HOME=$DATA_DIR
ExecStart=$NODE_BIN $APP_DIR/node_modules/next/dist/bin/next start -p $PORT -H 127.0.0.1
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR $APP_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

# ---------------------------------------------------------------------------
log "8/9 Firewall (Oracle's Ubuntu image blocks everything except SSH in iptables)"
echo iptables-persistent iptables-persistent/autosave_v4 boolean false | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean false | debconf-set-selections
apt-get install -y iptables-persistent netfilter-persistent
open_port() { # open_port tcp 80
  local proto="$1" port="$2"
  iptables -C INPUT -p "$proto" -m "$proto" --dport "$port" -j ACCEPT 2>/dev/null && return 0
  # Insert ahead of the first REJECT/DROP rule so it is not shadowed.
  local idx
  idx="$(iptables -S INPUT | grep '^-A INPUT' | grep -n -m1 -E -- '-j (REJECT|DROP)' | cut -d: -f1 || true)"
  if [ -n "$idx" ]; then iptables -I INPUT "$idx" -p "$proto" -m "$proto" --dport "$port" -j ACCEPT
  else iptables -A INPUT -p "$proto" -m "$proto" --dport "$port" -j ACCEPT; fi
}
open_port tcp 80
open_port tcp 443
open_port udp 443
netfilter-persistent save
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp; fi

# ---------------------------------------------------------------------------
log "9/9 Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# Optional login in front of the whole site.
AUTH_BLOCK=""
if [ -n "$AUTH_USER" ]; then
  if [ -n "$AUTH_PASS" ]; then AUTH_HASH="$(caddy hash-password --plaintext "$AUTH_PASS")"
  elif [ -z "$AUTH_HASH" ]; then
    ask AUTH_PASS "Choose a password for user '$AUTH_USER' (hidden): " silent
    [ -n "$AUTH_PASS" ] || die "A password is required when --auth-user is set."
    AUTH_HASH="$(caddy hash-password --plaintext "$AUTH_PASS")"
  fi
  sed -i '/^SITE_AUTH_HASH=/d' "$ENV_FILE"; echo "SITE_AUTH_HASH=$AUTH_HASH" >> "$ENV_FILE"
  AUTH_BLOCK="
  basic_auth {
    $AUTH_USER $AUTH_HASH
  }"
else
  warn "No login configured: anyone who finds the URL can use your Groq key. Re-run with --auth-user NAME to add one."
fi

# Body limit = MAX_UPLOAD_MB plus multipart overhead (Caddy MB = 1,000,000 bytes).
BODY_MB=$(( MAX_UPLOAD_MB * 1049 / 1000 + 50 ))
cat > /etc/caddy/Caddyfile <<CADDY
# Written by deploy/oracle/setup.sh
$DOMAIN {
  encode zstd gzip$AUTH_BLOCK

  request_body {
    max_size ${BODY_MB}MB
  }

  reverse_proxy 127.0.0.1:$PORT {
    flush_interval -1
  }
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ---------------------------------------------------------------------------
log "Checks"
ffmpeg -hide_banner -filters 2>/dev/null | grep -qE '\bass\b' || warn "This ffmpeg has no 'ass' filter: burned-in captions will fail."
for i in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/config" && { echo "app is up on 127.0.0.1:$PORT"; break; }
  sleep 2
  [ "$i" -lt 30 ] || { journalctl -u "$SERVICE" -n 30 --no-pager; die "The app did not start. See the log above."; }
done

printf '\n\033[1;32mDone.\033[0m Open  https://%s\n' "$DOMAIN"
echo "(The first visit can take ~30 s while Caddy gets the HTTPS certificate. Ports 80 and 443 must also be open in the Oracle VCN security list.)"
echo "Logs:    journalctl -u $SERVICE -f        Config: $ENV_FILE        Data: $DATA_DIR"
echo "Update:  sudo bash $APP_DIR/deploy/oracle/update.sh"
