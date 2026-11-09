#!/usr/bin/env bash
#
# move-server.sh — move the whole Markdrop API server (API + worker, nginx + TLS, MongoDB, Redis, GeoIP,
# backups, secrets) from one Linux VM to another. Runs on the owner's Mac; see ops/MOVE-SERVER.md.
#
#   1. prepare (re-runnable; the old server keeps serving throughout):
#        ops/move-server.sh --from ubuntu@OLD --from-key old.pem --to USER@NEW --to-key new.pem
#   2. cut over (< 1 min of API downtime):
#        ops/move-server.sh --from … --from-key … --to … --to-key … --cutover
#   3. if something is wrong afterwards, go back (copies writes made on NEW back to OLD):
#        ops/move-server.sh --from … --from-key … --to … --to-key … --rollback
#
#   Disaster recovery (the old server is gone): a new VM from the newest R2 backup, in one run:
#        ops/move-server.sh --from-backup latest --to USER@NEW --to-key new.pem \
#            --env-file ~/secure/markdrop.env --backup-env ~/secure/backup.env [--geoip-conf ~/secure/GeoIP.conf]
#        add --practice to rehearse that on a spare VM while the real server lives: restore + API check only
#        (no worker, no DNS, no certificate)
#
# Options:  --dry-run      read-only checks of both servers + the plan; changes nothing anywhere
#           --status       where things stand (roles, services, sync, DNS)
#           --ref COMMIT   code to deploy on NEW (default: what OLD runs; DR: origin/main)
#           --python auto|system|3.14   (default auto: the system python3 if ≥ 3.12, else a uv-managed 3.14)
#           --allow-drift  go ahead although OLD's live configs differ from backend/deploy (the kit wins)
#           --yes          don't ask before the cut-over / rollback
#           --email ADDR   Let's Encrypt account e-mail for a fresh certificate (DR only)
#           --tunnel-port N  local port for the database tunnel (default 27118)
#           --aws-eip      (AWS) first give NEW an Elastic IP if it has none (ops/aws-eip.sh; keys from
#                          backend/.env or the environment); NEW is then reached at that address
# Env:      CF_API_TOKEN + CF_ZONE_ID → the DNS A record is switched through the Cloudflare API
#           (token: Zone › DNS › Edit on markdrop.in); without them you are told what to change.
#
# Secrets never touch this Mac's disk or terminal: they stream OLD → NEW through an SSH pipe.
# (DR is the exception by nature: the files you pass are your own copies.)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KIT_SRC="$(cd "$HERE/../backend/deploy" && pwd)"
DOMAIN="${MARKDROP_DOMAIN:-api.markdrop.in}"
ZONE_NAME="${DOMAIN#*.}"

MODE=prepare DRY=0 YES=0 ALLOW_DRIFT=0 PYTHON=auto REF="" TUNNEL_PORT=27118 EMAIL="" AWS_EIP=0 PRACTICE=0
FROM="" FROM_KEY="" TO="" TO_KEY="" FROM_BACKUP="" ENV_FILE="" BACKUP_ENV="" GEOIP_CONF=""

usage() { sed -n '3,33p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-1}"; }
while [ $# -gt 0 ]; do
  case $1 in
    --from) FROM=$2; shift 2 ;;
    --from-key) FROM_KEY=$2; shift 2 ;;
    --to) TO=$2; shift 2 ;;
    --to-key) TO_KEY=$2; shift 2 ;;
    --cutover) MODE=cutover; shift ;;
    --rollback) MODE=rollback; shift ;;
    --status) MODE=status; shift ;;
    --from-backup) MODE=backup; FROM_BACKUP=$2; shift 2 ;;
    --env-file) ENV_FILE=$2; shift 2 ;;
    --backup-env) BACKUP_ENV=$2; shift 2 ;;
    --geoip-conf) GEOIP_CONF=$2; shift 2 ;;
    --email) EMAIL=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    --python) PYTHON=$2; shift 2 ;;
    --tunnel-port) TUNNEL_PORT=$2; shift 2 ;;
    --allow-drift) ALLOW_DRIFT=1; shift ;;
    --aws-eip) AWS_EIP=1; shift ;;
    --practice) PRACTICE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1"; usage ;;
  esac
done

# ───────────────────────────────────────────────────────────────────────────────────────── output
T_START=$(date +%s)
step() { printf '\n▶ %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '  ✗ %s\n' "$*" >&2; exit 1; }
would() { printf '  · (dry-run) would %s\n' "$*"; }
confirm() {  # confirm "question" — --yes skips; no terminal = no
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || die "needs confirmation: re-run in a terminal or pass --yes"
  local a; read -r -p "  ? $1 [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || die "stopped; nothing changed by this step"
}

# ──────────────────────────────────────────────────────────────────────────────────────────── ssh
[ -n "$TO" ] && [ -n "$TO_KEY" ] || { echo "--to and --to-key are required"; usage; }
if [ "$MODE" != backup ]; then
  [ -n "$FROM" ] && [ -n "$FROM_KEY" ] || { echo "--from and --from-key are required (or --from-backup)"; usage; }
  [ -f "$FROM_KEY" ] || die "no key file $FROM_KEY"
fi
[ -f "$TO_KEY" ] || die "no key file $TO_KEY"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR"
# shellcheck disable=SC2086
on_old()   { ssh -n -i "$FROM_KEY" $SSH_OPTS "$FROM" "$@"; }   # remote command, no stdin
# shellcheck disable=SC2086
on_new()   { ssh -n -i "$TO_KEY" $SSH_OPTS "$TO" "$@"; }
# shellcheck disable=SC2086
pipe_old() { ssh -i "$FROM_KEY" $SSH_OPTS "$FROM" "$@"; }      # remote command reading our stdin
# shellcheck disable=SC2086
pipe_new() { ssh -i "$TO_KEY" $SSH_OPTS "$TO" "$@"; }

host_of() { printf '%s' "${1#*@}"; }
if [ "$AWS_EIP" = 1 ]; then  # before anything keyed on NEW's address
  case $MODE in prepare|backup) ;; *) echo "--aws-eip goes with the prepare step (or --from-backup)"; exit 1 ;; esac
  printf '\n▶ Elastic IP for NEW (%s)\n' "$(host_of "$TO")"
  eip_args=("$(host_of "$TO")"); [ "$DRY" = 1 ] && eip_args+=(--dry-run)
  eip_out=$("$HERE/aws-eip.sh" "${eip_args[@]}") || { printf '%s\n' "${eip_out:-}"; exit 1; }
  printf '%s\n' "$eip_out" | grep -v '^EIP '
  eip=$(printf '%s\n' "$eip_out" | sed -n 's/^EIP //p' | tail -1)
  [ -n "$eip" ] || { echo "  ✗ could not learn NEW's Elastic IP"; exit 1; }
  if [ "$eip" != "$(host_of "$TO")" ]; then
    TO="${TO%@*}@$eip"
    printf '  ✓ NEW is %s from here on (use that in later commands)\n' "$TO"
    if [ "$DRY" != 1 ]; then
      for _ in $(seq 30); do ssh -n -i "$TO_KEY" -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR "$TO" true 2>/dev/null && break; sleep 2; done
    fi
  fi
