#!/usr/bin/env bash
# Connect the "Markdrop Guides" GitHub App to the API server (Import from GitHub + keep in sync).
# Create the app first: docs-platform/setup-github-app.md. Safe to re-run (also how you rotate a secret or key).
#  1. checks everything on this Mac: formats, the private key (RSA PEM), and, unless --skip-github-check,
#     asks GitHub with the app's own JWT that the App ID, slug, Client ID, permissions, Push event and
#     webhook URL are right, and that the client secret is accepted
#  2. on the API server: writes the 6 MARKDROP_DOCS_GITHUB_* settings into a temp copy of .env (replaced
#     or added, no duplicates), validates it by loading the app settings with the venv python (the key
#     must read back and match this file), then backs up .env, swaps, restarts, waits for health, and
#     restores the backup if the API isn't healthy
#  3. sends a signed test ping to the webhook URL to confirm the server has the same webhook secret
# Secrets are never printed, never on a command line (here or on the server) and travel over SSH stdin.
set -euo pipefail

SSH_KEY="${MARKDROP_SSH_KEY:-$HOME/Downloads/server.pem}"
SSH_HOST="${MARKDROP_SSH_HOST:-ubuntu@api.markdrop.in}"
REMOTE_BACKEND=/opt/markdrop/backend
WEBHOOK_URL=https://api.markdrop.in/api/v1/github/webhook
GITHUB_API=https://api.github.com
GITHUB_WEB=https://github.com
UA="User-Agent: markdrop-setup-github-app"

usage() {
  cat <<'EOF'
Usage: docs-platform/setup-github-app.sh [options]

  --app-id N           the App ID (GitHub › the app › General › About)
  --slug NAME          the app's slug, from its public page github.com/apps/<slug>
  --client-id ID       the Client ID (General › About)
  --private-key FILE   the .pem GitHub downloaded (Generate a private key)
  --dry-run            do every check, including writing and validating the new .env in a temp
                       folder on the server, but don't change .env or restart anything
  --skip-github-check  don't ask GitHub to confirm the app's settings (offline, or a deliberate mismatch)
  --local-dir DIR      test only: run the server half against DIR (holding .env and .venv) on this
                       Mac instead of over SSH; always a dry run
  -h, --help           this help

Missing --app-id / --slug / --client-id / --private-key are asked for when run in a terminal.
The two secrets are never arguments:
  in a terminal:  hidden prompts for the client secret, then the webhook secret
  otherwise:      read from stdin, client secret on line 1, webhook secret on line 2

Example:
  docs-platform/setup-github-app.sh --app-id 1234567 --slug markdrop-guides \
    --client-id Iv23liAbCdEf01234567 --private-key ~/keys/markdrop-guides.private-key.pem

Environment: MARKDROP_SSH_KEY (default ~/Downloads/server.pem), MARKDROP_SSH_HOST.
EOF
}

die() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }
warn() { echo "! $*" >&2; }

