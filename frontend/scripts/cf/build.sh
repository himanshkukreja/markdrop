#!/usr/bin/env bash
# Cloudflare Workers build (OpenNext): docs snapshot -> next build (MARKDROP_CF_BUILD=1) -> OpenNext bundle ->
# ASCII-only handler + _headers. Production NEXT_PUBLIC_* values must be in the environment (they are inlined);
# never put them in a .env file here: OpenNext inlines .env* files into the Worker.
set -euo pipefail
cd "$(dirname "$0")/../.."
for f in .env .env.local .env.production .env.production.local; do
  [ -e "$f" ] && [ -z "${CF_ALLOW_DOTENV:-}" ] || continue
  echo "cf build: a .env file is in frontend/; OpenNext would bundle it into the Worker. Move it away (or CF_ALLOW_DOTENV=1)." >&2
  exit 1
done
export MARKDROP_CF_BUILD=1
export NEXT_PUBLIC_VERCEL_INSIGHTS=off
export NEXT_TELEMETRY_DISABLED=1
# the service worker's build id (next.config.ts): Vercel uses its deployment id
export MARKDROP_BUILD_ID="${MARKDROP_BUILD_ID:-cf-$(git rev-parse --short=12 HEAD 2>/dev/null || date +%s)}"
node scripts/cf/docs-snapshot.mjs
npx opennextjs-cloudflare build
node scripts/cf/postbuild.mjs