fi

STATE="$HOME/.markdrop-move/$(printf '%s' "$TO" | shasum | cut -c1-10)"
mkdir -p "$STATE"; chmod 700 "$HOME/.markdrop-move" "$STATE"
save() { printf '%s\n' "$2" > "$STATE/$1"; }
load() { cat "$STATE/$1" 2>/dev/null || true; }
LOG="$STATE/move.log"
exec > >(tee -a "$LOG") 2>&1
echo "──── $(date '+%Y-%m-%d %H:%M:%S') move-server.sh $MODE$( [ "$DRY" = 1 ] && echo ' (dry-run)') — ${FROM:-backup:$FROM_BACKUP} → $TO"

if [ "$MODE" != backup ] && [ "$(host_of "$FROM")" = "$(host_of "$TO")" ]; then
  [ "$DRY" = 1 ] && [ "${MOVE_ALLOW_SAME_HOST:-0}" = 1 ] || die "--from and --to are the same host"
  warn "same host for --from and --to (MOVE_ALLOW_SAME_HOST, dry-run only)"; SAME_HOST_DRY=1
fi

# ─────────────────────────────────────────────────────────────────────────── kit, bundle, files
ship_kit() {  # ship_kit old|new — backend/deploy → /opt/markdrop-ops on that server
  local who=$1
  COPYFILE_DISABLE=1 tar -C "$KIT_SRC" --exclude __pycache__ --exclude '*.pyc' --no-xattrs --no-mac-metadata -czf - . \
    | "pipe_$who" 'sudo rm -rf /opt/markdrop-ops.new && sudo mkdir -p /opt/markdrop-ops.new &&
        sudo tar -C /opt/markdrop-ops.new --no-same-owner -xzf - 2>/dev/null &&
        sudo chown -R root:root /opt/markdrop-ops.new && sudo chmod 755 /opt/markdrop-ops.new &&
        sudo rm -rf /opt/markdrop-ops && sudo mv /opt/markdrop-ops.new /opt/markdrop-ops'
  ok "kit ($(git -C "$KIT_SRC" log -1 --format=%h -- . 2>/dev/null || echo local)) → $who:/opt/markdrop-ops"
}

BUNDLE_PATHS="opt/markdrop/backend/.env etc/markdrop/mongo.env etc/markdrop/backup.env etc/mongod.key etc/GeoIP.conf etc/letsencrypt"
stream_bundle() {  # secrets OLD → NEW, through this Mac's memory only
  on_old "sudo sh -c 'cd / && tar -cf - \$(for p in $BUNDLE_PATHS; do [ -e /\$p ] && echo \$p; done)'" \
    | pipe_new 'sudo install -d -m 700 /root/markdrop-move &&
        sudo sh -c "umask 077; cat > /root/markdrop-move/bundle.tar.part" &&
        sudo tar -tf /root/markdrop-move/bundle.tar.part > /dev/null &&
        sudo mv /root/markdrop-move/bundle.tar.part /root/markdrop-move/bundle.tar'
  local members; members=$(on_new 'sudo tar -tf /root/markdrop-move/bundle.tar' | grep -v '/$' | sed 's#^etc/letsencrypt/.*#etc/letsencrypt/…#' | sort -u | tr '\n' ' ')
  for need in opt/markdrop/backend/.env etc/markdrop/mongo.env etc/mongod.key; do
    case " $members " in *" $need "*) ;; *) die "bundle is missing $need" ;; esac
  done
  ok "secrets bundle on NEW (root 600): $members"
}

copy_file() {  # copy_file <path> <mode> — same path OLD → NEW, skipped when identical
  local p=$1 mode=$2 a b
  a=$(on_old "sudo sha256sum '$p' 2>/dev/null | cut -c1-64" || true)
  [ -n "$a" ] || { warn "OLD has no $p"; return 0; }
  b=$(on_new "sudo sha256sum '$p' 2>/dev/null | cut -c1-64" || true)
  if [ "$a" = "$b" ]; then ok "$p (already identical)"; return 0; fi
  on_old "sudo cat '$p'" | pipe_new "sudo install -d -m 755 \"\$(dirname '$p')\" && sudo sh -c \"cat > '$p.part'\" && sudo chmod $mode '$p.part' && sudo mv '$p.part' '$p'"
  b=$(on_new "sudo sha256sum '$p' | cut -c1-64")
  [ "$a" = "$b" ] || die "$p differs after the copy"
  ok "$p ($(on_new "du -h '$p' | cut -f1"))"
}

# ──────────────────────────────────────────────────────────────────────────────────────── preflight
DRIFT_FILES="markdrop.service:/etc/systemd/system/markdrop.service
markdrop.service.d/memory.conf:/etc/systemd/system/markdrop.service.d/memory.conf
markdrop.service.d/role.conf:/etc/systemd/system/markdrop.service.d/role.conf
markdrop-worker.service:/etc/systemd/system/markdrop-worker.service
markdrop-backup.service:/etc/systemd/system/markdrop-backup.service
markdrop-backup.timer:/etc/systemd/system/markdrop-backup.timer
nginx/markdrop-api.conf:/etc/nginx/sites-available/markdrop-api
nginx/markdrop-ratelimit.conf:/etc/nginx/conf.d/markdrop-ratelimit.conf
backup-mongo.sh:/usr/local/sbin/markdrop-backup-mongo
restore-mongo.sh:/usr/local/sbin/markdrop-restore-mongo
99-markdrop-swap.conf:/etc/sysctl.d/99-markdrop-swap.conf"

fact() { printf '%s\n' "$1" | sed -n "s/^FACT $2=//p" | head -1; }

