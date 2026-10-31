#!/usr/bin/env bash
# Local, deterministic stack for capturing the docs media (frontend/scripts/docs-media).
#
#   [STACK_ID=N] stack.sh start     mongod check → sandbox API → Worker → next dev
#   [STACK_ID=N] stack.sh stop      stop what start started (waits for the ports to be released)
#   [STACK_ID=N] stack.sh status    what is up
#   [STACK_ID=N] stack.sh logs [api|worker|next]
#
# Instances: STACK_ID=N (default 0) runs a separate copy beside the others, so several capture
# runs can work at once without touching each other's data:
#
#                     N = 0 (default)          N ≥ 1
#   sandbox API       :8180                    :8180 + 10N
#   artifact Worker   :8787                    :8787 + 10N
#   next dev          :3400                    :3400 + 10N   (distDir .next-docs-media-N)
#   Markdrop Guides sites :3405                    :3405 + 10N   (docs-platform server over .data/docs-store;
#                                                             builds crawl on :3406 + 10N)
#   Mongo db          markdrop_docs_demo       markdrop_docs_demo_N   (same mongod, :27019)
#   data folder       .data/                   .data/N/   (r2, outbox, dns, fixtures.json, logs, pids)
#
# seed.py and capture.mjs (npm run docs:media) read the same STACK_ID. The rendered demo files in
# .data/fixtures/ are shared.
#
# Everything is local: Mongo 127.0.0.1:27019, the sandbox API with a fake R2 and fake DNS
# (run_api.py, its own .env — backend/.env is never read), the real artifact Worker under Node
# (worker_dev.mjs), and the real Next app with NEXT_PUBLIC_API_URL pointed at the sandbox. The app
# answers on http://localhost:<next port>, the docs site on http://docs.localhost:<next port>, and
# the workspace domain on http://docs.acme.com:<next port> (the capture browser maps it to 127.0.0.1).
#
# Env overrides: MONGOD_BIN (start a mongod on :27019 when none is running, data in .data/mongo),
# DOCS_MEDIA_REDIS=1 (start redis-server on :6390+N and use it instead of memory://),
# DOCS_MEDIA_NEXT_DIST (default .next-docs-media, or .next-docs-media-N).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEDIA="$(dirname "$HERE")"
FRONTEND="$(cd "$MEDIA/../.." && pwd)"
REPO="$(dirname "$FRONTEND")"
STACK_ID="${STACK_ID:-0}"
case "$STACK_ID" in ''|*[!0-9]*) echo "STACK_ID must be a number"; exit 2 ;; esac
export STACK_ID
BASE_DATA="${DOCS_MEDIA_DATA:-$MEDIA/.data}"
if [ "$STACK_ID" = "0" ]; then DATA="$BASE_DATA"; else DATA="$BASE_DATA/$STACK_ID"; fi
RUN="$DATA/run"
LOGS="$DATA/logs"
PY="${DOCS_MEDIA_PYTHON:-$REPO/backend/.venv/bin/python}"
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:$PATH"

API_PORT=$((8180 + 10 * STACK_ID))
WORKER_PORT=$((8787 + 10 * STACK_ID))
NEXT_PORT=$((3400 + 10 * STACK_ID))
SITES_PORT=$((3405 + 10 * STACK_ID))
MONGO_PORT=27019
REDIS_PORT=$((6390 + STACK_ID))
if [ "$STACK_ID" = "0" ]; then NEXT_DIST="${DOCS_MEDIA_NEXT_DIST:-.next-docs-media}"; else NEXT_DIST="${DOCS_MEDIA_NEXT_DIST:-.next-docs-media-$STACK_ID}"; fi
SEED_HINT="$PY $MEDIA/seed.py"
[ "$STACK_ID" = "0" ] || SEED_HINT="STACK_ID=$STACK_ID $SEED_HINT"

mkdir -p "$RUN" "$LOGS" "$BASE_DATA/run"
[ -f "$HERE/.env" ] || cp "$HERE/.env.example" "$HERE/.env"

env_value() { # the value of KEY in stack/.env (quotes stripped)
  sed -n "s/^$1=//p" "$HERE/.env" | tail -1 | sed -e "s/^['\"]//" -e "s/['\"]\$//"
}

port_up() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

# A port that is up must be this instance's own process, or the stack would quietly talk to
# someone else's server (another dev server on :3410, say).
ours() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
taken() { # name port
  echo "  ✗ :$2 is in use by a process this stack ($STACK_ID) didn't start — pick another STACK_ID or free the port"; exit 1
}

