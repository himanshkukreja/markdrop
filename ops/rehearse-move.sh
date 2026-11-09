#!/usr/bin/env bash
#
# rehearse-move.sh — a full dress rehearsal of ops/move-server.sh against the NEW server, while the OLD one
# keeps serving everyone. Nothing on OLD changes (it is only read: preflight, secrets, pip freeze, the
# database through the tunnel, GeoIP). DNS is not touched; no cut-over happens.
#
#   ops/rehearse-move.sh --from ubuntu@OLD --from-key old.pem --to USER@NEW --to-key new.pem [--keep-live]
#
#   1. move-server.sh prepare, for real: NEW is provisioned and follows OLD's database live.
#   2. NEW checked like the cut-over will need it: arch, Python + every package version identical to OLD,
#      MongoDB cache/limits, swap, nginx + the real certificate over https (curl --resolve), port 80, and
#      per-collection document counts OLD vs NEW while the copy is live.
#   3. Cut-over timing on NEW's side, without the cut-over (skipped with --keep-live):
#        - drain: the copy is stopped the way --cutover stops it (stop file), timed. OLD keeps writing, so a
#          few counts may differ by the writes of those seconds — reported, not a failure.
#        - the API is started on NEW alone (no worker: the worker sends e-mails and runs jobs, and must
#          never run on a copy while OLD is live) against the copied data, timed to /health, probed, stopped.
#      Afterwards NEW holds a snapshot, not a live copy: run move-server.sh (prepare) again before the real
#      --cutover — it re-copies from scratch (~1 min for today's ~400 MB).
#   --keep-live   stop after step 2 and leave the live copy running (keep this Mac awake), e.g. to cut over
#                 right after the rehearsal.
#
# Exit 0 = every check passed. A log is kept next to move-server.sh's (~/.markdrop-move/<NEW>/rehearse.log).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FROM="" FROM_KEY="" TO="" TO_KEY="" KEEP_LIVE=0 PASS=()
DOMAIN="${MARKDROP_DOMAIN:-api.markdrop.in}"
TUNNEL_PORT=27118
while [ $# -gt 0 ]; do
  case $1 in
    --from) FROM=$2; shift 2 ;;
    --from-key) FROM_KEY=$2; shift 2 ;;
    --to) TO=$2; shift 2 ;;
    --to-key) TO_KEY=$2; shift 2 ;;
    --tunnel-port) TUNNEL_PORT=$2; PASS+=(--tunnel-port "$2"); shift 2 ;;
    --keep-live) KEEP_LIVE=1; shift ;;
    --allow-drift|--yes|-y) PASS+=("$1"); shift ;;
    --python|--ref) PASS+=("$1" "$2"); shift 2 ;;
    -h|--help) sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done
