#!/usr/bin/env bash
#
# backup-mongo.sh — consistent backup of the local MongoDB (all databases, with the oplog) to
# /var/backups/markdrop/mongo-<UTC time>.archive.gz; keeps $KEEP_DAYS days. Run by markdrop-backup.timer.
# Restore: sudo backend/deploy/restore-mongo.sh <archive>
# When MARKDROP_BACKUP_R2_BUCKET is set in /etc/markdrop/backup.env (with R2 keys), the archive is
# also uploaded there, so a backup survives losing this server.
set -euo pipefail
umask 077
OUT=/var/backups/markdrop
KEEP_DAYS="${KEEP_DAYS:-14}"
install -d -m 700 "$OUT"
ADMIN_URI=$(grep '^MONGO_ADMIN_URI=' /etc/markdrop/mongo.env | cut -d= -f2- | tr -d "'")
F="$OUT/mongo-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
/usr/local/bin/mongodump --uri="$ADMIN_URI" --oplog --archive="$F.part" --gzip --quiet
mv "$F.part" "$F"
echo "backup $F $(du -h "$F" | cut -f1)"

if [ -f /etc/markdrop/backup.env ]; then
  # shellcheck disable=SC1091
  set -a; . /etc/markdrop/backup.env; set +a
  if [ -n "${MARKDROP_BACKUP_R2_BUCKET:-}" ]; then
    # A failed upload never fails the backup: the local copy is kept either way.
    AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
      /opt/markdrop/backend/.venv/bin/python - "$F" <<'EOF' || echo "R2 upload FAILED (the local copy is kept)"
import os, sys, boto3
f = sys.argv[1]
c = boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com", region_name="auto")
c.upload_file(f, os.environ["MARKDROP_BACKUP_R2_BUCKET"], "mongo/" + os.path.basename(f))
print("uploaded to R2", os.path.basename(f))
EOF
  fi
fi
find "$OUT" -name 'mongo-*.archive.gz' -mtime +"$KEEP_DAYS" -delete