wait_port() { # port seconds name
  local i=0
  until port_up "$1"; do
    i=$((i + 1))
    if [ "$i" -gt "$(( $2 * 2 ))" ]; then echo "  ✗ $3 did not open :$1 (see $LOGS)"; return 1; fi
    sleep 0.5
  done
}

wait_free() { # port
  local i=0
  while port_up "$1"; do
    i=$((i + 1)); [ "$i" -gt 40 ] && { echo "  ! :$1 still busy"; return 1; }
    sleep 0.5
  done
}

start_bg() { # name logfile cmd...
  local name="$1" log="$2"; shift 2
  nohup "$@" >"$log" 2>&1 &
  echo $! >"$RUN/$name.pid"
}

stop_one() { # name port
  local pidf="$RUN/$1.pid"
  if [ -f "$pidf" ]; then
    local pid; pid="$(cat "$pidf")"
    if kill -0 "$pid" 2>/dev/null; then
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
    fi
    rm -f "$pidf"
  fi
  if [ -n "${2:-}" ]; then
    # Anything still listening on our port that we started (a dev server's child process).
    local stray; stray="$(lsof -ti tcp:"$2" -sTCP:LISTEN 2>/dev/null || true)"
    for p in $stray; do
      if ps -o command= -p "$p" | grep -qE "run_api.py|run_docs_worker.py|server.mjs|worker_dev.mjs|next|mongod|redis-server"; then kill -TERM "$p" 2>/dev/null || true; fi
    done
    wait_free "$2" || true
  fi
}

