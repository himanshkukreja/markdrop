#!/usr/bin/env bash
# Switch the API from Atlas to the local MongoDB. Run as root once sync-db.py logs "LIVE".
set -uo pipefail
LOG=/tmp/markdrop-sync.log
ENV=/opt/markdrop/backend/.env
grep -q "LIVE" $LOG || { echo "sync not live yet"; exit 1; }
cp -p $ENV "$ENV.bak-atlas-$(date -u +%Y%m%d%H%M%S)"
T0=$(date +%s)
systemctl stop markdrop-worker markdrop
touch /tmp/markdrop-sync.stop
for _ in $(seq 180); do grep -q "^EXIT" $LOG && break; sleep 1; done
tail -6 $LOG
if ! grep -q "^EXIT 0" $LOG; then
  echo "✗ sync did not finish cleanly — restarting on Atlas, nothing changed"
  systemctl start markdrop markdrop-worker
  exit 1
fi
LOCAL_URI=$(grep "^MARKDROP_MONGODB_URI=" /etc/markdrop/mongo.env | cut -d= -f2- | tr -d "'")
LOCAL_URI="$LOCAL_URI" python3 - "$ENV" <<'EOF'
import os, sys
p = sys.argv[1]
lines = open(p).read().splitlines()
out = ['MARKDROP_MONGODB_URI=' + os.environ['LOCAL_URI'] if l.startswith("MARKDROP_MONGODB_URI=") else l for l in lines]
open(p, "w").write("\n".join(out) + "\n")
EOF
cd /opt/markdrop/backend
if ! sudo -u ubuntu .venv/bin/python -c "
from app.config import Settings; import pymongo
s = Settings(); db = pymongo.MongoClient(s.mongodb_uri, serverSelectionTimeoutMS=5000)[s.mongodb_db]
assert '127.0.0.1' in s.mongodb_uri
print('  validated: documents =', db.documents.estimated_document_count())"; then
  echo "✗ validation failed — restoring the Atlas .env"
  cp -p "$(ls -t $ENV.bak-atlas-* | head -1)" $ENV
  systemctl start markdrop markdrop-worker
  exit 1
fi
systemctl start markdrop markdrop-worker
for _ in $(seq 60); do curl -sf -o /dev/null http://127.0.0.1:8080/health && break; sleep 1; done
echo "API back after $(( $(date +%s) - T0 )) s: health $(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8080/health)"