APP_ID="" SLUG="" CLIENT_ID="" KEY_FILE="" DRY_RUN=0 CHECK_GITHUB=1 LOCAL_DIR=""
need_value() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value (see --help)"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app-id) need_value "$@"; APP_ID=$2; shift 2 ;;
    --app-id=*) APP_ID=${1#*=}; shift ;;
    --slug) need_value "$@"; SLUG=$2; shift 2 ;;
    --slug=*) SLUG=${1#*=}; shift ;;
    --client-id) need_value "$@"; CLIENT_ID=$2; shift 2 ;;
    --client-id=*) CLIENT_ID=${1#*=}; shift ;;
    --private-key) need_value "$@"; KEY_FILE=$2; shift 2 ;;
    --private-key=*) KEY_FILE=${1#*=}; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-github-check) CHECK_GITHUB=0; shift ;;
    --local-dir) need_value "$@"; LOCAL_DIR=$2; shift 2 ;;
    --local-dir=*) LOCAL_DIR=${1#*=}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
[ -n "$LOCAL_DIR" ] && DRY_RUN=1

for tool in openssl curl python3 awk; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is needed on this Mac"
done

TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT

# ---------------------------------------------------------------- inputs
ask() { # ask VAR "Prompt" : prompt for a plain (non-secret) value when it wasn't passed
  local _v=""
  [ -t 0 ] || die "pass --$3 (no terminal to ask in)"
  read -r -p "$2: " _v
  printf -v "$1" '%s' "$_v"
}
[ -n "$APP_ID" ] || ask APP_ID "App ID" app-id
[ -n "$SLUG" ] || ask SLUG "App slug (github.com/apps/<slug>)" slug
[ -n "$CLIENT_ID" ] || ask CLIENT_ID "Client ID" client-id
[ -n "$KEY_FILE" ] || ask KEY_FILE "Private key file (.pem)" private-key
KEY_FILE=${KEY_FILE/#\~/$HOME}

CLIENT_SECRET="" WEBHOOK_SECRET=""
if [ -t 0 ]; then
  read -r -s -p "Client secret (hidden): " CLIENT_SECRET; echo >&2
  read -r -s -p "Webhook secret (hidden): " WEBHOOK_SECRET; echo >&2
else
  IFS= read -r CLIENT_SECRET || true
  IFS= read -r WEBHOOK_SECRET || true
fi
CLIENT_SECRET=${CLIENT_SECRET%$'\r'}
WEBHOOK_SECRET=${WEBHOOK_SECRET%$'\r'}

# ---------------------------------------------------------------- local checks
echo "• checking the values"
[[ $APP_ID =~ ^[1-9][0-9]{0,11}$ ]] || die "the App ID is a number (General › About › App ID)"
if ! [[ $SLUG =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || [ "${#SLUG}" -gt 64 ]; then
  die "the slug is lower-case letters, digits and dashes, as in github.com/apps/markdrop-guides"
fi
[[ $CLIENT_ID =~ ^[A-Za-z0-9._-]{8,64}$ ]] || die "that doesn't look like a Client ID (General › About › Client ID)"
case "$CLIENT_ID" in
  Iv*) ;;
  *) warn "the Client ID usually starts with Iv1. or Iv23; continuing" ;;
esac
[ -n "$CLIENT_SECRET" ] || die "the client secret is empty"
[[ $CLIENT_SECRET =~ ^[A-Za-z0-9._-]{20,}$ ]] \
  || die "that doesn't look like a client secret (GitHub shows 40 letters and digits once, when you generate it)"
[ "${#WEBHOOK_SECRET}" -ge 20 ] || die "the webhook secret needs at least 20 characters (make one with: openssl rand -hex 32)"
[[ $WEBHOOK_SECRET =~ ^[A-Za-z0-9._~+/=-]+$ ]] \
  || die "keep the webhook secret to letters, digits and - _ . ~ + / = (openssl rand -hex 32 is fine)"
[ "$CLIENT_SECRET" != "$WEBHOOK_SECRET" ] || die "the client secret and the webhook secret are the same: one was pasted twice"
ok "App ID $APP_ID, slug $SLUG, Client ID $CLIENT_ID, both secrets look right"

echo "• checking the private key"
if ! [ -f "$KEY_FILE" ] || ! [ -r "$KEY_FILE" ]; then die "can't read the private key file: $KEY_FILE"; fi
first_line=$(awk 'NF { print; exit }' "$KEY_FILE" | tr -d '\r')
case "$first_line" in
  "-----BEGIN RSA PRIVATE KEY-----"|"-----BEGIN PRIVATE KEY-----") ;;
  *) die "that file isn't the private key GitHub downloads (it starts with -----BEGIN RSA PRIVATE KEY-----)" ;;