old_checks() {  # read-only; prints ✓/✗ lines and FACT key=value lines
  pipe_old 'bash -s' <<'REMOTE'
bad=0
y() { echo "  ✓ $*"; }; n() { echo "  ✗ $*"; bad=1; }; w() { echo "  ! $*"; }
sudo -n true 2>/dev/null && y "passwordless sudo" || n "needs passwordless sudo"
. /etc/os-release; y "$PRETTY_NAME $(uname -m), $(nproc) vCPU, $(awk '/MemTotal/{printf "%.1f", $2/1048576}' /proc/meminfo) GB RAM"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/health)
[ "$code" = 200 ] && y "API /health 200" || n "API /health → $code"
for u in markdrop markdrop-worker mongod redis-server nginx; do
  systemctl is-active -q "$u" && y "$u active" || w "$u is $(systemctl is-active "$u")"
done
sudo test -f /etc/markdrop/mongo.env && sudo test -f /etc/mongod.key && y "self-hosted MongoDB (mongo.env, keyfile)" || n "no /etc/markdrop/mongo.env or /etc/mongod.key — this tool moves a self-hosted MongoDB"
grep -q '^MARKDROP_MONGODB_URI=.*@127\.0\.0\.1:27017' /opt/markdrop/backend/.env && y "the app uses the local mongod" \
  || n "the app's MARKDROP_MONGODB_URI is not the local mongod (still on Atlas?)"
read -r -d '' PYCODE <<'PY' || true
import pymongo
env = dict(l.split("=", 1) for l in open("/etc/markdrop/mongo.env").read().splitlines() if "=" in l)
c = pymongo.MongoClient(env["MONGO_ADMIN_URI"].strip("'\""), serverSelectionTimeoutMS=5000)
st = c.admin.command("replSetGetStatus")["members"][0]["stateStr"]
s = c.markdrop.command("dbstats")
print("  ✓ mongod %s %s: markdrop %d collections, %d docs, %.0f MB" % (
    c.server_info()["version"], st, s["collections"], s["objects"], s["storageSize"] / 1e6))
print("FACT mongo_mb=%d" % ((s["storageSize"] + s["indexSize"]) / 1e6))
PY
sudo /opt/markdrop/backend/.venv/bin/python -c "$PYCODE" || n "cannot read MongoDB with the admin credentials"
cd /opt/markdrop && echo "FACT commit=$(git rev-parse HEAD)" && y "code $(git log -1 --format='%h %cs %s' | cut -c1-80)"
dirty=$(git -C /opt/markdrop status --porcelain --untracked-files=no | wc -l)
[ "$dirty" = 0 ] || w "$dirty tracked file(s) modified in /opt/markdrop — NEW gets the committed code only"
for p in /opt/markdrop/backend/.env /etc/markdrop/mongo.env /etc/markdrop/backup.env /etc/mongod.key /etc/GeoIP.conf /etc/letsencrypt/live; do
  sudo test -e "$p" && echo "    secret present: $p" || w "absent: $p"
done
le=/etc/letsencrypt/live/api.markdrop.in/fullchain.pem
sudo test -f $le && y "certificate expires $(sudo openssl x509 -enddate -noout -in $le | cut -d= -f2)" || n "no certificate at $le"
echo "FACT redis=$(redis-server --version | sed -n 's/.*v=\([0-9]*\).*/\1/p')"
echo "FACT ip=$(curl -s4 --max-time 5 https://checkip.amazonaws.com)"
echo "FACT geoip=$(stat -c %s /opt/markdrop/geoip/GeoLite2-City.mmdb 2>/dev/null || echo 0)"
extra=$(ls /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/systemd/system/markdrop.service.d 2>/dev/null | grep -vE '^$|^/|\.bak|^markdrop-api$|^markdrop-ratelimit.conf$|^memory.conf$|^role.conf$' | tr '\n' ' ')
[ -z "$extra" ] || w "configs this tool does not know about (not moved): $extra"
for f in /etc/systemd/system/markdrop*.service /etc/systemd/system/markdrop*.timer; do echo "FACT unit=$(basename "$f")"; done
echo "FACT bad=$bad"
REMOTE
}

new_checks() {  # read-only
  pipe_new "MONGO_MB=${MONGO_MB:-500} SAME_HOST_DRY=${SAME_HOST_DRY:-0} bash -s" <<'REMOTE'
bad=0
y() { echo "  ✓ $*"; }; n() { echo "  ✗ $*"; bad=1; }; w() { echo "  ! $*"; }
sudo -n true 2>/dev/null && y "passwordless sudo ($(id -un))" || n "$(id -un) needs passwordless sudo"
. /etc/os-release
case "$ID:${VERSION_ID%%.*}" in
  ubuntu:2[2-9]|debian:1[2-9]) y "$PRETTY_NAME" ;;
  *) n "unsupported OS $PRETTY_NAME (Ubuntu 22.04+ / Debian 12+)" ;;
esac
case "$(uname -m)" in x86_64|aarch64) y "arch $(uname -m)" ;; *) n "unsupported arch $(uname -m)" ;; esac
mem=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo); cpu=$(nproc)
if [ "$mem" -lt 1800 ]; then n "${mem} MB RAM (need ≥ 2 GB; 4 GB recommended)"
elif [ "$mem" -lt 3700 ]; then w "${mem} MB RAM — works with swap (as today), 4 GB recommended"
else y "${mem} MB RAM"; fi
[ "$cpu" -ge 2 ] && y "$cpu vCPU" || w "$cpu vCPU (2+ recommended)"
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
need=$(( 10 + MONGO_MB * 4 / 1024 ))
[ "$free_gb" -ge "$need" ] && y "${free_gb} GB free on /" || n "${free_gb} GB free on / (need ≥ ${need} GB)"
py=$(python3 -V 2>/dev/null | cut -d' ' -f2); echo "FACT python=$py"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' 2>/dev/null && y "python3 $py" || w "python3 ${py:-missing} < 3.12: a uv-managed Python 3.14 will be installed"
for port in 80 443 8080 6379 27017; do
  who=$(sudo ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | cut -d'"' -f2)
  case "$who" in
    ""|nginx|redis-server|mongod|uvicorn|python*) ;;
    *) n "port $port is taken by $who" ;;
  esac
done
for u in https://github.com https://fastdl.mongodb.org https://pypi.org; do
  curl -s -o /dev/null --max-time 8 "$u" && y "reaches $u" || n "cannot reach $u"
done
if command -v ufw >/dev/null && sudo ufw status 2>/dev/null | grep -q 'Status: active'; then
  sudo ufw status | grep -qE '^(80|443|Nginx Full)' && y "ufw allows web" || n "ufw is active and does not allow 80/443"
