#!/bin/zsh
# The Pages loop's stack: the page builder mock API on :$MOCK_PORT and `next dev` of this checkout's
# frontend on :$APP_PORT, pointed at it. Logs and pids in $DATA (default ./.data, git-ignored).
#
#   zsh stack.sh up       MOCK=<server.mjs> (default: the main checkout's .work/page-builder/mock/server.mjs)
#   zsh stack.sh down
#
# Ports: MOCK_PORT=8797 APP_PORT=3197 (record.mjs reads APP / API with the same defaults).
H=${0:A:h}
FE=${H:h:h:h}
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
MOCK=${MOCK:-/Users/himanshukukreja/markdrop/.work/page-builder/mock/server.mjs}
MOCK_PORT=${MOCK_PORT:-8797}
APP_PORT=${APP_PORT:-3197}
D=${DATA:-$H/.data}
mkdir -p $D
case "$1" in
  up)
    [ -f "$MOCK" ] || { echo "no mock server at $MOCK (set MOCK=)"; exit 1; }
    MOCK_PORT=$MOCK_PORT MOCK_APP=http://localhost:$APP_PORT nohup node $MOCK > $D/mock.log 2>&1 &
    echo $! > $D/mock.pid
    cd $FE
    NEXT_PUBLIC_API_URL=http://127.0.0.1:$MOCK_PORT NEXT_PUBLIC_ARTIFACT_ORIGIN=http://127.0.0.1:$MOCK_PORT \
      NEXT_PUBLIC_PRIMARY_HOST=localhost:$APP_PORT NEXT_PUBLIC_LIGHT_THEME=true NEXT_TELEMETRY_DISABLED=1 \
      nohup npx next dev -p $APP_PORT > $D/next.log 2>&1 &
    echo $! > $D/next.pid
    until curl -sf -o /dev/null http://localhost:$APP_PORT/; do sleep 1; done
    echo "up: app http://localhost:$APP_PORT  api http://127.0.0.1:$MOCK_PORT" ;;
  down)
    for n in mock next; do
      if [ -f $D/$n.pid ]; then
        pkill -TERM -P $(cat $D/$n.pid) 2>/dev/null
        kill $(cat $D/$n.pid) 2>/dev/null
        rm -f $D/$n.pid
      fi
    done
    for pid in $(lsof -ti tcp:$APP_PORT -sTCP:LISTEN) $(lsof -ti tcp:$MOCK_PORT -sTCP:LISTEN); do kill $pid; done ;;
esac
