#!/usr/bin/env bash
#
# provision.sh — turn a fresh Ubuntu/Debian VM into a Markdrop API server, and the small
# server-side steps of a move. Runs ON the server, as root. ops/move-server.sh (on the Mac) copies
# this folder to /opt/markdrop-ops and calls it; you rarely run it by hand.
#
#   sudo ./provision.sh install [--ref COMMIT] [--bundle FILE] [--constraints FILE] [--python auto|system|3.14]
#   sudo ./provision.sh smoke                 start the API alone, check /health + the database, stop it
#   sudo ./provision.sh go-live               enable + start API, worker and backups (this server serves)
#   sudo ./provision.sh standby               stop + disable them (another server serves)
#   sudo ./provision.sh realip <IP>|off       trust X-Forwarded-For from <IP> (the server forwarding to us)
#   sudo ./provision.sh bridge <IP>|off       forward all API traffic to the server at <IP> (old server
#                                             during a move, so clients with a cached DNS answer still work)
#   sudo ./provision.sh restore-backup latest|<name>    newest (or named) R2 backup → local MongoDB
#   sudo ./provision.sh issue-cert [EMAIL]    Let's Encrypt cert for the API domain (needs DNS pointing here)
#   sudo ./provision.sh status
#
# install is idempotent (re-run it freely) and works on Ubuntu 22.04+ / Debian 12+, x86_64 or arm64.
# It refuses to run on a server whose role is "live" (use backend/deploy.sh to update code there).
#
# The app runs as the user "ubuntu" (as on AWS/Lightsail/Oracle images). Where the login user is
# someone else (GCP: your Google username), install creates "ubuntu" with passwordless sudo and your
# SSH keys, so `ssh ubuntu@api.markdrop.in` and every existing runbook keep working unchanged.
#
# The bundle (a tar made by move-server.sh, root 600) holds the secrets and is extracted at /:
#   opt/markdrop/backend/.env  etc/markdrop/{mongo,backup}.env  etc/mongod.key  etc/GeoIP.conf  etc/letsencrypt/
# Anything missing is handled: no mongo.env/mongod.key → fresh passwords; no certificate → a
# self-signed placeholder until `issue-cert`; no GeoIP.conf → no automatic GeoIP updates.
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="${MARKDROP_DOMAIN:-api.markdrop.in}"
REPO_URL="${MARKDROP_REPO_URL:-https://github.com/himanshkukreja/markdrop.git}"
APP_USER=ubuntu
REPO=/opt/markdrop
APP=$REPO/backend
VENV=$APP/.venv
ROLE_FILE=/etc/markdrop/role
PLACEHOLDER=/etc/markdrop/tls-placeholder