esac
if grep -q "ENCRYPTED" "$KEY_FILE"; then die "that key is passphrase-protected; use the .pem exactly as GitHub downloaded it"; fi
openssl rsa -in "$KEY_FILE" -check -noout -passin pass: >/dev/null 2>&1 \
  || die "that file isn't a valid RSA private key (GitHub App keys are RSA)"
KEY_BITS=$(openssl rsa -in "$KEY_FILE" -noout -text -passin pass: 2>/dev/null | awk 'NR == 1 { gsub(/[^0-9 ]/, " "); print $1 }')
if grep -q '["\\]' "$KEY_FILE"; then die "unexpected quote or backslash in the key file"; fi
# One line, literal \n between the PEM lines; the backend turns "\n" back into newlines.
PEM_LINE=$(tr -d '\r' <"$KEY_FILE" | awk 'NF { printf "%s\\n", $0 }')
KEY_FP=$(openssl pkey -in "$KEY_FILE" -pubout -outform DER 2>/dev/null \
  | python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')
[ "${#KEY_FP}" -eq 64 ] || die "couldn't read the public half of the key"
perm=$(stat -f %Lp "$KEY_FILE" 2>/dev/null || stat -c %a "$KEY_FILE" 2>/dev/null || echo "")
case "$perm" in
  600|400|"") ;;
  *) warn "the key file is mode $perm; run: chmod 600 $(printf %q "$KEY_FILE")" ;;
esac
ok "RSA ${KEY_BITS:-?} bits, public key sha256 ${KEY_FP:0:16}…"

# ---------------------------------------------------------------- GitHub checks
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
app_jwt() {
  local now hdr pay sig
  now=$(date +%s)
  hdr=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  pay=$(printf '{"iat":%d,"exp":%d,"iss":%d}' $((now - 60)) $((now + 540)) "$APP_ID" | b64url)
  sig=$(printf '%s.%s' "$hdr" "$pay" | openssl dgst -sha256 -sign "$KEY_FILE" -passin pass: -binary | b64url)
  printf '%s.%s.%s' "$hdr" "$pay" "$sig"
}
github_app_get() { # github_app_get PATH OUTFILE -> prints the HTTP status; the JWT goes in on stdin
  printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\n%s\n' \
    "$(app_jwt)" "$UA" \
    | curl -sS --max-time 20 -H @- -D "$2.h" -o "$2" -w '%{http_code}' "$GITHUB_API$1"
}

if [ "$CHECK_GITHUB" = 1 ]; then
  echo "• asking GitHub about the app"
  code=$(github_app_get /app "$TMPD/app.json") \
    || die "couldn't reach api.github.com (offline? --skip-github-check skips these checks)"
  if [ "$code" != 200 ]; then
    msg=$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("message", ""))
except Exception: print("")' "$TMPD/app.json")
    case "$msg" in
      *"iat"*|*"exp"*|*"Expiration"*|*"Issued at"*)
        die "GitHub refused the app token ($code: $msg). This Mac's clock is off: System Settings › General › Date & Time › Set time automatically" ;;
      *) die "GitHub refused the app token ($code: ${msg:-no message}). The App ID and the private key don't belong together: check the App ID, or generate a new key" ;;
    esac
  fi
  python3 - "$TMPD/app.json" "$TMPD/app.json.h" "$APP_ID" "$SLUG" "$CLIENT_ID" <<'PY'
import email.utils, json, sys, time
body, headers, app_id, slug, client_id = sys.argv[1:6]
d = json.load(open(body))
errs, warns = [], []
if str(d.get("id")) != app_id:
    errs.append(f"GitHub says this key belongs to App ID {d.get('id')}, not {app_id}")
if d.get("slug") != slug:
    errs.append(f"the app's slug is {d.get('slug')!r}, not {slug!r} (see github.com/apps/<slug>)")
if d.get("client_id") and d.get("client_id") != client_id:
    errs.append(f"the app's Client ID is {d.get('client_id')}, not {client_id}")