cmd_start() {
  echo "docs-media stack $STACK_ID"
  # Mongo
  if port_up $MONGO_PORT; then
    echo "  ✓ mongod on :$MONGO_PORT"
  elif [ -n "${MONGOD_BIN:-}" ]; then
    mkdir -p "$DATA/mongo"
    start_bg mongod "$LOGS/mongod.log" "$MONGOD_BIN" --dbpath "$DATA/mongo" --port $MONGO_PORT --bind_ip 127.0.0.1
    wait_port $MONGO_PORT 30 mongod && echo "  ✓ mongod started on :$MONGO_PORT"
  else
    echo "  ✗ no mongod on 127.0.0.1:$MONGO_PORT — start one, or set MONGOD_BIN=/path/to/mongod"; exit 1
  fi

  # Redis (optional)
  if [ "${DOCS_MEDIA_REDIS:-0}" = "1" ]; then
    if ! port_up $REDIS_PORT; then
      start_bg redis "$LOGS/redis.log" redis-server --port $REDIS_PORT --bind 127.0.0.1 --save "" --appendonly no
      wait_port $REDIS_PORT 10 redis
    fi
    export DOCS_MEDIA_REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
    echo "  ✓ redis on :$REDIS_PORT"
  fi

  # API
  if port_up $API_PORT; then
    ours api || taken api $API_PORT
    echo "  ✓ API already on :$API_PORT"
  else
    (cd "$HERE" && start_bg api "$LOGS/api.log" "$PY" "$HERE/run_api.py")
    wait_port $API_PORT 60 API && echo "  ✓ sandbox API  http://127.0.0.1:$API_PORT"
  fi

  # Worker
  if port_up $WORKER_PORT; then
    ours worker || taken worker $WORKER_PORT
    echo "  ✓ Worker already on :$WORKER_PORT"
  else
    ARTIFACT_SIGNING_KEY="$(env_value MARKDROP_ARTIFACT_SIGNING_KEY)" DOCS_MEDIA_API="http://127.0.0.1:$API_PORT" \
      DOCS_MEDIA_WORKER_PORT=$WORKER_PORT DOCS_MEDIA_NEXT_PORT=$NEXT_PORT \
      start_bg worker "$LOGS/worker.log" node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$HERE/worker_dev.mjs"
    wait_port $WORKER_PORT 20 Worker && echo "  ✓ Worker       http://127.0.0.1:$WORKER_PORT"
  fi

  # Markdrop Guides: the job worker (builds, imports, restores) and the server for published sites
  if ours docsworker; then
    echo "  ✓ Markdrop Guides worker already running"
  else
    start_bg docsworker "$LOGS/docsworker.log" "$PY" "$HERE/run_docs_worker.py"
    echo "  ✓ Markdrop Guides worker (log: $LOGS/docsworker.log)"
  fi
  if port_up $SITES_PORT; then
    ours sites || taken sites $SITES_PORT
    echo "  ✓ Markdrop Guides sites already on :$SITES_PORT"
  else
    PLATFORM="$REPO/docs-platform"
    if [ ! -e "$PLATFORM/node_modules" ]; then
      echo "  ✗ $PLATFORM/node_modules is missing: npm ci there (or symlink another checkout's)"; exit 1
    fi
    [ -f "$PLATFORM/edge/dist/handler.mjs" ] || (cd "$PLATFORM" && node builder/cli.mjs bundle >"$LOGS/sites-bundle.log" 2>&1)
    mkdir -p "$DATA/docs-store"
    start_bg sites "$LOGS/sites.log" node "$PLATFORM/server/server.mjs" serve --store "$DATA/docs-store" --port $SITES_PORT
    wait_port $SITES_PORT 20 "Markdrop Guides sites" && echo "  ✓ Markdrop Guides sites http://<slug>.guides.markdrop.in:$SITES_PORT (capture browser)"
  fi

  # Next
  if port_up $NEXT_PORT; then
    ours next || taken next $NEXT_PORT
    echo "  ✓ Next already on :$NEXT_PORT"
  else
    # `next dev` with its own distDir rewrites tsconfig.json and next-env.d.ts to point at it:
    # keep the committed versions and put them back once the server is up. One backup for every
    # instance, taken only from a clean file, so instances starting together can't save each
    # other's rewrite.
    BAK="$BASE_DATA/run"
    grep -q "next-docs-media" "$FRONTEND/tsconfig.json" || cp "$FRONTEND/tsconfig.json" "$BAK/tsconfig.json.bak"
    grep -q "next-docs-media" "$FRONTEND/next-env.d.ts" || cp "$FRONTEND/next-env.d.ts" "$BAK/next-env.d.ts.bak"
    (
      cd "$FRONTEND"
      NEXT_DIST_DIR="$NEXT_DIST" \
      NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT" \
      NEXT_PUBLIC_LIGHT_THEME=true \
      NEXT_PUBLIC_PRIMARY_HOST="localhost:$NEXT_PORT" \
      NEXT_PUBLIC_ANALYTICS_DEV=0 \
      MARKDROP_INTERNAL_SECRET="$(env_value MARKDROP_INTERNAL_SECRET)" \
      NEXT_TELEMETRY_DISABLED=1 \
      start_bg next "$LOGS/next.log" node node_modules/next/dist/bin/next dev --turbo -p $NEXT_PORT
    )
    wait_port $NEXT_PORT 90 Next && curl -s -o /dev/null "http://localhost:$NEXT_PORT/" && sleep 1
    [ -f "$BAK/tsconfig.json.bak" ] && cp "$BAK/tsconfig.json.bak" "$FRONTEND/tsconfig.json"
    [ -f "$BAK/next-env.d.ts.bak" ] && cp "$BAK/next-env.d.ts.bak" "$FRONTEND/next-env.d.ts"
    echo "  ✓ Next         http://localhost:$NEXT_PORT  ·  docs http://docs.localhost:$NEXT_PORT"
  fi
  echo "  next: seed with  $SEED_HINT   then   $( [ "$STACK_ID" = "0" ] || echo "STACK_ID=$STACK_ID " )npm run docs:media -- <shot ids>"
}

cmd_stop() {
  stop_one next $NEXT_PORT
  stop_one sites $SITES_PORT
  stop_one docsworker
  stop_one worker $WORKER_PORT
  stop_one api $API_PORT
  stop_one redis $REDIS_PORT
  [ -f "$RUN/mongod.pid" ] && stop_one mongod $MONGO_PORT
  echo "stopped"
}

cmd_status() {
  echo "docs-media stack $STACK_ID (data $DATA)"
  for pair in "mongod:$MONGO_PORT" "api:$API_PORT" "worker:$WORKER_PORT" "next:$NEXT_PORT" "sites:$SITES_PORT"; do
    name="${pair%%:*}"; port="${pair##*:}"
    if port_up "$port"; then echo "  ✓ $name :$port"; else echo "  · $name :$port down"; fi
  done
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) tail -n 80 "$LOGS/${2:-api}.log" ;;
  *) echo "usage: stack.sh start|stop|restart|status|logs [api|worker|next]"; exit 2 ;;
esac