step() { echo "▶ $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ! $*"; }
die()  { echo "  ✗ $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
role() { cat "$ROLE_FILE" 2>/dev/null || echo none; }

wait_health() {  # wait_health [seconds]
  for _ in $(seq "${1:-60}"); do
    curl -fs --max-time 3 -o /dev/null http://127.0.0.1:8080/health && return 0
    sleep 1
  done
  return 1
}

db_probe() {  # read-only: the app's own settings reach the database and see data
  (cd "$APP" && sudo -u "$APP_USER" "$VENV/bin/python" - <<'EOF')
from app.config import Settings
import pymongo
s = Settings()
db = pymongo.MongoClient(s.mongodb_uri, serverSelectionTimeoutMS=5000)[s.mongodb_db]
names = [n for n in db.list_collection_names() if not n.startswith("system.")]
print(f"  ✓ database: {len(names)} collections, {db.documents.estimated_document_count()} documents, "
      f"{db.users.estimated_document_count()} users")
EOF
}

install_file() {  # install_file <src> <dest> [mode] — copy only when different; prints when it changed
  local src=$1 dest=$2 mode=${3:-644}
  if ! cmp -s "$src" "$dest" 2>/dev/null; then
    install -D -m "$mode" "$src" "$dest"
    echo "  · $dest"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────────────────── install
cmd_install() {
  local ref="" bundle="" python=auto constraints="" bundle_list=""
  while [ $# -gt 0 ]; do
    case $1 in
      --ref) ref=$2; shift 2 ;;
      --constraints) constraints=$2; shift 2 ;;
      --bundle) bundle=$2; shift 2 ;;
      --python) python=$2; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  [ "$(role)" != live ] || [ "${FORCE:-0}" = 1 ] || \
    die "this server is live — install would reset its code and restart mongod. Use backend/deploy.sh (or FORCE=1)."
  # A server set up before this kit (no role file) that runs the API is a production server too.
  if [ "$(role)" = none ] && systemctl is-active -q markdrop 2>/dev/null && [ "${FORCE:-0}" != 1 ]; then
    die "this server already runs the Markdrop API (set up by hand) — refusing to re-provision it (FORCE=1 overrides)"
  fi

  . /etc/os-release
  case "$ID:${VERSION_ID%%.*}" in
    ubuntu:2[2-9]|debian:1[2-9]) ;;
    *) die "unsupported OS: $PRETTY_NAME (need Ubuntu 22.04+ or Debian 12+)" ;;
  esac
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die "unsupported arch $(uname -m)" ;; esac
  step "provision $(hostname) — $PRETTY_NAME $(uname -m), $(awk '/MemTotal/{printf "%.1f GB RAM", $2/1048576}' /proc/meminfo)"

  timedatectl set-timezone Etc/UTC 2>/dev/null || true   # backup timer + logs, as on the old server

  step "app user $APP_USER"
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$APP_USER"
    echo "$APP_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-markdrop-ubuntu
    chmod 440 /etc/sudoers.d/90-markdrop-ubuntu
    ok "created (passwordless sudo, like the AWS default user)"
  fi
  local login="${SUDO_USER:-}"
  if [ -n "$login" ] && [ "$login" != root ] && [ "$login" != "$APP_USER" ]; then
    local src_keys; src_keys="$(getent passwd "$login" | cut -d: -f6)/.ssh/authorized_keys"
    local dst_keys="/home/$APP_USER/.ssh/authorized_keys"
    if [ -f "$src_keys" ]; then
      install -d -o "$APP_USER" -g "$APP_USER" -m 700 "/home/$APP_USER/.ssh"
      touch "$dst_keys"
      while IFS= read -r k; do
        [ -n "$k" ] && ! grep -qxF "$k" "$dst_keys" && echo "$k" >> "$dst_keys"
      done < "$src_keys"
      chown "$APP_USER:$APP_USER" "$dst_keys"; chmod 600 "$dst_keys"
      ok "$login's SSH keys also log in as $APP_USER"
    fi
  fi

  step "packages"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
  apt-get update -q >/dev/null
  apt-get install -y -q --no-install-recommends \
    nginx redis-server certbot python3-certbot-nginx git curl ca-certificates openssl \
    ffmpeg python3 python3-venv python3-pip >/dev/null
  if ! command -v geoipupdate >/dev/null; then
    apt-get install -y -q geoipupdate >/dev/null 2>&1 || warn "geoipupdate not in this distro's repos (Debian: enable contrib) — GeoIP data won't auto-update"
  fi
  ok "nginx $(nginx -v 2>&1 | sed 's/.*\///'), redis $(redis-server --version | sed -n 's/.*v=\([^ ]*\).*/\1/p'), certbot $(certbot --version 2>&1 | awk '{print $2}')"

  step "swap + sysctl"
  # Swap by RAM: 2 GB on a box under 3 GB (today's 2 GB t3.small), 1 GB up to 16 GB (a 4 GB t4g.medium), else none.
  # It is a cushion for spikes (the API, worker and mongod each have a MemoryMax), not working memory.
  # An existing swap (any size) is left alone.
  local mem_mb swap_mb=0; mem_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  if [ "$mem_mb" -lt 3000 ]; then swap_mb=2048; elif [ "$mem_mb" -lt 16000 ]; then swap_mb=1024; fi
  if [ "$swap_mb" -gt 0 ] && [ "$(swapon --noheadings | wc -l)" = 0 ]; then
    fallocate -l "${swap_mb}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="$swap_mb" status=none
    chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "${swap_mb} MB /swapfile for ${mem_mb} MB RAM"
  else
    ok "swap: $(swapon --noheadings --show=NAME,SIZE | tr '\n' ' ' | tr -s ' ')(${mem_mb} MB RAM)"
  fi
  install_file "$KIT/99-markdrop-swap.conf" /etc/sysctl.d/99-markdrop-swap.conf
  sysctl -q --system >/dev/null 2>&1 || true

  if [ -n "$bundle" ]; then
    step "secrets bundle (system part)"
    [ -f "$bundle" ] || die "no bundle at $bundle"
    # (the listing goes into a variable: `tar | grep -q` would SIGPIPE tar and fail under pipefail)
    bundle_list=$(tar -tf "$bundle")
    if grep -q '^etc/' <<<"$bundle_list"; then
      tar -xpf "$bundle" -C / --wildcards 'etc/*'
    fi
    install -d -m 700 /etc/markdrop
    chmod 600 /etc/markdrop/*.env 2>/dev/null || true
    [ -f /etc/GeoIP.conf ] && chmod 600 /etc/GeoIP.conf
    ok "$(printf '%s\n' "$bundle_list" | grep -v '/$' | sed 's#^etc/letsencrypt/.*#etc/letsencrypt/…#' | sort -u | tr '\n' ' ')"
  fi
  [ -f "$ROLE_FILE" ] || { install -d -m 700 /etc/markdrop; echo standby > "$ROLE_FILE"; }

  step "code ($REPO_URL${ref:+ @ ${ref:0:10}})"
  if [ ! -d "$REPO/.git" ]; then
    install -d -o "$APP_USER" -g "$APP_USER" "$REPO"
    sudo -u "$APP_USER" git clone -q "$REPO_URL" "$REPO"
  fi
  chown "$APP_USER:$APP_USER" "$REPO"
  sudo -u "$APP_USER" git -C "$REPO" fetch -q origin
  if [ -n "$ref" ]; then
    sudo -u "$APP_USER" git -C "$REPO" cat-file -e "$ref^{commit}" 2>/dev/null || sudo -u "$APP_USER" git -C "$REPO" fetch -q origin "$ref"
    sudo -u "$APP_USER" git -C "$REPO" checkout -q -B main origin/main
    sudo -u "$APP_USER" git -C "$REPO" reset -q --hard "$ref"
  elif ! sudo -u "$APP_USER" git -C "$REPO" rev-parse -q --verify HEAD >/dev/null; then
    sudo -u "$APP_USER" git -C "$REPO" checkout -q -B main origin/main
  fi
  ok "at $(git -C "$REPO" log -1 --format='%h %s' | cut -c1-90)"

  if [ -n "$bundle" ] && grep -qx 'opt/markdrop/backend/.env' <<<"$bundle_list"; then
    tar -xpf "$bundle" -C / opt/markdrop/backend/.env
  fi
  [ -f "$APP/.env" ] || die "no $APP/.env — pass the bundle (move-server.sh does) or copy it in"
  chown "$APP_USER:$APP_USER" "$APP/.env"; chmod 600 "$APP/.env"

  step "python + virtualenv"
  local want_minor="" py=""
  case $python in
    auto|system)
      if python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
        py=$(command -v python3)
      elif [ "$python" = system ]; then
        die "system python3 is $(python3 -V 2>&1) — Markdrop needs 3.12+; use --python 3.14"
      else
        want_minor=3.14
      fi ;;
    3.*) want_minor=$python ;;
    *) die "--python auto|system|3.X" ;;
  esac
  if [ -n "$want_minor" ]; then  # a standalone CPython via uv (same build on every distro/arch)
    if ! command -v uv >/dev/null; then
      curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh >/dev/null
    fi
    UV_PYTHON_INSTALL_DIR=/opt/python uv python install -q "$want_minor"
    py=$(UV_PYTHON_INSTALL_DIR=/opt/python uv python find "$want_minor")
  fi
  local have; have=$("$py" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  if [ -x "$VENV/bin/python" ] && [ "$("$VENV/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" != "$have" ]; then
    rm -rf "$VENV"
  fi
  [ -x "$VENV/bin/python" ] || sudo -u "$APP_USER" "$py" -m venv "$VENV"
  sudo -u "$APP_USER" "$VENV/bin/pip" install -q --disable-pip-version-check --upgrade pip
  # --constraints: the old server's `pip freeze`, so the new venv has the exact same versions of every
  # transitive dependency too (requirements.txt pins only the direct ones). All of today's versions ship
  # binary wheels for cp312 + cp314 on x86_64 and aarch64 (checked 2026-11-09), so no compiler is needed;
  # should one ever lack a wheel, the build tools are installed and the install retried.
  local pipi=(sudo -u "$APP_USER" "$VENV/bin/pip" install -q --disable-pip-version-check -r "$APP/requirements.txt")
  local cfile=""
  if [ -n "$constraints" ] && [ -s "$constraints" ]; then
    cfile=$(mktemp /tmp/markdrop-constraints.XXXXXX); grep -E '^[A-Za-z0-9_.-]+==' "$constraints" > "$cfile" || true
    chmod 644 "$cfile"
  fi
  if [ -n "$cfile" ] && "${pipi[@]}" -c "$cfile"; then
    ok "dependencies pinned to the old server's versions ($(wc -l < "$cfile") packages)"
  else
    [ -n "$cfile" ] && warn "the old server's exact versions don't install here: using requirements.txt alone"
    if ! "${pipi[@]}"; then
      warn "pip needs to compile something: installing build-essential + python3-dev and retrying"
      apt-get install -y -q build-essential python3-dev pkg-config libffi-dev libssl-dev >/dev/null
      "${pipi[@]}"
    fi
  fi
  rm -f "$cfile"
  ok "Python $("$VENV/bin/python" -V | cut -d' ' -f2) at $VENV"

  step "MongoDB"
  MONGO_PY="$VENV/bin/python" bash "$KIT/install-mongo.sh"
  # The app talks to this server's mongod: point .env at it (a moved .env already does; a
  # disaster-recovery .env may still carry the dead server's password or Atlas).
  APP_ENV="$APP/.env" "$VENV/bin/python" - <<'EOF'
import os, re
creds = dict(l.split("=", 1) for l in open("/etc/markdrop/mongo.env").read().splitlines() if "=" in l)
uri = creds["MARKDROP_MONGODB_URI"].strip("'\"")
p = os.environ["APP_ENV"]
lines = open(p).read().splitlines()
cur = next((l.split("=", 1)[1].strip("'\"") for l in lines if l.startswith("MARKDROP_MONGODB_URI=")), None)
if cur != uri:
    lines = [l for l in lines if not l.startswith("MARKDROP_MONGODB_URI=")] + [f"MARKDROP_MONGODB_URI={uri}"]
    open(p, "w").write("\n".join(lines) + "\n")
    print("  · .env MARKDROP_MONGODB_URI → this server's mongod")
EOF

  step "Redis"
  systemctl enable -q --now redis-server
  ok "$(redis-cli ping)"

  step "systemd units + helper scripts"
  install_file "$KIT/backup-mongo.sh"  /usr/local/sbin/markdrop-backup-mongo 755
  install_file "$KIT/restore-mongo.sh" /usr/local/sbin/markdrop-restore-mongo 755
  install_file "$KIT/markdrop.service"        /etc/systemd/system/markdrop.service
  install_file "$KIT/markdrop.service.d/memory.conf" /etc/systemd/system/markdrop.service.d/memory.conf
  install_file "$KIT/markdrop.service.d/role.conf"   /etc/systemd/system/markdrop.service.d/role.conf
  install_file "$KIT/markdrop-worker.service" /etc/systemd/system/markdrop-worker.service
  install_file "$KIT/markdrop-backup.service" /etc/systemd/system/markdrop-backup.service
  install_file "$KIT/markdrop-backup.timer"   /etc/systemd/system/markdrop-backup.timer
  # geoipupdate's unit is ProtectSystem=strict: without this it can't write into /opt/markdrop/geoip
  # (the old server's weekly update has failed since it moved there).
  install_file "$KIT/geoipupdate-markdrop.conf" /etc/systemd/system/geoipupdate.service.d/markdrop.conf
  install -d -m 755 /opt/markdrop/geoip
  if command -v geoipupdate >/dev/null && ! systemctl cat geoipupdate.timer >/dev/null 2>&1; then
    # Older packages (Ubuntu 24.04) only ship a cron job that skips itself under systemd.
    printf '# provision.sh: weekly GeoIP update (this geoipupdate package has no systemd timer)\n47 6 * * 3 root /usr/bin/geoipupdate\n' \
      > /etc/cron.d/markdrop-geoipupdate
  fi
  systemctl daemon-reload
  if [ "$(role)" != live ]; then
    systemctl disable -q --now markdrop-worker markdrop markdrop-backup.timer 2>/dev/null || true
  fi
  ok "installed (role: $(role) — API/worker/backups start at go-live)"

  step "import check"
  (cd "$APP" && sudo -u "$APP_USER" "$VENV/bin/python" -c "import app.main" >/dev/null) || die "the app does not import on this Python"
  ok "app.main imports"

  step "nginx + TLS ($DOMAIN)"
  install_nginx
  systemctl enable -q --now nginx
  systemctl reload nginx
  systemctl enable -q --now certbot.timer 2>/dev/null || true
  ok "nginx up"
  echo "✓ install done — role $(role)"
}

nginx_compat() {  # nginx_compat <file> — `http2 on;` needs nginx ≥ 1.25.1 (Ubuntu 24.04 ships 1.24): older → `listen … http2`
  local v; v=$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')
  if [ "$(printf '%s\n1.25.1\n' "$v" | sort -V | head -1)" != 1.25.1 ]; then
    sed -i -e '/^\s*http2 on;\s*$/d' -e 's/^\(\s*listen 443 ssl\);/\1 http2;/' "$1"
  fi
}

install_nginx() {  # the site + rate-limit confs; a self-signed placeholder while there is no real cert
  install_file "$KIT/nginx/markdrop-ratelimit.conf" /etc/nginx/conf.d/markdrop-ratelimit.conf
  local site=/etc/nginx/sites-available/markdrop-api tmp
  tmp=$(mktemp)
  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    cp "$KIT/nginx/markdrop-api.conf" "$tmp"
  else
    if [ ! -f "$PLACEHOLDER/fullchain.pem" ]; then
      install -d -m 700 "$PLACEHOLDER"
      openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 30 \
        -subj "/CN=$DOMAIN" -keyout "$PLACEHOLDER/privkey.pem" -out "$PLACEHOLDER/fullchain.pem" 2>/dev/null
    fi
    sed -e "s#/etc/letsencrypt/live/$DOMAIN/#$PLACEHOLDER/#" \
        -e 's#^\(\s*include /etc/letsencrypt/options-ssl-nginx.conf;\)#    \# (placeholder TLS) \1#' \
        -e 's#^\(\s*ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\)#    \# (placeholder TLS) \1#' \
        "$KIT/nginx/markdrop-api.conf" > "$tmp"
    warn "no Let's Encrypt certificate for $DOMAIN yet: self-signed placeholder (run issue-cert once DNS points here)"
  fi
  nginx_compat "$tmp"
  install_file "$tmp" "$site"; rm -f "$tmp"
  rm -f /etc/nginx/sites-enabled/default
  if [ ! -L /etc/nginx/sites-enabled/markdrop-api-bridge ]; then
    ln -sfn "$site" /etc/nginx/sites-enabled/markdrop-api
  fi
  nginx -t -q || die "nginx -t failed"
}

# ─────────────────────────────────────────────────────────────────────────────── service switching
cmd_smoke() {
  [ "$(role)" != live ] || { wait_health 30 && ok "live: /health 200"; db_probe; return; }
  step "smoke test: API alone (no worker), then stopped again"
  systemctl start markdrop
  if wait_health 90; then ok "/health 200"; else systemctl stop markdrop; journalctl -u markdrop -n 30 --no-pager; die "API did not come up"; fi
  db_probe || { systemctl stop markdrop; die "database probe failed"; }
  systemctl stop markdrop
  ok "stopped (standby)"
}

cmd_go_live() {
  step "go live: API + worker + backups on $(hostname)"
  echo live > "$ROLE_FILE"
  systemctl enable -q markdrop markdrop-worker markdrop-backup.timer
  systemctl restart markdrop markdrop-worker
  systemctl start markdrop-backup.timer
  wait_health 90 || { journalctl -u markdrop -n 30 --no-pager; die "API not healthy"; }
  ok "/health 200"
  sleep 2
  systemctl is-active -q markdrop-worker || { journalctl -u markdrop-worker -n 30 --no-pager; die "worker not running"; }
  ok "worker running; backup timer on"
  db_probe
}

cmd_standby() {
  step "standby: stop + disable API, worker, backups on $(hostname) (mongod, redis, nginx stay up)"
  systemctl disable -q --now markdrop-worker markdrop markdrop-backup.timer 2>/dev/null || true
  install -d -m 700 /etc/markdrop; echo standby > "$ROLE_FILE"
  ok "standby"
}

cmd_realip() {  # trust the forwarding server's X-Forwarded-For (client IPs for rate limits + the app)
  local ip=${1:?usage: realip <IP>|off} f=/etc/nginx/conf.d/markdrop-bridge-realip.conf
  if [ "$ip" = off ]; then rm -f "$f"; else
    printf '# provision.sh realip: %s forwards API traffic here during a move\nset_real_ip_from %s;\nreal_ip_header X-Forwarded-For;\n' "$ip" "$ip" > "$f"
  fi
  nginx -t -q && systemctl reload nginx
  ok "realip ${ip}"
}

cmd_bridge() {  # serve every request by forwarding it to <IP> (that server's nginx + cert)
  local ip=${1:?usage: bridge <IP>|off}
  local site=/etc/nginx/sites-available/markdrop-api-bridge
  if [ "$ip" = off ]; then
    ln -sfn /etc/nginx/sites-available/markdrop-api /etc/nginx/sites-enabled/markdrop-api
    rm -f /etc/nginx/sites-enabled/markdrop-api-bridge
    nginx -t -q && systemctl reload nginx
    ok "bridge off: this server's own API serves $DOMAIN again"
    return
  fi
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bridge needs an IPv4 address"
  sed -e "s/__TARGET__/$ip/g" -e "s/__DOMAIN__/$DOMAIN/g" "$KIT/nginx/markdrop-api-bridge.conf" > "$site"
  nginx_compat "$site"
  ln -sfn "$site" /etc/nginx/sites-enabled/markdrop-api-bridge
  rm -f /etc/nginx/sites-enabled/markdrop-api
  if ! nginx -t -q; then
    ln -sfn /etc/nginx/sites-available/markdrop-api /etc/nginx/sites-enabled/markdrop-api
    rm -f /etc/nginx/sites-enabled/markdrop-api-bridge
    die "bridge config failed nginx -t; left as it was"
  fi
  systemctl reload nginx
  ok "bridge on: $DOMAIN here → https://$ip"
}

# ───────────────────────────────────────────────────────────────────────────────── disaster recovery
cmd_restore_backup() {
  local which=${1:-latest}
  [ -f /etc/markdrop/backup.env ] || die "no /etc/markdrop/backup.env (R2 keys + bucket)"
  install -d -m 700 /var/backups/markdrop
  step "R2 backup: $which"
  local f
  f=$(WHICH="$which" "$VENV/bin/python" - <<'EOF'
import os, sys, boto3
env = dict(l.split("=", 1) for l in open("/etc/markdrop/backup.env").read().splitlines() if "=" in l and not l.startswith("#"))
env = {k: v.strip("'\"") for k, v in env.items()}
c = boto3.client("s3", endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com", region_name="auto",
                 aws_access_key_id=env["R2_ACCESS_KEY_ID"], aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"])
bucket, which = env["MARKDROP_BACKUP_R2_BUCKET"], os.environ["WHICH"]
keys = []
for page in c.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="mongo/"):
    keys += [(o["Key"], o["Size"]) for o in page.get("Contents", []) if o["Key"].endswith(".archive.gz")]
if not keys:
    sys.exit("no backups under mongo/ in the bucket")
keys.sort()
key = keys[-1][0] if which == "latest" else next((k for k, _ in keys if k.endswith(which)), None)
if not key:
    sys.exit(f"no backup named {which}; newest: " + ", ".join(k for k, _ in keys[-5:]))
dest = "/var/backups/markdrop/" + os.path.basename(key)
if not os.path.exists(dest):
    c.download_file(bucket, key, dest + ".part"); os.rename(dest + ".part", dest)
print(dest)
EOF
) || die "could not fetch the backup"
  ok "$(basename "$f") ($(du -h "$f" | cut -f1))"
  /usr/local/sbin/markdrop-restore-mongo "$f"
  db_probe
}

cmd_issue_cert() {
  local email=${1:-}
  step "Let's Encrypt certificate for $DOMAIN"
  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    ok "already have one (expires $(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" | cut -d= -f2))"
  else
    local who=(--register-unsafely-without-email)
    [ -n "$email" ] && who=(--email "$email")
    certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos --key-type ecdsa "${who[@]}"
  fi
  # The nginx plugin normally writes these; fall back to the copies the certbot package ships.
  for f in options-ssl-nginx.conf ssl-dhparams.pem; do
    if [ ! -f "/etc/letsencrypt/$f" ]; then
      local src; src=$(find /usr/lib/python3/dist-packages -name "$f" 2>/dev/null | head -1)
      [ -n "$src" ] && install -m 644 "$src" "/etc/letsencrypt/$f"
    fi
  done
  install_nginx
  systemctl reload nginx
  ok "nginx serves the real certificate"
}

cmd_status() {
  echo "role: $(role)   host: $(hostname)   code: $(git -C "$REPO" log -1 --format='%h %cs' 2>/dev/null || echo none)"
  for u in mongod redis-server nginx markdrop markdrop-worker markdrop-backup.timer markdrop-move-sync certbot.timer; do
    printf '  %-22s %s/%s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)" "$(systemctl is-enabled "$u" 2>/dev/null || true)"
  done
  curl -fs --max-time 3 -o /dev/null http://127.0.0.1:8080/health && echo "  /health 200" || echo "  /health down"
  if [ -L /etc/nginx/sites-enabled/markdrop-api-bridge ]; then
    echo "  nginx: BRIDGE → $(grep -m1 -o 'https://[0-9.]*' /etc/nginx/sites-available/markdrop-api-bridge)"
  fi
  [ -f /var/log/markdrop-move-sync.log ] && { echo "  sync log:"; tail -3 /var/log/markdrop-move-sync.log | sed 's/^/    /'; }
  return 0
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  smoke) cmd_smoke ;;
  go-live) cmd_go_live ;;
  standby) cmd_standby ;;
  realip) cmd_realip "${2:-}" ;;
  bridge) cmd_bridge "${2:-}" ;;
  restore-backup) cmd_restore_backup "${2:-latest}" ;;
  issue-cert) cmd_issue_cert "${2:-}" ;;
  status) cmd_status ;;
  *) sed -n '3,16p' "$0"; exit 1 ;;
esac