fi
role=$(sudo cat /etc/markdrop/role 2>/dev/null || echo none); echo "FACT role=$role"
if systemctl is-active -q markdrop 2>/dev/null && [ "$role" != standby ]; then
  if [ "${SAME_HOST_DRY:-0}" = 1 ]; then w "this server runs a live Markdrop API (role: $role) — a real run would refuse it as NEW"
  else n "this server runs a live Markdrop API (role: $role) — refusing to use it as NEW (wrong --to?)"; fi
fi
[ -d /opt/markdrop/.git ] && w "already provisioned before (role: $role) — re-running is fine"
echo "FACT sync=$(systemctl is-active markdrop-move-sync 2>/dev/null)"
echo "FACT ip=$(curl -s4 --max-time 5 https://checkip.amazonaws.com)"
echo "FACT bad=$bad"
REMOTE
}

preflight_old() {
  step "OLD $FROM (read-only checks)"
  local out
  out=$(old_checks) || die "cannot reach $FROM over SSH"
  printf '%s\n' "$out" | grep -v '^FACT '
  [ "$(fact "$out" bad)" = 0 ] || die "OLD is not in a state to move from (see ✗ above)"
  OLD_COMMIT=$(fact "$out" commit); OLD_REDIS=$(fact "$out" redis); OLD_EGRESS=$(fact "$out" ip)
  MONGO_MB=$(fact "$out" mongo_mb); OLD_GEOIP=$(fact "$out" geoip)
  local units; units=$(printf '%s\n' "$out" | sed -n 's/^FACT unit=//p' | { grep -vxE 'markdrop.service|markdrop-worker.service|markdrop-backup.service|markdrop-backup.timer' || true; } | tr '\n' ' ')
  [ -z "$units" ] || warn "unknown markdrop units on OLD (not moved): $units"
  [ -n "$REF" ] || REF=$OLD_COMMIT
  local dns; dns=$(dig +short "$DOMAIN" A | tail -1)
  if [ "$dns" != "$OLD_EGRESS" ]; then warn "$DOMAIN resolves to $dns but OLD's public IP is $OLD_EGRESS"; fi
  OLD_IP=${OLD_EGRESS:-$dns}
  ok "OLD public IP $OLD_IP; code to deploy ${REF:0:10}"

  info "config drift (OLD's live files vs backend/deploy — NEW gets the backend/deploy versions):"
  local drift=0 line kit path a b
  while IFS= read -r line; do
    kit=${line%%:*}; path=${line#*:}
    a=$(shasum -a 256 "$KIT_SRC/$kit" | cut -c1-64)
    b=$(on_old "sha256sum '$path' 2>/dev/null | cut -c1-64" || true)
    if [ -z "$b" ]; then warn "OLD has no $path"
    elif [ "$a" != "$b" ] && [ "${path#/usr/local/sbin/}" != "$path" ]; then
      info "$path: NEW gets the kit's newer backend/deploy/$kit (a helper script, not config)"
    elif [ "$a" != "$b" ]; then
      drift=1; warn "$path differs from backend/deploy/$kit:"
      on_old "cat '$path'" | diff -u --label "backend/deploy/$kit" --label "OLD:$path" "$KIT_SRC/$kit" - | sed 's/^/      /' | head -40 || true
    fi
  done <<EOF
$DRIFT_FILES
EOF
  if [ "$drift" = 0 ]; then ok "no config drift: OLD runs exactly the configs backend/deploy installs"
  elif [ "$ALLOW_DRIFT" = 1 ]; then warn "drift accepted (--allow-drift): NEW gets the backend/deploy versions"
  else die "commit OLD's version into backend/deploy (or pass --allow-drift to use the kit's)"; fi
}

preflight_new() {
  step "NEW $TO (read-only checks)"
  local out
  out=$(new_checks) || die "cannot reach $TO over SSH"
  printf '%s\n' "$out" | grep -v '^FACT '
  NEW_ROLE=$(fact "$out" role); NEW_IP=$(fact "$out" ip); NEW_SYNC=$(fact "$out" sync)
  [ "$(fact "$out" bad)" = 0 ] || die "NEW is not ready (see ✗ above)"
  [ -n "$NEW_IP" ] || die "could not learn NEW's public IP"
  ok "NEW public IP $NEW_IP"
}

preflight_mac() {
  step "this Mac"
  command -v dig >/dev/null || die "needs dig"
  command -v python3 >/dev/null || die "needs python3"
  for f in provision.sh install-mongo.sh sync-db.py move-sync.sh copy-db.sh nginx/markdrop-api.conf nginx/markdrop-api-bridge.conf; do
    [ -f "$KIT_SRC/$f" ] || die "missing backend/deploy/$f"
  done
  ok "kit backend/deploy complete"
  if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_ZONE_ID:-}" ]; then
    local rec; rec=$(cf_record) || die "Cloudflare API: cannot read the $DOMAIN record (token needs Zone › DNS › Edit)"
    ok "Cloudflare API: $DOMAIN A → $(echo "$rec" | cut -d' ' -f2) (proxied: $(echo "$rec" | cut -d' ' -f3), ttl $(echo "$rec" | cut -d' ' -f4))"
  else
    warn "CF_API_TOKEN/CF_ZONE_ID not set: you will change the DNS record by hand when asked"
  fi
  ok "state + log: $STATE"
}

