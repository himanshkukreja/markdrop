#!/usr/bin/env bash
#
# install-mongo.sh — MongoDB 8.0 (community build) as a systemd service, for one Markdrop server.
#
#   sudo backend/deploy/install-mongo.sh
#
# - Official tarball, no package repo: works on Ubuntu 22.04+/Debian 12+, x86_64 or arm64.
# - Listens on 127.0.0.1 only, auth on, single-node replica set "rs0" (consistent backups via the oplog).
# - WiredTiger cache 256 MB (MONGO_CACHE_GB) — the box also runs the API.
# - Users: "admin" (root, for backups/restores) and "markdrop" (the app). Passwords are generated once
#   and kept in /etc/markdrop/mongo.env (root, 600); MARKDROP_MONGODB_URI there is what the app's .env uses.
# Idempotent: re-running keeps data, keyfile and passwords.
set -euo pipefail

MONGO_VERSION="${MONGO_VERSION:-8.0.34}"
TOOLS_VERSION="${TOOLS_VERSION:-100.20.1}"
CACHE_GB="${MONGO_CACHE_GB:-0.25}"
PY="${MONGO_PY:-/opt/markdrop/backend/.venv/bin/python}"   # pymongo, for rs.initiate/createUser
CREDS=/etc/markdrop/mongo.env

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }

. /etc/os-release
case "$ID:${VERSION_ID%%.*}" in
  ubuntu:2[4-9]) TARGET=ubuntu2404 ;;
  ubuntu:22)     TARGET=ubuntu2204 ;;
  debian:1[2-9]) TARGET=debian12 ;;
  *) echo "unsupported OS: $ID $VERSION_ID"; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64)        SARCH=x86_64;  TARCH=x86_64 ;;
  aarch64|arm64) SARCH=aarch64; TARCH=arm64 ;;
  *) echo "unsupported arch: $(uname -m)"; exit 1 ;;
esac

fetch() {  # fetch <url> <dest> — verifies the sha256 MongoDB publishes alongside
  local url=$1 dest=$2
  curl -fsSL --retry 3 -o "$dest" "$url"
  local want; want=$(curl -fsSL --retry 3 "$url.sha256" | awk '{print $1}')
  echo "$want  $dest" | sha256sum -c --quiet
}

if [ "$(/usr/local/bin/mongod --version 2>/dev/null | sed -n 's/^db version v//p')" != "$MONGO_VERSION" ]; then
  echo "▶ MongoDB $MONGO_VERSION ($TARGET/$SARCH)"
  tmp=$(mktemp -d)
  fetch "https://fastdl.mongodb.org/linux/mongodb-linux-$SARCH-$TARGET-$MONGO_VERSION.tgz" "$tmp/server.tgz"
  mkdir -p "/opt/mongodb/$MONGO_VERSION"
  tar -xzf "$tmp/server.tgz" -C "/opt/mongodb/$MONGO_VERSION" --strip-components=1
  ln -sfn "/opt/mongodb/$MONGO_VERSION" /opt/mongodb/current
  ln -sf /opt/mongodb/current/bin/mongod /usr/local/bin/mongod
  rm -rf "$tmp"
fi
if ! /usr/local/bin/mongodump --version 2>/dev/null | grep -q "$TOOLS_VERSION"; then
  echo "▶ database tools $TOOLS_VERSION"
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/tools.tgz" \
    "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-$TARGET-$TARCH-$TOOLS_VERSION.tgz"
  mkdir -p "/opt/mongodb/tools-$TOOLS_VERSION"
  tar -xzf "$tmp/tools.tgz" -C "/opt/mongodb/tools-$TOOLS_VERSION" --strip-components=1
  for b in mongodump mongorestore mongoexport mongoimport; do
    ln -sf "/opt/mongodb/tools-$TOOLS_VERSION/bin/$b" "/usr/local/bin/$b"
  done
  rm -rf "$tmp"
fi

id mongodb >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/mongodb --shell /usr/sbin/nologin mongodb
install -d -o mongodb -g mongodb -m 700 /var/lib/mongodb
install -d -m 700 /etc/markdrop
if [ ! -f /etc/mongod.key ]; then
  openssl rand -base64 756 > /etc/mongod.key
fi
chown mongodb:mongodb /etc/mongod.key; chmod 400 /etc/mongod.key

cat > /etc/mongod.conf <<EOF
# Managed by backend/deploy/install-mongo.sh
storage:
  dbPath: /var/lib/mongodb
  wiredTiger:
    engineConfig:
      cacheSizeGB: $CACHE_GB
