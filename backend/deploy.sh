#!/usr/bin/env bash
#
# deploy.sh — pull the latest backend code and restart the Markdrop API.
#
# Usage (on the EC2 host):
#   /opt/markdrop/backend/deploy.sh            # deploy origin/main
#   /opt/markdrop/backend/deploy.sh <branch>   # deploy a specific branch
#
# What it does:
#   1. git fetch + hard-reset to origin/<branch>  (keeps the git-ignored .env)
#   2. reinstall Python deps only if requirements.txt changed
#   3. restart the systemd service
#   4. wait for /health and report; tail logs and exit non-zero on failure
#
set -euo pipefail

APP_DIR="/opt/markdrop/backend"
REPO_DIR="/opt/markdrop"
SERVICE="markdrop"
BRANCH="${1:-main}"
HEALTH_URL="http://127.0.0.1:8080/health"

cd "$REPO_DIR"

echo "▶ Fetching origin/$BRANCH ..."
git fetch --quiet origin "$BRANCH"

OLD_REV="$(git rev-parse HEAD)"
NEW_REV="$(git rev-parse "origin/$BRANCH")"

if [ "$OLD_REV" = "$NEW_REV" ]; then
  echo "  Already up to date at ${NEW_REV:0:7} — nothing to pull."
else
  echo "  ${OLD_REV:0:7} -> ${NEW_REV:0:7}"
  # Detect whether dependencies changed before moving HEAD.
  if git diff --quiet "$OLD_REV" "$NEW_REV" -- backend/requirements.txt; then
    DEPS_CHANGED=0
  else
    DEPS_CHANGED=1
  fi
  git reset --hard "origin/$BRANCH"
fi

# Force a dep install on an up-to-date tree too if you pass FORCE_DEPS=1.
if [ "$OLD_REV" != "$NEW_REV" ] && [ "${DEPS_CHANGED:-0}" = "1" ] || [ "${FORCE_DEPS:-0}" = "1" ]; then
  echo "▶ requirements.txt changed — installing dependencies ..."
  "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip
  "$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"
else
  echo "▶ Dependencies unchanged — skipping pip install (pass FORCE_DEPS=1 to override)."
fi

echo "▶ Restarting $SERVICE ..."
sudo systemctl restart "$SERVICE"

echo "▶ Waiting for health check ..."
for i in $(seq 1 15); do
  if curl -fs --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "✅ Deploy OK — $SERVICE is healthy at ${NEW_REV:0:7}"
    exit 0
  fi
  sleep 1
done

echo "❌ Health check failed after restart. Recent logs:"
sudo journalctl -u "$SERVICE" --no-pager -n 30
exit 1