# ────────────────────────────────────────────────────────────────────────────────────────────── DNS
cf_api() {  # cf_api METHOD PATH [JSON] — the token goes in a header read from a pipe, never argv
  curl -sS --max-time 20 -X "$1" "https://api.cloudflare.com/client/v4$2" -H "Content-Type: application/json" \
    -H @<(printf 'Authorization: Bearer %s\n' "$CF_API_TOKEN") ${3:+--data "$3"}
}
cf_record() {  # prints "id content proxied ttl" of the A record
  cf_api GET "/zones/$CF_ZONE_ID/dns_records?type=A&name=$DOMAIN" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if not d.get("success") or not d["result"]: sys.exit(1)
r = d["result"][0]; print(r["id"], r["content"], r["proxied"], r["ttl"])'
}
dns_switch() {  # dns_switch <ip>
  local ip=$1
  if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_ZONE_ID:-}" ]; then
    local rec id cur; rec=$(cf_record) || die "Cloudflare API: cannot read the record"
    id=${rec%% *}; cur=$(echo "$rec" | cut -d' ' -f2)
    if [ "$cur" = "$ip" ]; then ok "DNS: $DOMAIN A is already $ip"; return; fi
    cf_api PATCH "/zones/$CF_ZONE_ID/dns_records/$id" "{\"content\":\"$ip\"}" \
      | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' \
      || die "Cloudflare API: update failed — change it by hand: $DOMAIN A $ip"
    ok "DNS: $DOMAIN A $cur → $ip (Cloudflare API)"
  else
    echo
    echo "  ┌─ change DNS now ────────────────────────────────────────────────────────────"
    echo "  │ Cloudflare › markdrop.in › DNS › the A record \"${DOMAIN%%.*}\" → $ip  (keep it DNS-only)"
    echo "  └─────────────────────────────────────────────────────────────────────────────"
    if [ -t 0 ]; then read -r -p "  Press Enter once it is saved… " _; else warn "no terminal: continuing; the bridge keeps the old address working"; fi
  fi
}
dns_wait() {  # dns_wait <ip> — authoritative first (seconds), then public resolvers (≤ TTL)
  local ip=$1 ns i got
  ns=$(dig +short NS "$ZONE_NAME" | head -1)
  for i in $(seq 60); do
    got=$(dig +short "@$ns" "$DOMAIN" A | tail -1)
    [ "$got" = "$ip" ] && break; sleep 2
  done
  [ "$got" = "$ip" ] && ok "authoritative ($ns): $DOMAIN → $ip" || { warn "authoritative still says $got"; return 1; }
  for i in $(seq 40); do
    if [ "$(dig +short @1.1.1.1 "$DOMAIN" A | tail -1)" = "$ip" ] && [ "$(dig +short @8.8.8.8 "$DOMAIN" A | tail -1)" = "$ip" ]; then
      ok "1.1.1.1 and 8.8.8.8 answer $ip"; return 0
    fi
    [ "$i" = 1 ] && info "waiting for public resolvers (record TTL; the bridge covers stragglers)…"
    sleep 10
  done
  warn "public resolvers still have the old answer after ~7 min (they will catch up)"; return 1
}

# ───────────────────────────────────────────────────────────────────────────────────────── tunnel
# OLD's mongod 127.0.0.1:27017 → (ssh -L) this Mac 127.0.0.1:PORT → (ssh -R) NEW 127.0.0.1:PORT.
tunnel_check() {
  ssh -S "$STATE/$1-a.sock" -O check x 2>/dev/null && ssh -S "$STATE/$1-b.sock" -O check x 2>/dev/null
}
tunnel_up() {  # tunnel_up <name> <src: old|new> <dst: old|new>
  local name=$1 src=$2 dst=$3 skey shost dkey dhost
  if [ "$src" = old ]; then skey=$FROM_KEY; shost=$FROM; dkey=$TO_KEY; dhost=$TO; else skey=$TO_KEY; shost=$TO; dkey=$FROM_KEY; dhost=$FROM; fi
  if tunnel_check "$name"; then ok "tunnel $src → Mac → $dst already up (127.0.0.1:$TUNNEL_PORT)"; return; fi
  tunnel_down "$name"
  if nc -z 127.0.0.1 "$TUNNEL_PORT" 2>/dev/null; then die "local port $TUNNEL_PORT is in use: pass --tunnel-port"; fi
  # shellcheck disable=SC2086
  ssh -i "$skey" $SSH_OPTS -M -S "$STATE/$name-a.sock" -f -N -o ExitOnForwardFailure=yes \
    -L "127.0.0.1:$TUNNEL_PORT:127.0.0.1:27017" "$shost" >>"$STATE/tunnel.log" 2>&1 || die "tunnel to $src failed ($STATE/tunnel.log)"
  # shellcheck disable=SC2086
  ssh -i "$dkey" $SSH_OPTS -M -S "$STATE/$name-b.sock" -f -N -o ExitOnForwardFailure=yes \
    -R "127.0.0.1:$TUNNEL_PORT:127.0.0.1:$TUNNEL_PORT" "$dhost" >>"$STATE/tunnel.log" 2>&1 || die "reverse tunnel into $dst failed ($STATE/tunnel.log)"
  local pid; pid=$(ssh -S "$STATE/$name-b.sock" -O check x 2>&1 | sed -n 's/.*pid=\([0-9]*\).*/\1/p')
  if command -v caffeinate >/dev/null && [ -n "$pid" ]; then
    (caffeinate -i -w "$pid" >/dev/null 2>&1 &)   # keep the Mac awake while the tunnel lives
  fi
  ok "tunnel $src:27017 → Mac:$TUNNEL_PORT → $dst:127.0.0.1:$TUNNEL_PORT (keep this Mac awake and online)"
}
tunnel_down() {
  local s
  for s in "$STATE/$1-a.sock" "$STATE/$1-b.sock"; do
    [ -S "$s" ] && ssh -S "$s" -O exit x >/dev/null 2>&1 || true
    rm -f "$s"
  done
}

https_check() {  # https_check <ip> [expect] — through that server's nginx with the real hostname + cert check
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:443:$1" "https://$DOMAIN/health" || true)
  [ "$code" = "${2:-200}" ]
}

sync_state() { on_new 'sudo tail -n 4 /var/log/markdrop-move-sync.log 2>/dev/null; echo "UNIT $(systemctl is-active markdrop-move-sync 2>/dev/null)"'; }

