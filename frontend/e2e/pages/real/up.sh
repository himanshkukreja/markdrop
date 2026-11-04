#!/bin/zsh
# The page builder's real stack, for real.mjs / bughunt.mjs / mcp.mjs / demo.mjs:
#   mongod :27019 · the docs-media sandbox API (this checkout's backend, fake R2 and DNS) :8230 ·
#   the real artifact Worker under Node :8837 · a production build of this frontend (next start) :3450.
#
#   zsh up.sh start | stop | status | mongo | api | worker | build | web | restart-api | restart-web
#
# State (Mongo data, fake R2, seed.json, logs) lives outside the repo, in $PB_WORK/stack
# (default <main checkout>/.work/page-builder). MONGOD_BIN points at a mongod when none is on :27019.
# PB_STACK_ID=N (default 5) runs another instance beside it: API 8180+10N, Worker 8787+10N, next 3400+10N,
# db markdrop_docs_demo_N (run the Playwright scripts with the same PB_STACK_ID).
HERE=${0:A:h}
WT=${HERE:h:h:h:h}
ROOT=${WT%%/.claude/worktrees/*}
WORK=${PB_WORK:-$ROOT/.work/page-builder}
S=$WORK/stack
PY=$ROOT/backend/.venv/bin/python
MONGOD=${MONGOD_BIN:-$S/mongo/mongodb-macos-aarch64-8.0.4/bin/mongod}
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
export STACK_ID=${PB_STACK_ID:-5} DOCS_MEDIA_DATA=$S/data PB_STACK=$S
API_PORT=$((8180 + 10 * STACK_ID)); WORKER_PORT=$((8787 + 10 * STACK_ID)); NEXT_PORT=$((3400 + 10 * STACK_ID))
mkdir -p $S/data
cd $WT/frontend/scripts/docs-media/stack

FRONT_ENV=(NEXT_PUBLIC_API_URL=http://127.0.0.1:$API_PORT NEXT_PUBLIC_ARTIFACT_ORIGIN=http://127.0.0.1:$WORKER_PORT
  NEXT_PUBLIC_PRIMARY_HOST=localhost:$NEXT_PORT NEXT_PUBLIC_LIGHT_THEME=true NEXT_TELEMETRY_DISABLED=1)

up_mongo() {
  nc -z 127.0.0.1 27019 2>/dev/null && return
  mkdir -p $S/mongo/data
  $MONGOD --dbpath $S/mongo/data --port 27019 --bind_ip 127.0.0.1 --fork --logpath $S/mongo/mongod.log --logappend > /dev/null
  echo "mongo up"
}
up_api() {
  [ -f $S/api.pid ] && kill $(cat $S/api.pid) 2>/dev/null
  while nc -z 127.0.0.1 $API_PORT 2>/dev/null; do sleep 0.5; done
  nohup $PY $HERE/api_run.py > $S/api.log 2>&1 &
  echo $! > $S/api.pid
  until curl -sf http://127.0.0.1:$API_PORT/__sandbox/health > /dev/null; do sleep 0.5; done
  echo "api up"
}
up_worker() {
  [ -f $S/worker.pid ] && kill $(cat $S/worker.pid) 2>/dev/null
  while nc -z 127.0.0.1 $WORKER_PORT 2>/dev/null; do sleep 0.5; done
  KEY=$(sed -n 's/^MARKDROP_ARTIFACT_SIGNING_KEY=//p' .env | tr -d "'\"")
  ARTIFACT_SIGNING_KEY=$KEY DOCS_MEDIA_API=http://127.0.0.1:$API_PORT DOCS_MEDIA_WORKER_PORT=$WORKER_PORT DOCS_MEDIA_NEXT_PORT=$NEXT_PORT \
    nohup node worker_dev.mjs > $S/worker.log 2>&1 &
  echo $! > $S/worker.pid
  until nc -z 127.0.0.1 $WORKER_PORT 2>/dev/null; do sleep 0.5; done
  echo "worker up"
}
up_web() {
  [ -f $S/web.pid ] && kill $(cat $S/web.pid) 2>/dev/null
  for pid in $(lsof -ti tcp:$NEXT_PORT -sTCP:LISTEN); do kill $pid; done
  while nc -z 127.0.0.1 $NEXT_PORT 2>/dev/null; do sleep 0.5; done
  cd $WT/frontend
  env $FRONT_ENV nohup ./node_modules/.bin/next start -p $NEXT_PORT > $S/web.log 2>&1 &
  echo $! > $S/web.pid
  until nc -z 127.0.0.1 $NEXT_PORT 2>/dev/null; do sleep 0.5; done
  echo "web up"
}

case "$1" in
  mongo) up_mongo ;;
  api|restart-api) up_api ;;
  worker) up_worker ;;
  web|restart-web) up_web ;;
  build)
    cd $WT/frontend
    env $FRONT_ENV nice -n 10 ./node_modules/.bin/next build > $S/build.log 2>&1
    echo "build exit $?" ;;
  start) up_mongo; up_api; up_worker; up_web ;;
  status)
    for p in 27019 $API_PORT $WORKER_PORT $NEXT_PORT; do nc -z 127.0.0.1 $p 2>/dev/null && echo "$p up" || echo "$p down"; done ;;
  stop)
    for n in api worker web; do
      [ -f $S/$n.pid ] && { kill $(cat $S/$n.pid) 2>/dev/null; rm -f $S/$n.pid; }
    done
    for pid in $(lsof -ti tcp:$NEXT_PORT -sTCP:LISTEN); do kill $pid; done ;;
  *) echo "usage: zsh up.sh start|stop|status|mongo|api|worker|build|web|restart-api|restart-web"; exit 2 ;;
esac