perms = d.get("permissions") or {}
writes = sorted(k for k, v in perms.items() if v in ("write", "admin"))
if writes:
    errs.append("write access to " + ", ".join(writes) + ": set them to No access or Read-only (Markdrop never changes repositories)")
if perms.get("contents") != "read":
    errs.append("Repository permissions › Contents must be Read-only")
if perms.get("metadata") != "read":
    errs.append("Repository permissions › Metadata must be Read-only")
extra = sorted(k for k in perms if k not in ("contents", "metadata") and k not in writes)
if extra:
    warns.append("permissions Markdrop doesn't need: " + ", ".join(extra) + " (set them to No access)")
if "push" not in (d.get("events") or []):
    errs.append("Subscribe to events › Push isn't checked: without it pushes never sync")
for line in open(headers, errors="replace"):
    if line.lower().startswith("date:"):
        try:
            skew = time.time() - email.utils.parsedate_to_datetime(line.split(":", 1)[1].strip()).timestamp()
            if abs(skew) > 30:
                warns.append(f"this Mac's clock is {skew:+.0f} s off GitHub's")
        except Exception:
            pass
for w in warns:
    print("! " + w, file=sys.stderr)
if errs:
    for e in errs:
        print("✗ " + e, file=sys.stderr)
    sys.exit(1)
owner = (d.get("owner") or {}).get("login", "?")
print(f"✓ {d.get('name')} (owned by {owner}): Contents and Metadata read-only, Push on, "
      f"{d.get('installations_count', 0)} installation(s)")
PY

  code=$(github_app_get /app/hook/config "$TMPD/hook.json") || die "couldn't reach api.github.com"
  [ "$code" = 200 ] || die "GitHub didn't return the webhook settings ($code): is Webhook › Active checked?"
  python3 - "$TMPD/hook.json" "$WEBHOOK_URL" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); want = sys.argv[2]
errs = []
if (d.get("url") or "").rstrip("/") != want:
    errs.append(f"Webhook URL is {d.get('url') or '(empty)'!r}, should be {want}")
if str(d.get("insecure_ssl", "0")) != "0":
    errs.append("SSL verification is disabled: set Webhook › SSL verification to Enable")
if d.get("content_type") not in (None, "json"):
    print(f"! webhook content type is {d.get('content_type')!r}; GitHub Apps normally send json", file=sys.stderr)
if errs:
    for e in errs:
        print("✗ " + e, file=sys.stderr)
    sys.exit(1)
print("✓ webhook goes to " + want + " with SSL verification on")
PY

  # A made-up code: GitHub answers bad_verification_code when the client id + secret are right.
  oauth=$(printf 'client_id=%s&client_secret=%s&code=markdrop-setup-check' "$CLIENT_ID" "$CLIENT_SECRET" \
    | curl -sS --max-time 20 -X POST -H 'Accept: application/json' -H "$UA" --data-binary @- \
      "$GITHUB_WEB/login/oauth/access_token") || die "couldn't reach github.com"
  oauth_err=$(printf '%s' "$oauth" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("error", ""))
except Exception: print("unreadable")')
  case "$oauth_err" in
    bad_verification_code) ok "GitHub accepts the client secret" ;;
    incorrect_client_credentials) die "GitHub doesn't accept this Client ID + client secret: generate a new client secret and use that" ;;
    *) warn "couldn't confirm the client secret (GitHub said: ${oauth_err:-nothing}); continuing" ;;
  esac
else
  warn "skipping the GitHub checks (--skip-github-check)"
fi