# ─────────────────────────────────────────────────────────────────────────────────────────── modes
mode_prepare() {
  preflight_mac
  preflight_old
  preflight_new
  [ "$NEW_ROLE" != live ] || die "NEW is already live (cut over). Use --status, or --rollback."
  save old_ip "$OLD_IP"; save new_ip "$NEW_IP"; save ref "$REF"; save old_redis "$OLD_REDIS"
  if [ "$DRY" = 1 ]; then
    step "plan (dry-run: nothing above or below changed anything)"
    would "stop any earlier copy on NEW, then ship backend/deploy → NEW:/opt/markdrop-ops"
    would "stream the secrets bundle OLD → NEW (.env, /etc/markdrop/*.env, mongod.key, GeoIP.conf, /etc/letsencrypt)"
    would "copy OLD's pip freeze → NEW (the venv gets the exact same package versions)"
    would "provision NEW: packages, user ubuntu, swap, code @ ${REF:0:10}, Python ($PYTHON), MongoDB, Redis, units, nginx + TLS"
    would "copy GeoIP ($(( ${OLD_GEOIP:-0} / 1048576 )) MB) and /opt/markdrop/backups OLD → NEW"
    would "start NEW's API alone, check https://$DOMAIN/health via $NEW_IP, stop it"
    would "open the tunnel OLD:27017 → Mac:$TUNNEL_PORT → NEW, copy ~${MONGO_MB} MB with sync-db.py and keep it live"
    would "print: ready — run with --cutover"
    return
  fi

  step "ship the kit"
  if [ "$NEW_SYNC" = active ] || [ "$NEW_SYNC" = activating ]; then
    on_new 'sudo systemctl stop markdrop-move-sync' || true
    warn "stopped the copy from an earlier run (it restarts from scratch below)"
  fi
  ship_kit new

  step "secrets OLD → NEW"
  stream_bundle
  on_old '/opt/markdrop/backend/.venv/bin/pip freeze --disable-pip-version-check 2>/dev/null' \
    | pipe_new 'sudo sh -c "umask 077; cat > /root/markdrop-move/constraints.txt"'
  ok "OLD's exact Python package versions ($(on_new 'sudo grep -c "==" /root/markdrop-move/constraints.txt') pinned)"

  step "provision NEW"
  on_new "sudo /opt/markdrop-ops/provision.sh install --ref '$REF' --bundle /root/markdrop-move/bundle.tar \
            --constraints /root/markdrop-move/constraints.txt --python '$PYTHON'" \
    || die "provision failed (fix, then re-run this command — it is safe to repeat)"

  step "data files OLD → NEW"
  copy_file /opt/markdrop/geoip/GeoLite2-City.mmdb 644
  if on_old 'test -d /opt/markdrop/backups'; then
    on_old 'sudo tar -C /opt/markdrop -cf - backups' | pipe_new 'sudo tar -C /opt/markdrop -xpf -'
    ok "/opt/markdrop/backups ($(on_new 'du -sh /opt/markdrop/backups | cut -f1'))"
  fi

  step "NEW serves $DOMAIN (API alone, then stopped)"
  on_new "sudo /opt/markdrop-ops/provision.sh realip '$OLD_IP' >/dev/null && sudo /opt/markdrop-ops/provision.sh smoke" || die "smoke test failed"
  local c80; c80=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:80:$NEW_IP" "http://$DOMAIN/health" || true)
  [ "$c80" = 301 ] && ok "http://$NEW_IP:80 → 301 (open: Let's Encrypt renewals will work)" || warn "port 80 on $NEW_IP answered '$c80' — open 80 in the provider's firewall (renewals need it)"
  if https_check "$NEW_IP"; then ok "https://$DOMAIN/health via $NEW_IP: 200, certificate valid"
  else on_new 'sudo /opt/markdrop-ops/provision.sh standby >/dev/null'; die "https://$DOMAIN via $NEW_IP failed — is 443 open in the provider's firewall?"; fi
  on_new 'sudo /opt/markdrop-ops/provision.sh standby' >/dev/null
  ok "API stopped again (standby until the cut-over)"

  step "database: live copy OLD → NEW"
  tunnel_up sync old new
  on_new "timeout 5 bash -c '</dev/tcp/127.0.0.1/$TUNNEL_PORT'" || die "NEW cannot reach the tunnel on 127.0.0.1:$TUNNEL_PORT"
  on_new "sudo systemctl reset-failed markdrop-move-sync 2>/dev/null; sudo rm -f /var/lib/markdrop-move/sync.stop;
          sudo sh -c ': > /var/log/markdrop-move-sync.log; chmod 600 /var/log/markdrop-move-sync.log';
          sudo systemd-run --quiet --unit=markdrop-move-sync \
            -p StandardOutput=append:/var/log/markdrop-move-sync.log -p StandardError=append:/var/log/markdrop-move-sync.log \
            /opt/markdrop-ops/move-sync.sh $TUNNEL_PORT"
  local i seen="" s
  for i in $(seq 540); do
    s=$(on_new 'sudo cat /var/log/markdrop-move-sync.log')
    printf '%s\n' "$s" | grep -vxF -f <(printf '%s\n' "$seen") | grep . | sed 's/^/    /' || true
    seen=$s
    if printf '%s\n' "$s" | grep -q 'LIVE'; then break; fi
    if printf '%s\n' "$s" | grep -q '^EXIT'; then die "the copy stopped (log above); re-run this command"; fi
    sleep 5
  done
  printf '%s\n' "$seen" | grep -q LIVE || die "the copy did not reach LIVE in 45 min"
  ok "NEW follows OLD's writes live"
  echo
  echo "✓ ready ($(( $(date +%s) - T_START )) s). OLD still serves everything; NEW mirrors its database."
  echo "  Next (when you're ready, keep this Mac awake until then):"
  echo "    $0 --from $FROM --from-key $FROM_KEY --to $TO --to-key $TO_KEY --cutover"
}

