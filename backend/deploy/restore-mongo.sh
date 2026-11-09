#!/usr/bin/env bash
#
# restore-mongo.sh — restore a backup-mongo.sh archive into the local MongoDB (replaces what's there).
#
#   sudo backend/deploy/restore-mongo.sh /var/backups/markdrop/mongo-<time>.archive.gz
#
# Stops the API and worker while restoring, then starts them again.
set -euo pipefail
F="${1:?usage: restore-mongo.sh <archive.gz>}"
[ -f "$F" ] || { echo "no such file: $F"; exit 1; }
ADMIN_URI=$(grep '^MONGO_ADMIN_URI=' /etc/markdrop/mongo.env | cut -d= -f2- | tr -d "'")
systemctl stop markdrop-worker markdrop 2>/dev/null || true
/usr/local/bin/mongorestore --uri="$ADMIN_URI" --archive="$F" --gzip --drop --oplogReplay \
  --nsExclude='admin.*' --nsExclude='config.*' --quiet
systemctl start markdrop markdrop-worker 2>/dev/null || true
echo "✓ restored $(basename "$F")"