# ---------------------------------------------------------------- server
# Runs on the server (or on --local-dir). Args: backend dir, dry run (0/1). Values arrive on stdin.
REMOTE_SCRIPT=$(cat <<'REMOTE'
set -euo pipefail
umask 077
BACKEND=$1; DRY=$2
IFS= read -r APP_ID; IFS= read -r SLUG; IFS= read -r CLIENT_ID
IFS= read -r CLIENT_SECRET; IFS= read -r WEBHOOK_SECRET; IFS= read -r PEM_LINE; IFS= read -r KEY_FP
cd "$BACKEND"
PY="$BACKEND/.venv/bin/python"
[ -f .env ] || { echo "✗ $BACKEND/.env not found"; exit 1; }
[ -x "$PY" ] || { echo "✗ $PY not found"; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export GH_APP_ID="$APP_ID" GH_SLUG="$SLUG" GH_CLIENT_ID="$CLIENT_ID" GH_CLIENT_SECRET="$CLIENT_SECRET" \
  GH_WEBHOOK_SECRET="$WEBHOOK_SECRET" GH_PEM_LINE="$PEM_LINE" GH_KEY_FP="$KEY_FP"
"$PY" - "$tmp/.env" <<'PY'
import os, sys
want = {
    "MARKDROP_DOCS_GITHUB_APP_ID": os.environ["GH_APP_ID"],
    "MARKDROP_DOCS_GITHUB_APP_SLUG": os.environ["GH_SLUG"],
    "MARKDROP_DOCS_GITHUB_CLIENT_ID": os.environ["GH_CLIENT_ID"],
    "MARKDROP_DOCS_GITHUB_CLIENT_SECRET": os.environ["GH_CLIENT_SECRET"],
    "MARKDROP_DOCS_GITHUB_WEBHOOK_SECRET": os.environ["GH_WEBHOOK_SECRET"],
    "MARKDROP_DOCS_GITHUB_APP_PRIVATE_KEY": '"' + os.environ["GH_PEM_LINE"] + '"',
}
out, seen, dropped = [], set(), 0
for line in open(".env").read().splitlines():
    k = line.split("=", 1)[0].strip()
    if k.startswith("export "):
        k = k[len("export "):].strip()
    if k in want:
        if k in seen:
            dropped += 1
            continue
        out.append(f"{k}={want[k]}"); seen.add(k)
    else:
        out.append(line)
out += [f"{k}={v}" for k, v in want.items() if k not in seen]
open(sys.argv[1], "w").write("\n".join(out) + "\n")
print(f"  .env: {len(seen)} replaced, {len(want) - len(seen)} added" + (f", {dropped} duplicate(s) removed" if dropped else ""))
PY
( cd "$tmp" && PYTHONPATH="$BACKEND" "$PY" - <<'PY'
import hashlib, hmac, os, sys
from app.config import Settings
fields = {
    "docs_github_app_id": "GH_APP_ID", "docs_github_app_slug": "GH_SLUG",
    "docs_github_client_id": "GH_CLIENT_ID", "docs_github_client_secret": "GH_CLIENT_SECRET",
    "docs_github_webhook_secret": "GH_WEBHOOK_SECRET", "docs_github_app_private_key": None,
}
missing = [f for f in fields if f not in Settings.model_fields]
if missing:
    sys.exit("✗ the API code here doesn't have " + ", ".join(missing) + " yet: deploy the backend with Import from GitHub first, then run this again")
s = Settings()
def val(v):
    v = v.get_secret_value() if hasattr(v, "get_secret_value") else v
    return "" if v is None else str(v).strip()
for f, env in fields.items():
    if env and not hmac.compare_digest(val(getattr(s, f)).encode(), os.environ[env].encode()):
        sys.exit(f"✗ {f.upper()} doesn't read back as written")
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
pem = val(s.docs_github_app_private_key).replace("\\n", "\n")
try:
    key = serialization.load_pem_private_key(pem.encode(), password=None)
except Exception as e:
    sys.exit(f"✗ the private key doesn't load from .env: {type(e).__name__}")
if not isinstance(key, rsa.RSAPrivateKey):
    sys.exit("✗ the private key isn't RSA")
der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
if hashlib.sha256(der).hexdigest() != os.environ["GH_KEY_FP"]:
    sys.exit("✗ the private key read back from .env isn't the one in the local file")
print(f"settings ok | app {s.docs_github_app_slug} (id {val(s.docs_github_app_id)}) | client id + secret set"
      f" | webhook secret set | private key RSA {key.key_size} bits, same as the local file")
PY
) || { echo "VALIDATION FAILED - nothing changed"; exit 1; }
if [ "$DRY" = 1 ]; then echo "Dry run: the new .env validated; nothing changed (no backup, no restart)"; exit 0; fi
ts=$(date +%Y%m%d%H%M%S); cp -p .env ".env.bak-$ts"
cp "$tmp/.env" .env.new; chmod 600 .env.new; mv .env.new .env
sudo systemctl restart markdrop || true
for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:8080/health >/dev/null && { echo "API healthy. The GitHub App is connected (backup: .env.bak-$ts)"; exit 0; }
  sleep 2
done
echo "NOT HEALTHY - restoring the backup"; cp -p ".env.bak-$ts" .env; sudo systemctl restart markdrop || true
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:8080/health >/dev/null && { echo "Backup restored, API healthy again"; exit 1; }; sleep 2; done
echo "Backup restored but the API still isn't healthy: check  sudo journalctl -u markdrop -n 80"; exit 1
REMOTE
)

send_values() {
  printf '%s\n' "$APP_ID" "$SLUG" "$CLIENT_ID" "$CLIENT_SECRET" "$WEBHOOK_SECRET" "$PEM_LINE" "$KEY_FP"
}

if [ -n "$LOCAL_DIR" ]; then
  echo "• checking against $LOCAL_DIR (local, dry run)"
  send_values | bash -c "$REMOTE_SCRIPT" setup-github-app "$LOCAL_DIR" 1
  exit 0
fi

[ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY (set MARKDROP_SSH_KEY)"
if [ "$DRY_RUN" = 1 ]; then echo "• checking on the API server (dry run)"; else echo "• configuring the API server"; fi
send_values | ssh -i "$SSH_KEY" -o ConnectTimeout=15 "$SSH_HOST" \
  "bash -c $(printf %q "$REMOTE_SCRIPT") setup-github-app $(printf %q "$REMOTE_BACKEND") $DRY_RUN"

[ "$DRY_RUN" = 1 ] && exit 0

# ---------------------------------------------------------------- webhook ping
if [ "$CHECK_GITHUB" = 1 ]; then
  echo "• sending a signed test ping to the webhook"
  body=$(printf '{"zen":"Markdrop setup check","hook_id":0,"hook":{"type":"App","app_id":%s}}' "$APP_ID")
  sig=$(printf '%s' "$body" | GH_WEBHOOK_SECRET="$WEBHOOK_SECRET" python3 -c 'import hashlib, hmac, os, sys
print("sha256=" + hmac.new(os.environ["GH_WEBHOOK_SECRET"].encode(), sys.stdin.buffer.read(), hashlib.sha256).hexdigest())')
  code=$(printf '%s' "$body" | curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -H 'X-GitHub-Event: ping' -H "X-GitHub-Delivery: markdrop-setup-$(date +%s)" \
    -H "X-Hub-Signature-256: $sig" -H "$UA" --data-binary @- "$WEBHOOK_URL") || code="unreachable"
  case "$code" in
    2??) ok "the webhook accepts GitHub's signature (HTTP $code)" ;;
    401|403) warn "the webhook rejected the signature (HTTP $code): the server's webhook secret isn't the one you typed" ;;
    404) warn "the webhook isn't there yet (HTTP 404): is the backend with Import from GitHub deployed?" ;;
    503) warn "the webhook says it isn't set up (HTTP 503): a setting is missing" ;;
    *) warn "the webhook answered $code; check the app's Advanced › Recent Deliveries after a real push" ;;
  esac
fi
echo "Done. Next: https://guides.markdrop.in/new?start=github › Connect GitHub (setup-github-app.md › Verify)"