mode_cutover() {
  OLD_IP=$(load old_ip); NEW_IP=$(load new_ip); OLD_REDIS=$(load old_redis)
  [ -n "$OLD_IP" ] && [ -n "$NEW_IP" ] || die "run the prepare step first"
  step "checks"
  tunnel_check sync || die "the database tunnel is down (Mac slept or lost network?): re-run the prepare step"
  local s; s=$(sync_state)
  printf '%s\n' "$s" | grep -q 'UNIT active' && printf '%s\n' "$s" | grep -q LIVE || { printf '%s\n' "$s" | sed 's/^/    /'; die "the copy on NEW is not live: re-run the prepare step"; }
  ok "copy live: $(printf '%s\n' "$s" | grep LIVE | tail -1 | cut -c1-80)"
  [ "$(on_new 'cat /etc/markdrop/role')" = standby ] || die "NEW is not on standby"
  [ "$(on_old "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/health")" = 200 ] || die "OLD's API is not healthy"
  https_check "$NEW_IP" 502 || https_check "$NEW_IP" 200 || die "NEW's nginx/TLS does not answer"
  ok "OLD healthy; NEW standing by at $NEW_IP"
  if [ "$DRY" = 1 ]; then
    step "plan (dry-run)"
    would "stop OLD's API + worker → drain the copy and compare every collection's count on NEW"
    would "copy Redis, start NEW's API + worker + backups, check health"
    would "turn OLD's nginx into a bridge to NEW ($NEW_IP), disable OLD's API/worker/backups"
    would "switch DNS $DOMAIN → $NEW_IP, wait for it, check certificate renewal on NEW"
    return
  fi
  confirm "Cut over now? The API is down from here until NEW serves (target < 1 min)."

  step "cut-over"
  local T0; T0=$(date +%s)
  on_old 'sudo systemctl stop markdrop-worker markdrop'
  ok "OLD API + worker stopped (downtime starts)"
  on_new 'sudo touch /var/lib/markdrop-move/sync.stop'
  local i
  for i in $(seq 90); do
    s=$(on_new 'sudo tail -n 6 /var/log/markdrop-move-sync.log')
    printf '%s\n' "$s" | grep -q '^EXIT' && break
    sleep 2
  done
  printf '%s\n' "$s" | sed 's/^/    /'
  if ! printf '%s\n' "$s" | grep -q '^EXIT 0'; then
    on_old 'sudo systemctl start markdrop markdrop-worker'
    die "the final copy did not finish cleanly — OLD restarted, nothing else changed ($(( $(date +%s) - T0 )) s down)"
  fi
  ok "database drained, every collection's count matches"

  local new_redis; new_redis=$(on_new "redis-server --version | sed -n 's/.*v=\([0-9]*\).*/\1/p'")
  if [ -n "$OLD_REDIS" ] && [ "${new_redis:-0}" -ge "$OLD_REDIS" ]; then
    if on_old 'redis-cli --rdb - 2>/dev/null' | pipe_new 'sudo sh -c "cat > /var/lib/markdrop-move/dump.rdb" &&
         sudo head -c 5 /var/lib/markdrop-move/dump.rdb | grep -q REDIS &&
         sudo systemctl stop redis-server && sudo install -o redis -g redis -m 660 /var/lib/markdrop-move/dump.rdb /var/lib/redis/dump.rdb &&
         sudo systemctl start redis-server && sleep 1 && redis-cli ping | grep -q PONG'; then
      ok "Redis copied ($(on_new 'redis-cli dbsize') keys)"
    else
      on_new 'sudo systemctl start redis-server' || true
      warn "Redis not copied (only rate-limit counters live there; they start fresh)"
    fi
  else
    warn "Redis $OLD_REDIS → ${new_redis:-?}: an older Redis can't load the dump; rate-limit counters start fresh"
  fi

  on_new 'sudo /opt/markdrop-ops/provision.sh go-live' || {
    on_new 'sudo /opt/markdrop-ops/provision.sh standby' || true
    on_old 'sudo systemctl start markdrop markdrop-worker'
    die "NEW did not come up — OLD restarted and still serves ($(( $(date +%s) - T0 )) s down). NEW's database is a copy; re-run prepare after fixing."
  }
  https_check "$NEW_IP" || warn "https via $NEW_IP not 200 yet"
  ship_kit old
  on_old "sudo /opt/markdrop-ops/provision.sh bridge '$NEW_IP' && sudo /opt/markdrop-ops/provision.sh standby" \
    || warn "could not set OLD's bridge: clients still resolving the old IP get errors until DNS moves"
  if https_check "$OLD_IP"; then ok "OLD's address forwards to NEW"; fi
  ok "API back after $(( $(date +%s) - T0 )) s (served by NEW, also through OLD's address)"

  step "DNS"
  dns_switch "$NEW_IP"
  dns_wait "$NEW_IP" || true

  step "after"
  tunnel_down sync
  if on_new "sudo certbot renew --dry-run --cert-name '$DOMAIN' -q" >/dev/null 2>&1; then
    ok "certificate renewal works on NEW (certbot renew --dry-run)"
  else
    warn "certbot renew --dry-run failed (DNS may still be spreading) — check later: ssh $TO sudo certbot renew --dry-run"
  fi
  on_new 'sudo /opt/markdrop-ops/provision.sh status' | sed 's/^/    /'
  echo
  echo "✓ moved: $DOMAIN is served by $TO ($NEW_IP)."
  echo "  OLD keeps its MongoDB data and forwards stray traffic to NEW. Its API, worker and backups are off."
  echo "  When you are sure (a day or two): stop/terminate OLD. Until then you can go back with:"
  echo "    $0 --from $FROM --from-key $FROM_KEY --to $TO --to-key $TO_KEY --rollback"
  echo "  (or by hand: stop NEW's API+worker; SRC_URI=<NEW via tunnel> DEST_URI=<OLD> copy-db.sh on OLD;"
  echo "   provision.sh bridge off + go-live on OLD; DNS $DOMAIN A → $OLD_IP)"
  save phase cutover-done
}

mode_rollback() {
  OLD_IP=$(load old_ip); NEW_IP=$(load new_ip)
  [ -n "$OLD_IP" ] && [ -n "$NEW_IP" ] || die "no move recorded for $TO on this Mac ($STATE)"
  step "checks"
  [ "$(on_new 'cat /etc/markdrop/role')" = live ] || die "NEW is not live: nothing to roll back"
  on_old 'systemctl is-active -q mongod' || die "OLD's mongod is not running"
  on_old 'test -x /opt/markdrop-ops/provision.sh' || die "OLD has no /opt/markdrop-ops (the cut-over ships it)"
  ok "NEW live, OLD's mongod up"
  if [ "$DRY" = 1 ]; then
    would "stop NEW's API + worker, copy NEW's database back onto OLD (copy-db.sh, counts checked)"
    would "OLD: bridge off, API + worker + backups on; NEW: bridge → OLD; DNS → $OLD_IP"
    return
  fi
  confirm "Roll back to OLD? The API is down while NEW's database is copied back (~1–2 min)."
  local T0; T0=$(date +%s)
  step "rollback"
  on_new 'sudo /opt/markdrop-ops/provision.sh standby'
  tunnel_up back new old
  if ! on_old "sudo bash -c 'set -a; . /etc/markdrop/mongo.env; set +a; export DEST_URI=\"\$MONGO_ADMIN_URI\";
         export SRC_URI=\"\${MONGO_ADMIN_URI/127.0.0.1:27017/127.0.0.1:$TUNNEL_PORT}\";
         MONGO_PY=/opt/markdrop/backend/.venv/bin/python /opt/markdrop-ops/copy-db.sh'"; then
    on_new 'sudo /opt/markdrop-ops/provision.sh go-live' || true
    tunnel_down back
    die "copying NEW → OLD failed: NEW is serving again, nothing else changed"
  fi
  tunnel_down back
  on_old 'sudo /opt/markdrop-ops/provision.sh bridge off && sudo /opt/markdrop-ops/provision.sh realip off && sudo /opt/markdrop-ops/provision.sh go-live' \
    || die "OLD did not come up — start NEW again: ssh $TO sudo /opt/markdrop-ops/provision.sh go-live"
  on_old "sudo /opt/markdrop-ops/provision.sh realip '$NEW_IP'" >/dev/null || true
  on_new "sudo /opt/markdrop-ops/provision.sh bridge '$OLD_IP'" || warn "could not bridge NEW → OLD"
  ok "API back on OLD after $(( $(date +%s) - T0 )) s"
  step "DNS"
  dns_switch "$OLD_IP"
  dns_wait "$OLD_IP" || true
  save phase rolled-back
  echo "✓ rolled back: $DOMAIN is served by $FROM ($OLD_IP); NEW forwards stray traffic there and keeps its data."
}

