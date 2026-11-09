#!/usr/bin/env bash
#
# move-sync.sh <port> — run sync-db.py on the NEW server: the old server's mongod (reached through
# the SSH tunnel move-server.sh holds open on 127.0.0.1:<port>) → this server's mongod.
# Started by ops/move-server.sh as the transient unit markdrop-move-sync; log /var/log/markdrop-move-sync.log;
# stop file /var/lib/markdrop-move/sync.stop. Both servers share /etc/markdrop/mongo.env (copied in the
# bundle), so the source URI is this server's admin URI on the tunnel port: no password is passed around.
set -uo pipefail
PORT=${1:?usage: move-sync.sh <tunnel port>}
if [ "$(cat /etc/markdrop/role 2>/dev/null)" != standby ]; then
  echo "EXIT 3 refusing: this server is not a provisioned standby (a copy would replace its data)"; exit 3
fi
ADMIN=$(grep '^MONGO_ADMIN_URI=' /etc/markdrop/mongo.env | cut -d= -f2- | tr -d "'\"")
export DEST_URI="$ADMIN"
export SRC_URI="${ADMIN/127.0.0.1:27017/127.0.0.1:$PORT}"
if [ "$SRC_URI" = "$DEST_URI" ]; then echo "EXIT 2 could not build the source URI"; exit 2; fi
install -d -m 700 /var/lib/markdrop-move
cd /opt/markdrop/backend || exit 1
/opt/markdrop/backend/.venv/bin/python -u /opt/markdrop-ops/sync-db.py --stop-file /var/lib/markdrop-move/sync.stop
rc=$?
echo "EXIT $rc"
exit $rc