[ -n "$FROM" ] && [ -n "$FROM_KEY" ] && [ -n "$TO" ] && [ -n "$TO_KEY" ] || { sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR"
# shellcheck disable=SC2086
on_old() { ssh -n -i "$FROM_KEY" $SSH_OPTS "$FROM" "$@"; }
# shellcheck disable=SC2086
on_new() { ssh -n -i "$TO_KEY" $SSH_OPTS "$TO" "$@"; }
# shellcheck disable=SC2086
pipe_new() { ssh -i "$TO_KEY" $SSH_OPTS "$TO" "$@"; }
STATE="$HOME/.markdrop-move/$(printf '%s' "$TO" | shasum | cut -c1-10)"
FAILS=0
step() { printf '\n▶ %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; FAILS=$((FAILS + 1)); }
warn() { printf '  ! %s\n' "$*"; }
T0=$(date +%s)

# ───────────────────────────────────────────────────────────────────────── 1. the real prepare step
step "1/3 move-server.sh prepare (OLD keeps serving; NEW gets everything and follows the database)"
t=$(date +%s)
"$HERE/move-server.sh" --from "$FROM" --from-key "$FROM_KEY" --to "$TO" --to-key "$TO_KEY" "${PASS[@]+"${PASS[@]}"}"
PREPARE_S=$(( $(date +%s) - t ))
mkdir -p "$STATE"; exec > >(tee -a "$STATE/rehearse.log") 2>&1
echo "──── $(date '+%Y-%m-%d %H:%M:%S') rehearse-move.sh — $FROM → $TO (prepare took ${PREPARE_S} s)"
NEW_IP=$(cat "$STATE/new_ip")

# ─────────────────────────────────────────────────────────────────────────────── 2. checks on NEW
step "2/3 NEW, checked against OLD"
a=$(on_old 'uname -m; /opt/markdrop/backend/.venv/bin/python -V; git -C /opt/markdrop rev-parse HEAD')
b=$(on_new 'uname -m; /opt/markdrop/backend/.venv/bin/python -V; git -C /opt/markdrop rev-parse HEAD')
ok "OLD: $(echo "$a" | tr '\n' ' ' | cut -c1-60)"
ok "NEW: $(echo "$b" | tr '\n' ' ' | cut -c1-60)"
[ "$(echo "$a" | sed -n 3p)" = "$(echo "$b" | sed -n 3p)" ] && ok "same commit" || bad "different commits"
fa=$(on_old '/opt/markdrop/backend/.venv/bin/pip freeze --disable-pip-version-check 2>/dev/null' | sort)
fb=$(on_new '/opt/markdrop/backend/.venv/bin/pip freeze --disable-pip-version-check 2>/dev/null' | sort)
if [ "$fa" = "$fb" ]; then ok "Python packages identical ($(echo "$fb" | wc -l | tr -d ' ') pinned)"
else bad "Python packages differ:"; diff <(echo "$fa") <(echo "$fb") | sed 's/^/      /' | head -20 || true; fi

on_new 'bash -s' <<'REMOTE' | sed 's/^/  /'
echo "✓ $(awk '/MemTotal/{printf "%.1f GB RAM", $2/1048576}' /proc/meminfo), $(nproc) vCPU, swap $(swapon --noheadings --show=SIZE | tr '\n' ' ')"
echo "✓ mongod: $(grep -o 'cacheSizeGB: .*' /etc/mongod.conf), $(systemctl show mongod -p MemoryHigh -p MemoryMax | tr '\n' ' ')"
echo "✓ API unit: $(systemctl show markdrop -p MemoryHigh -p MemoryMax -p User | tr '\n' ' ')"
echo "✓ role $(cat /etc/markdrop/role); enabled: $(for u in markdrop markdrop-worker markdrop-backup.timer; do printf '%s=%s ' $u "$(systemctl is-enabled $u 2>/dev/null)"; done)"
echo "✓ certbot renewal: $(sudo grep -E '^authenticator' /etc/letsencrypt/renewal/*.conf | sed 's#.*/##')"
REMOTE
for u in markdrop markdrop-worker markdrop-backup.timer; do
  [ "$(on_new "systemctl is-active $u" || true)" != active ] || bad "$u is running on NEW before the cut-over"
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:443:$NEW_IP" "https://$DOMAIN/health" || true)
[ "$code" = 502 ] && ok "https://$DOMAIN via $NEW_IP: certificate valid, nginx up (502 = API stopped, as it should be)" \
  || bad "https://$DOMAIN via $NEW_IP answered '$code' (want 502 while on standby)"
c80=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:80:$NEW_IP" "http://$DOMAIN/health" || true)
[ "$c80" = 301 ] && ok "port 80 open (301) — Let's Encrypt renewals will reach NEW once DNS points there" || bad "port 80 on $NEW_IP answered '$c80'"
exp_a=$(on_old "sudo openssl x509 -enddate -noout -in /etc/letsencrypt/live/$DOMAIN/fullchain.pem")
exp_b=$(echo | openssl s_client -connect "$NEW_IP:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -enddate -noout 2>/dev/null || true)
[ "$exp_a" = "$exp_b" ] && ok "NEW serves OLD's certificate (${exp_b#notAfter=})" || bad "certificate on NEW: '$exp_b' vs OLD '$exp_a'"

# live copy: progress + counts
s=$(on_new 'sudo tail -n 2 /var/log/markdrop-move-sync.log; systemctl is-active markdrop-move-sync')
grep -q '^active$' <<<"$s" && ok "copy running: $(printf '%s\n' "$s" | grep LIVE | tail -1 | cut -c1-70)" || bad "the copy is not running"
COUNTS_PY='
import os, pymongo
admin = [l.split("=", 1)[1].strip().strip("\x27\"") for l in open("/etc/markdrop/mongo.env") if l.startswith("MONGO_ADMIN_URI=")][0]
port = os.environ["PORT"]
src = pymongo.MongoClient(admin.replace("127.0.0.1:27017", "127.0.0.1:" + port), serverSelectionTimeoutMS=8000).markdrop
dst = pymongo.MongoClient(admin, serverSelectionTimeoutMS=8000).markdrop
names = sorted(n for n in src.list_collection_names() if not n.startswith("system."))
diff = []
for n in names:
    a, b = src[n].count_documents({}), dst[n].count_documents({})
    if a != b: diff.append(f"{n} {a}/{b}")
print(f"{len(names)} collections, {sum(src[n].estimated_document_count() for n in names)} documents;",
      "all counts equal" if not diff else "differ (OLD/NEW): " + ", ".join(diff[:8]))
'
sleep 20   # let the copy catch up with whatever was written during the checks above
r=$(printf '%s' "$COUNTS_PY" | pipe_new "sudo PORT=$TUNNEL_PORT /opt/markdrop/backend/.venv/bin/python -" 2>&1 || true)
case "$r" in *"all counts equal"*) ok "live copy: $r" ;; *differ*) warn "live copy: $r (in-flight writes; re-checked at the drain)" ;; *) bad "count check failed: $r" ;; esac