net:
  bindIp: 127.0.0.1
  port: 27017
security:
  authorization: enabled
  keyFile: /etc/mongod.key
replication:
  replSetName: rs0
  oplogSizeMB: 512
operationProfiling:
  mode: slowOp
  slowOpThresholdMs: 200
EOF

cat > /etc/systemd/system/mongod.service <<'EOF'
# Managed by backend/deploy/install-mongo.sh
[Unit]
Description=MongoDB (Markdrop)
After=network-online.target
Wants=network-online.target
Before=markdrop.service markdrop-worker.service

[Service]
User=mongodb
Group=mongodb
ExecStart=/usr/local/bin/mongod --config /etc/mongod.conf
LimitNOFILE=64000
LimitNPROC=64000
MemoryHigh=600M
MemoryMax=900M
Restart=always
RestartSec=3
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mongod
systemctl restart mongod

for _ in $(seq 60); do
  "$PY" -c "import pymongo; pymongo.MongoClient('mongodb://127.0.0.1:27017/?directConnection=true', serverSelectionTimeoutMS=1000).admin.command('ping')" 2>/dev/null && break
  sleep 1
done

if [ ! -f "$CREDS" ]; then
  umask 077
  {
    echo "MONGO_ADMIN_PASSWORD=$(openssl rand -hex 24)"
    echo "MONGO_APP_PASSWORD=$(openssl rand -hex 24)"
  } > "$CREDS"
fi
# shellcheck disable=SC1090
. "$CREDS"

MONGO_ADMIN_PASSWORD="$MONGO_ADMIN_PASSWORD" MONGO_APP_PASSWORD="$MONGO_APP_PASSWORD" "$PY" - <<'EOF'
import os, time, pymongo
from pymongo.errors import OperationFailure
admin_pw, app_pw = os.environ["MONGO_ADMIN_PASSWORD"], os.environ["MONGO_APP_PASSWORD"]
local = "mongodb://127.0.0.1:27017/?directConnection=true"
c = pymongo.MongoClient(local, serverSelectionTimeoutMS=5000)
try:  # localhost exception: no users yet
    c.admin.command("replSetInitiate", {"_id": "rs0", "members": [{"_id": 0, "host": "127.0.0.1:27017"}]})
    print("  replica set rs0 initiated")
except OperationFailure as e:
    if e.code not in (23, 13):  # AlreadyInitialized / Unauthorized (users exist → initiated before)
        raise
for _ in range(60):
    try:
        if c.admin.command("hello").get("isWritablePrimary"):
            break
    except OperationFailure:
        break  # unauthorized → already set up
    time.sleep(1)
try:
    c.admin.command("createUser", "admin", pwd=admin_pw, roles=["root"])
    print("  user admin created")
except OperationFailure as e:
    if e.code not in (51003, 13):  # UserAlreadyExists / Unauthorized
        raise
a = pymongo.MongoClient(f"mongodb://admin:{admin_pw}@127.0.0.1:27017/?authSource=admin&directConnection=true")
a.admin.command("ping")
roles = [{"role": "readWrite", "db": "markdrop"}, {"role": "dbAdmin", "db": "markdrop"}, {"role": "clusterMonitor", "db": "admin"}]
if a.admin.command("usersInfo", "markdrop")["users"]:
    a.admin.command("updateUser", "markdrop", pwd=app_pw, roles=roles)
else:
    a.admin.command("createUser", "markdrop", pwd=app_pw, roles=roles)
    print("  user markdrop created")
print("  ok:", a.admin.command("replSetGetStatus")["members"][0]["stateStr"])
EOF

grep -q '^MARKDROP_MONGODB_URI=' "$CREDS" || \
  echo "MARKDROP_MONGODB_URI='mongodb://markdrop:${MONGO_APP_PASSWORD}@127.0.0.1:27017/markdrop?authSource=admin&directConnection=true'" >> "$CREDS"
grep -q '^MONGO_ADMIN_URI=' "$CREDS" || \
  echo "MONGO_ADMIN_URI='mongodb://admin:${MONGO_ADMIN_PASSWORD}@127.0.0.1:27017/?authSource=admin&directConnection=true'" >> "$CREDS"
chmod 600 "$CREDS"
echo "✓ mongod $(/usr/local/bin/mongod --version | sed -n 's/^db version //p') on 127.0.0.1:27017 (cache ${CACHE_GB} GB); app URI in $CREDS"
