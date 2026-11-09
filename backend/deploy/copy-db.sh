#!/usr/bin/env bash
#
# copy-db.sh — copy the Markdrop database from one MongoDB to another and check every collection's count.
#
#   SRC_URI=… DEST_URI=… backend/deploy/copy-db.sh [db]          (db defaults to markdrop)
#
# The URIs come from the environment so passwords never appear in `ps` or shell history.
# Dumps to a gzip archive in /var/backups/markdrop (kept), restores it with --drop, then compares
# document counts per collection. Exits non-zero on any mismatch.
set -euo pipefail
DB="${1:-markdrop}"
: "${SRC_URI:?set SRC_URI}" "${DEST_URI:?set DEST_URI}"
PY="${MONGO_PY:-/opt/markdrop/backend/.venv/bin/python}"
OUT=/var/backups/markdrop
sudo install -d -o "$(id -u)" -m 700 "$OUT"
ARCHIVE="$OUT/copy-$DB-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"

"$PY" - <<'EOF' || { echo "✗ SRC_URI and DEST_URI reach the same server (check the tunnel)"; exit 1; }
import os, sys, pymongo
def ident(uri):
    c = pymongo.MongoClient(uri, serverSelectionTimeoutMS=10000)
    return (c.admin.command("hostInfo")["system"].get("hostname"),
            c.admin.command("serverStatus", repl=0, metrics=0, locks=0).get("pid"))
sys.exit(1 if ident(os.environ["SRC_URI"]) == ident(os.environ["DEST_URI"]) else 0)
EOF

t0=$(date +%s)
echo "▶ dump $DB"
mongodump --uri="$SRC_URI" --db="$DB" --archive="$ARCHIVE" --gzip --quiet
t1=$(date +%s)
echo "  $(du -h "$ARCHIVE" | cut -f1) in $((t1 - t0)) s"
echo "▶ restore"
mongorestore --uri="$DEST_URI" --archive="$ARCHIVE" --gzip --drop --nsInclude="$DB.*" --quiet
t2=$(date +%s)
echo "  in $((t2 - t1)) s"

echo "▶ compare counts"
DB="$DB" "$PY" - <<'EOF'
import os, sys, pymongo
db = os.environ["DB"]
src = pymongo.MongoClient(os.environ["SRC_URI"])[db]
dst = pymongo.MongoClient(os.environ["DEST_URI"])[db]
names = sorted(n for n in src.list_collection_names() if not n.startswith("system."))
bad = []
for n in names:
    a, b = src[n].count_documents({}), dst[n].count_documents({})
    ia, ib = len(list(src[n].list_indexes())), len(list(dst[n].list_indexes()))
    if a != b or ia != ib:
        bad.append(f"{n}: docs {a}→{b}, indexes {ia}→{ib}")
missing = set(names) - set(dst.list_collection_names())
print(f"  {len(names)} collections, {sum(src[n].estimated_document_count() for n in names)} documents")
for line in bad: print("  ✗", line)
for n in missing: print("  ✗ missing", n)
sys.exit(1 if bad or missing else 0)
EOF
echo "✓ copied $DB in $(( $(date +%s) - t0 )) s ($ARCHIVE)"