if [ "$KEEP_LIVE" = 1 ]; then
  echo
  echo "✓ rehearsal checks done ($FAILS failed, $(( $(date +%s) - T0 )) s). The live copy keeps running (--keep-live)."
  exit $(( FAILS > 0 ))
fi

# ────────────────────────────────────────────────────────────── 3. NEW's half of the cut-over, timed
step "3/3 NEW's half of the cut-over, timed (OLD untouched)"
t=$(date +%s)
on_new 'sudo touch /var/lib/markdrop-move/sync.stop'
for _ in $(seq 90); do
  s=$(on_new 'sudo tail -n 8 /var/log/markdrop-move-sync.log')
  grep -q '^EXIT' <<<"$s" && break
  sleep 1
done
DRAIN_S=$(( $(date +%s) - t ))
printf '%s\n' "$s" | grep -E 'drained|match|✗|EXIT' | sed 's/^/    /'
if grep -q '^EXIT 0' <<<"$s"; then ok "drain + count check: ${DRAIN_S} s, every count matched"
elif grep -q '^EXIT 1' <<<"$s"; then warn "drain: ${DRAIN_S} s; counts differ by OLD's writes during the drain (expected while OLD serves; at the cut-over OLD is stopped first)"
else bad "the copy did not exit cleanly after ${DRAIN_S} s"; fi
on_new 'sudo systemctl stop markdrop-move-sync 2>/dev/null; true'
ssh -S "$STATE/sync-a.sock" -O exit x >/dev/null 2>&1 || true
ssh -S "$STATE/sync-b.sock" -O exit x >/dev/null 2>&1 || true
rm -f "$STATE/sync-a.sock" "$STATE/sync-b.sock"
ok "tunnel closed"

t=$(date +%s)
if on_new 'sudo /opt/markdrop-ops/provision.sh smoke' | sed 's/^/  /'; then
  API_S=$(( $(date +%s) - t ))
  ok "API on the copied data: start → /health → probe → stop in ${API_S} s"
else
  API_S=0; bad "the API did not start on NEW's copy"
fi
echo
echo "rehearsal: prepare ${PREPARE_S} s · drain ${DRAIN_S} s · API start+probe ${API_S} s · checks failed: $FAILS"
echo "estimated cut-over downtime ≈ drain + Redis copy (~2 s) + API/worker start ≈ $(( DRAIN_S + 2 + API_S )) s"
echo "NEW now holds a snapshot (not live). Before the real cut-over, run the prepare step again:"
echo "  ops/move-server.sh --from $FROM --from-key $FROM_KEY --to $TO --to-key $TO_KEY"
exit $(( FAILS > 0 ))
