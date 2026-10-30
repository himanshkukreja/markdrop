#!/usr/bin/env bash
# Local, deterministic stack for capturing the docs media (frontend/scripts/docs-media).
#
#   stack.sh start     mongod check → sandbox API :8180 → Worker :8787 → next dev :3400
#   stack.sh stop      stop what start started (waits for the ports to be released)
#   stack.sh status    what is up
#   stack.sh logs [api|worker|next]
#
# Everything is local: Mongo 127.0.0.1:27019 (db markdrop_docs_demo), the sandbox API with a fake
# R2 and fake DNS (run_api.py, its own .env — backend/.env is never read), the real artifact Worker
# under Node (worker_dev.mjs), and the real Next app with NEXT_PUBLIC_API_URL pointed at the
# sandbox. The app answers on http://localhost:3400, the docs site on http://docs.localhost:3400,
# and the workspace domain on http://docs.acme.test:3400 (the capture browser maps it to 127.0.0.1).
#
# Env overrides: MONGOD_BIN (start a mongod on :27019 when none is running, data in .data/mongo),
# DOCS_MEDIA_REDIS=1 (start redis-server on :6390 and use it instead of memory://),
# DOCS_MEDIA_NEXT_DIST (default .next-docs-media).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEDIA="$(dirname "$HERE")"
FRONTEND="$(cd "$MEDIA/../.." && pwd)"
REPO="$(dirname "$FRONTEND")"
DATA="${DOCS_MEDIA_DATA:-$MEDIA/.data}"
RUN="$DATA/run"
LOGS="$DATA/logs"
PY="${DOCS_MEDIA_PYTHON:-$REPO/backend/.venv/bin/python}"
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:$PATH"

API_PORT=8180
WORKER_PORT=8787
NEXT_PORT=3400
MONGO_PORT=27019
REDIS_PORT=6390

mkdir -p "$RUN" "$LOGS"
[ -f "$HERE/.env" ] || cp "$HERE/.env.example" "$HERE/.env"

env_value() { # the value of KEY in stack/.env (quotes stripped)
  sed -n "s/^$1=//p" "$HERE/.env" | tail -1 | sed -e "s/^['\"]//" -e "s/['\"]\$//"
}

port_up() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

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
      if ps -o command= -p "$p" | grep -qE "run_api.py|worker_dev.mjs|next|mongod|redis-server"; then kill -TERM "$p" 2>/dev/null || true; fi
    done
    wait_free "$2" || true
  fi
}

cmd_start() {
  echo "docs-media stack"
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
    echo "  ✓ API already on :$API_PORT"
  else
    (cd "$HERE" && start_bg api "$LOGS/api.log" "$PY" "$HERE/run_api.py")
    wait_port $API_PORT 60 API && echo "  ✓ sandbox API  http://127.0.0.1:$API_PORT"
  fi

  # Worker
  if port_up $WORKER_PORT; then
    echo "  ✓ Worker already on :$WORKER_PORT"
  else
    ARTIFACT_SIGNING_KEY="$(env_value MARKDROP_ARTIFACT_SIGNING_KEY)" DOCS_MEDIA_API="http://127.0.0.1:$API_PORT" \
      start_bg worker "$LOGS/worker.log" node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$HERE/worker_dev.mjs"
    wait_port $WORKER_PORT 20 Worker && echo "  ✓ Worker       http://127.0.0.1:$WORKER_PORT"
  fi

  # Next
  if port_up $NEXT_PORT; then
    echo "  ✓ Next already on :$NEXT_PORT"
  else
    # `next dev` with its own distDir rewrites tsconfig.json and next-env.d.ts to point at it:
    # keep the committed versions and put them back once the server is up.
    cp "$FRONTEND/tsconfig.json" "$RUN/tsconfig.json.bak"; cp "$FRONTEND/next-env.d.ts" "$RUN/next-env.d.ts.bak"
    (
      cd "$FRONTEND"
      NEXT_DIST_DIR="${DOCS_MEDIA_NEXT_DIST:-.next-docs-media}" \
      NEXT_PUBLIC_API_URL="http://127.0.0.1:$API_PORT" \
      NEXT_PUBLIC_LIGHT_THEME=true \
      NEXT_PUBLIC_PRIMARY_HOST="localhost:$NEXT_PORT" \
      NEXT_PUBLIC_ANALYTICS_DEV=0 \
      MARKDROP_INTERNAL_SECRET="$(env_value MARKDROP_INTERNAL_SECRET)" \
      NEXT_TELEMETRY_DISABLED=1 \
      start_bg next "$LOGS/next.log" node node_modules/next/dist/bin/next dev --turbo -p $NEXT_PORT
    )
    wait_port $NEXT_PORT 90 Next && curl -s -o /dev/null "http://localhost:$NEXT_PORT/" && sleep 1
    cp "$RUN/tsconfig.json.bak" "$FRONTEND/tsconfig.json"; cp "$RUN/next-env.d.ts.bak" "$FRONTEND/next-env.d.ts"
    echo "  ✓ Next         http://localhost:$NEXT_PORT  ·  docs http://docs.localhost:$NEXT_PORT"
  fi
  echo "  next: seed with  $PY $MEDIA/seed.py   then   npm run docs:media -- <shot ids>"
}

cmd_stop() {
  stop_one next $NEXT_PORT
  stop_one worker $WORKER_PORT
  stop_one api $API_PORT
  stop_one redis $REDIS_PORT
  [ -f "$RUN/mongod.pid" ] && stop_one mongod $MONGO_PORT
  echo "stopped"
}

cmd_status() {
  for pair in "mongod:$MONGO_PORT" "api:$API_PORT" "worker:$WORKER_PORT" "next:$NEXT_PORT"; do
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