mode_status() {
  step "NEW $TO"
  on_new 'if [ -x /opt/markdrop-ops/provision.sh ]; then sudo /opt/markdrop-ops/provision.sh status; else echo "  not provisioned"; fi' || warn "unreachable"
  if [ -n "$FROM" ]; then
    step "OLD $FROM"
    on_old 'if [ -x /opt/markdrop-ops/provision.sh ]; then sudo /opt/markdrop-ops/provision.sh status; else
      echo "  role: (original server)"; for u in markdrop markdrop-worker mongod nginx; do echo "  $u $(systemctl is-active $u)"; done; fi' || warn "unreachable"
  fi
  step "here"
  echo "  DNS $DOMAIN: $(dig +short "$DOMAIN" A | tail -1)   recorded: old $(load old_ip), new $(load new_ip), phase $(load phase)"
  tunnel_check sync && echo "  sync tunnel: up" || echo "  sync tunnel: down"
}

mode_backup() {  # disaster recovery: NEW from the newest (or a named) R2 backup
  step "your files (DR mode: secrets come from you)"
  [ -f "$ENV_FILE" ] || die "--env-file: the app's backend/.env (from your password manager)"
  [ -f "$BACKUP_ENV" ] || die "--backup-env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, MARKDROP_BACKUP_R2_BUCKET"
  local k
  for k in MARKDROP_AUTH_SECRET MARKDROP_TOKEN_ENCRYPTION_KEY MARKDROP_R2_ACCESS_KEY_ID MARKDROP_ARTIFACT_SIGNING_KEY; do
    grep -q "^$k=" "$ENV_FILE" || die "$ENV_FILE has no $k — is it the production .env?"
  done
  for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY MARKDROP_BACKUP_R2_BUCKET; do
    grep -q "^$k=" "$BACKUP_ENV" || die "$BACKUP_ENV has no $k"
  done
  [ -z "$GEOIP_CONF" ] || [ -f "$GEOIP_CONF" ] || die "no $GEOIP_CONF"
  ok ".env ($(grep -c '^MARKDROP_' "$ENV_FILE") settings), backup.env${GEOIP_CONF:+, GeoIP.conf}"
  preflight_mac
  preflight_new
  [ "$NEW_ROLE" != live ] || die "NEW is already live"
  save new_ip "$NEW_IP"
  [ -n "$REF" ] || REF=main
  if [ "$DRY" = 1 ]; then
    step "plan (dry-run)"
    would "ship the kit; send your .env/backup.env${GEOIP_CONF:+/GeoIP.conf} to NEW (root 600)"
    would "provision NEW (fresh MongoDB passwords + keyfile, code @ $REF, placeholder TLS)"
    if [ "$PRACTICE" = 1 ]; then
      would "download + restore R2 backup '$FROM_BACKUP', start the API alone, probe it, stop it (practice: no worker, DNS, cert)"
    else
      would "download + restore R2 backup '$FROM_BACKUP', go live"
      would "switch DNS $DOMAIN → $NEW_IP, then issue a Let's Encrypt certificate"
    fi
    return
  fi
  if [ "$PRACTICE" = 1 ]; then confirm "Practice: build $TO from backup '$FROM_BACKUP' (DNS untouched, nothing goes live)?"
  else confirm "Build $TO from backup '$FROM_BACKUP' and point $DOMAIN at it?"; fi
  step "ship the kit + your secrets"
  ship_kit new
  ENV_FILE="$ENV_FILE" BACKUP_ENV="$BACKUP_ENV" GEOIP_CONF="$GEOIP_CONF" python3 - <<'EOF' | pipe_new 'sudo install -d -m 700 /root/markdrop-move && sudo sh -c "umask 077; cat > /root/markdrop-move/bundle.tar"'
import io, os, sys, tarfile
out = tarfile.open(fileobj=sys.stdout.buffer, mode="w|")
for env, arc in (("ENV_FILE", "opt/markdrop/backend/.env"), ("BACKUP_ENV", "etc/markdrop/backup.env"), ("GEOIP_CONF", "etc/GeoIP.conf")):
    p = os.environ.get(env)
    if not p:
        continue
    data = open(p, "rb").read()
    ti = tarfile.TarInfo(arc); ti.size = len(data); ti.mode = 0o600
    out.addfile(ti, io.BytesIO(data))
out.close()
EOF
  ok "bundle on NEW"
  step "provision NEW"
  on_new "sudo /opt/markdrop-ops/provision.sh install --ref '$REF' --bundle /root/markdrop-move/bundle.tar --python '$PYTHON'" || die "provision failed (re-run is safe)"
  step "restore"
  on_new "sudo /opt/markdrop-ops/provision.sh restore-backup '$FROM_BACKUP'" || die "restore failed"
  if [ "$PRACTICE" = 1 ]; then
    on_new 'sudo /opt/markdrop-ops/provision.sh smoke' || die "the API did not come up on the restored data"
    save phase practice-restored
    echo
    echo "✓ practice recovery on $TO ($NEW_IP) from backup '$FROM_BACKUP': restored, API healthy on it, stopped again."
    echo "  Nothing went live; DNS untouched. Terminate the VM when done (it holds a copy of the data)."
    return
  fi
  on_new 'sudo /opt/markdrop-ops/provision.sh go-live' || die "NEW did not come up"
  if [ -n "$GEOIP_CONF" ]; then
    on_new 'sudo geoipupdate && sudo systemctl restart markdrop markdrop-worker' && ok "GeoIP database downloaded" || warn "geoipupdate failed (the app runs without GeoIP)"
  fi
  step "DNS + certificate"
  dns_switch "$NEW_IP"
  dns_wait "$NEW_IP" || true
  local i
  for i in 1 2 3; do
    on_new "sudo /opt/markdrop-ops/provision.sh issue-cert '$EMAIL'" && break
    [ "$i" = 3 ] && die "certificate failed 3 times — once DNS has spread: ssh $TO sudo /opt/markdrop-ops/provision.sh issue-cert"
    warn "retrying in 60 s (Let's Encrypt may still see the old address)"; sleep 60
  done
  https_check "$NEW_IP" && ok "https://$DOMAIN/health 200 on $NEW_IP" || warn "https check failed"
  save phase restored-from-backup
  echo
  echo "✓ recovered on $TO ($NEW_IP) from backup '$FROM_BACKUP'."
  echo "  Lost by nature: writes after that backup (≤ 6 h), Redis rate-limit counters, the old local backups."
}

case $MODE in
  prepare) mode_prepare ;;
  cutover) mode_cutover ;;
  rollback) mode_rollback ;;
  status) mode_status ;;
  backup) mode_backup ;;
esac
