#!/bin/zsh
# The page editor's round 2 E2E stack, on the REAL backend of this checkout:
#   the docs-media sandbox API (fake R2, its own db markdrop_docs_demo_7) on :8250,
#   the Worker harness (page images, files) on :8857,
#   next dev on :3470.
# Each command runs in the foreground (start them in the background); data lives in
# scripts/docs-media/.data/7 (git-ignored).
#   stack.sh api | worker | web
HERE=${0:A:h}
FRONTEND=${HERE:h:h:h}
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
export STACK_ID=7
LOGS=${PB_LOGS:-$FRONTEND/scripts/docs-media/.data/7/logs}
mkdir -p $LOGS
cd $FRONTEND/scripts/docs-media/stack
case "$1" in
  api) exec ${PB_PYTHON:-$FRONTEND/../backend/.venv/bin/python} run_api.py > $LOGS/api.log 2>&1 ;;
  worker)
    KEY=$(sed -n 's/^MARKDROP_ARTIFACT_SIGNING_KEY=//p' .env | tr -d "'\"")
    ARTIFACT_SIGNING_KEY=$KEY DOCS_MEDIA_API=http://127.0.0.1:8250 DOCS_MEDIA_WORKER_PORT=8857 DOCS_MEDIA_NEXT_PORT=3470 \
      exec node worker_dev.mjs > $LOGS/worker.log 2>&1 ;;
  web)
    cd $FRONTEND
    NEXT_PUBLIC_API_URL=http://127.0.0.1:8250 NEXT_PUBLIC_ARTIFACT_ORIGIN=http://127.0.0.1:8857 NEXT_PUBLIC_PRIMARY_HOST=localhost:3470 \
      NEXT_TELEMETRY_DISABLED=1 exec ./node_modules/.bin/next dev -p 3470 > $LOGS/web.log 2>&1 ;;
  *) echo "usage: stack.sh api|worker|web" >&2; exit 2 ;;
esac
