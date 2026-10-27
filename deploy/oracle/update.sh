#!/usr/bin/env bash
# Pull the latest Cutline code, rebuild and restart. Run on the server:
#   sudo bash /opt/cutline/deploy/oracle/update.sh [branch]
# Running jobs are interrupted by the restart, so run it when nothing is processing.
set -Eeuo pipefail
APP_USER=cutline; APP_DIR=/opt/cutline; DATA_DIR=/var/lib/cutline; SERVICE=cutline
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }
trap 'echo "Update failed at line $LINENO." >&2' ERR

git_() { sudo -H -u "$APP_USER" git -C "$APP_DIR" "$@"; }
BRANCH="${1:-$(git_ rev-parse --abbrev-ref HEAD)}"
echo "==> Updating to origin/$BRANCH"
git_ fetch --prune origin "$BRANCH"
OLD="$(git_ rev-parse --short HEAD)"
git_ checkout -q -B "$BRANCH" "origin/$BRANCH"
NEW="$(git_ rev-parse --short HEAD)"
echo "$OLD -> $NEW"

echo "==> Upgrading yt-dlp"
/opt/yt-dlp-venv/bin/pip install --quiet --upgrade "yt-dlp[default]" || echo "yt-dlp upgrade skipped"

echo "==> Building (the site is down for about a minute)"
systemctl stop "$SERVICE"
if sudo -H -u "$APP_USER" env HOME="$DATA_DIR" CI=1 bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile && pnpm build"; then
  systemctl start "$SERVICE"
else
  echo "Build failed; restoring the previous version." >&2
  git_ checkout -q -B "$BRANCH" "$OLD"
  sudo -H -u "$APP_USER" env HOME="$DATA_DIR" CI=1 bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile && pnpm build" || true
  systemctl start "$SERVICE"
  exit 1
fi

for i in $(seq 1 30); do
  curl -fsS -o /dev/null http://127.0.0.1:3000/api/config && { echo "==> Cutline is running at $NEW"; exit 0; }
  sleep 2
done
journalctl -u "$SERVICE" -n 30 --no-pager
echo "The app did not come back up." >&2; exit 1
