# Markdrop: onboarding for collaborators

> For a developer (and their Claude Code) working on Markdrop from a fresh clone of
> `github.com/himanshkukreja/markdrop`. You have **no production access**, and you don't need it:
> everything below runs on your machine against your own local services.
> Written 2026-10-13. If this file disagrees with the code, trust the code and tell the owner.
>
> **Setup for Claude Code:** this file is committed at the repo root. So that Claude loads it every session,
> create `CLAUDE.local.md` in the repo root (personal, git-ignored via `*.local.md`) containing the single
> line `@ONBOARDING.md`.

---

## 1. For Claude: read this first

**How to use this file.** Read it end to end before your first change. Sections 5 (setup), 7 (conventions)
and 8 (gotchas) are the ones you'll come back to. Section 3 maps the repo, so you rarely need a blind
`grep` to find where something lives.

**Rules of engagement**
- **Work on a branch, never on `main`.** Name it `feat/<thing>`, `fix/<thing>` or `chore/<thing>`.
  A push to `main` auto-deploys the frontend to production, so only the owner merges into it.
- **Hand work back as a pull request to the owner** (section 10). Don't merge, tag, release or deploy anything.
- **Don't commit or push unless your human asks you to.** Say plainly what you verified and what you didn't.
- **Never commit secrets.** `.env`, `.env.local` and friends are git-ignored; keep it that way. Never paste
  a key, token or password into code, commit messages, PR text or docs. This repo is **public**.
- **Never point local code at production.** The frontend, the VS Code extension and the CLI all default
  to the production API when you don't configure them (section 8). Always set the local URLs.
  Don't create test documents, accounts or traffic on markdrop.in.
- **Ask the owner before big changes**: new dependencies, new services, schema or index changes, auth or
  access-control logic, anything under `design-system/`, wide UI rewrites, or anything touching
  `backend/deploy.sh`, `worker/` or `.github/`.
- **Found a security problem?** Tell the owner privately. Don't describe it in a public issue, PR, commit
  message or code comment.
- **Never run `backend/deploy.sh`** or any release command (`vsce publish`, `wrangler deploy`, `cli/v*` tags).
- **No `Co-Authored-By` trailer** in commits. Override Claude Code's default commit attribution.

### Quick start (about 15 minutes)
1. Start MongoDB and Redis (5.1).
2. Backend: venv, `.env` from the 5.2 template, `uvicorn`, then `curl localhost:8080/health`.
3. Frontend: `cp .env.local.example .env.local && npm run dev` (5.3).
4. **Success check:** open http://localhost:3000/new and publish. The link must be
   `http://localhost:3000/<slug>` (not markdrop.in) and must render. Then paste `sample-mermaid-katex.md`
   to check diagrams and math.

Everything else (extension, CLI, design system, external accounts) is optional.

---

## 2. What Markdrop is

**Drop it. It renders.** (new positioning, not on `main` yet; see section 9.) Markdrop turns documents and files into links that render in any browser.
It is **not** a markdown-only tool. There are two headline pillars:

1. **Documents.** Write or paste markdown (including AI write-ups) and get `markdrop.in/<slug>`, rendered with
   GFM, syntax highlighting, Mermaid diagrams and KaTeX math. **No account needed.**
2. **Artifacts: files that render.** Upload an HTML page, PDF, spreadsheet (xlsx/xls/csv), Word doc, images,
   video or a zipped static site, and the link opens it rendered, with no download and no app. Needs a free account.

Brand promise: **"No login. No friction. Just links."** Short descriptor: *Docs and files as links that render.*

**Feature list**
| Feature | One line |
|---|---|
| Publish | Custom slug, edit/delete via a one-time edit secret, optional read password, expiry, view counts |
| E2E encryption | Opt-in AES-256-GCM in the browser; the key lives in the URL fragment (`#k=`), never sent to the server |
| Live refresh | Open pages refetch when the document changes (WebSocket ping, no content on the socket) |
| OG cards | Server-rendered 1200×630 link-preview images per slug (Pillow) |
| Accounts (optional) | Google OAuth or email OTP/magic link; dashboard, per-document analytics, API tokens |
| Access control | Per-document levels (`private` / `link` / `workspace`) plus email grants (viewer/editor) |
| Artifacts | Files stored in object storage, rendered on an isolated origin inside a sandboxed iframe |
| VS Code extension | "Markdrop Sync": publish and two-way sync of markdown and text-like files |
| Google Docs export | Markdown → Google Doc, with diagrams and math as images |
| README builder | `/builder`, drag-and-drop README sections (dnd-kit) |
| P2P file share | Browser-to-browser over WebRTC; multi-file; up to 10 recipients; TURN fallback when configured |
| Go CLI | `markdrop send <file\|folder>` / `markdrop get <room>`, interoperable with the browser share |
| Workspaces | Teams with roles, invitations, shared library, folders, branding, custom domains, tenant sign-in |
| Analytics | First-party, cookie-free site analytics plus an admin analytics center |
| Admin panel | `/admin`: documents, users, feature usage, feedback, email campaigns |

**Invariant: anonymous publishing stays first-class.** Accounts, workspaces and encryption are strictly
additive. A document with no owner and no workspace must behave exactly as it always has.

---

## 3. Repository map

```
markdrop/
├── backend/                 FastAPI API (Python)
│   ├── app/main.py          app factory, middleware order, all routers, GET /health
│   ├── app/config.py        Settings: every env var, prefix MARKDROP_, reads backend/.env
│   ├── app/database.py      Motor client; ALL indexes and TTLs are created here at startup
│   ├── app/limiter.py       shared slowapi limiter (Redis-backed)
│   ├── app/middleware/      tenant_cors.py: custom-domain CORS (outermost middleware, in-process cache)
│   ├── app/assets/          fonts for server-side image rendering
│   ├── app/routers/         HTTP + WS endpoints: documents, artifacts, access, sync, me, auth, google,
│   │                        og, live, share, beat, feedback, workspaces, folders, library, domains,
│   │                        invites, admin, admin_analytics
│   ├── app/services/        business logic (document.py, artifact.py, r2.py, access.py, workspace.py,
│   │                        mailer.py, gdocs.py, og_render.py, traffic.py, turn.py, …)
│   ├── app/schemas/         Pydantic v2 request/response models
│   ├── app/models/          plain dataclasses + workspace role ranks (no ODM)
│   ├── app/utils/           JWT helpers, Fernet crypto, client IP, slug rules (RESERVED_SLUGS)
│   ├── app/emails/          hand-pasted campaign HTML templates
│   ├── requirements.txt     direct deps pinned
│   ├── tests/               empty: there is no test suite yet
│   ├── scripts/             one-off ops scripts (owner-only; don't run them)
│   ├── deploy.sh            owner-only production deploy script. Don't run or edit.
│   └── Dockerfile           stale, unused
├── frontend/                Next.js 15 App Router, React 19, Tailwind 4 (CSS-first, no config file)
│   ├── src/app/             routes: / (landing), [slug] (viewer), new, upload, builder, dashboard,
│   │                        login, auth/*, settings/*, invite/[token], share, share/[id],
│   │                        enterprise, extension/authorize, h/[host]/[...path], admin, api/revalidate
│   ├── src/components/      UI (landing/, access/, workspace/, dashboard/, share/, new/, …)
│   ├── src/lib/             api.ts (API client), e2e.ts, p2p/*, track.ts, useQueryFlags.ts, slugify.ts, …
│   ├── src/contexts/        AuthContext (bearer token in localStorage)
│   ├── src/middleware.ts    non-primary hosts → /h/<host>/… rewrite (custom domains)
│   └── .env.local.example   NEXT_PUBLIC_API_URL=http://localhost:8080
├── worker/                  Cloudflare Worker: the isolated artifact origin (raw files + PDF/sheet/docx/
│                            text/video viewer pages + branding images); r2/cors.json is the bucket CORS
├── extension/               VS Code extension "Markdrop Sync" (TypeScript; src/extension.ts)
├── cli/                     Go P2P CLI (cobra + pion/webrtc); cmd/, internal/{peer,signaling,ui}
├── design-system/           tokens, fonts, React primitives/components for the UI revamp (section 9)
├── brand/                   generated brand kit (icons, wordmarks, lockups) via brand/build.py
├── .github/workflows/       release-cli.yml: the only CI, runs on CLI release tags (owner-only)
├── README.md                public product + engineering overview (partly stale; code wins)
├── FILESHARE.md             P2P deep dive
├── SCALING.md               early scaling plan; its "current architecture" is outdated
└── sample-mermaid-katex.md  handy render test document
```

Git-ignored on purpose: `.env`, `.env.local`, `.env.production`, `.env.*.local` (other names such as
`.env.development` are **not** ignored, so don't create them), `.claude/`, `.vscode/`, `.markdrop.json`,
`design/`, `CONTEXT.md`, `*.local.md`, build output. `backend/.env.example` and `frontend/.env.local.example`
are tracked on purpose.

---

## 4. Architecture

```
 Browser ──HTTPS──► Next.js frontend (SSR/ISR pages)
    │                    │ SSR fetch is ALWAYS anonymous
    │                    ▼
    ├──HTTPS/WSS──► FastAPI backend (ONE uvicorn worker) ──► MongoDB
    │                    │                                  ├► Redis (rate-limit counters only)
    │                    │                                  └► optional: email, Google, object storage,
    │                    │                                     TURN credentials, domains API, GeoIP
    ├──iframe────► Artifact origin (Cloudflare Worker + R2), a SEPARATE site
    │                    ▲ browser uploads go straight to R2 via presigned PUT
    └──WebRTC────► peer browser / Go CLI (signalling over the backend WebSocket)

 VS Code extension ──Bearer mdk_ token──► /api/v1/sync
```

- **Frontend (Next.js 15).** Pages render on the server with an anonymous fetch, then the client re-fetches
  with the user's bearer token. `/[slug]` uses ISR (`revalidate = 60` plus `generateStaticParams` returning `[]`).
  All auth guards run client-side. Custom domains are handled by `middleware.ts`, which rewrites any
  non-primary host to `/h/<host>/<path>` without a network call.
- **Backend (FastAPI).** REST under `/api/v1/*`, WebSockets at `/ws/docs/{slug}` (live refresh) and
  `/ws/share/{room}` (P2P signalling). Swagger is at `/docs`. **It runs as a single uvicorn worker by design**:
  P2P rooms, live-document pub/sub, the tenant CORS cache and the TURN credential cache all live in process
  memory. Running more than one worker would split rooms across processes. Going multi-worker needs Redis
  pub/sub first; don't add `--workers`.
- **MongoDB (Motor), no migrations.** `database.py` creates indexes at startup and only ever adds them.
  An absent field means "default" on read, so old documents keep working.
- **Redis** stores slowapi rate-limit counters, nothing else. It must be running.
- **Auth.** A 30-day HS256 JWT stored in `localStorage` and sent as `Authorization: Bearer`. No cookies.
  `mdk_` API tokens (for the extension) and short-lived tenant tokens (custom domains) go through the same path.
- **Artifact origin (Cloudflare Worker + R2).** File bytes never pass through the API. The browser uploads to
  R2 with a presigned PUT, the API confirms and stores metadata in the `documents` collection, and the viewer
  loads the file in a sandboxed iframe from the Worker. **Rule: user-authored HTML is never served from the
  app origin.** The session token, edit secrets and E2E keys live in web storage there, so HTML on that origin
  could take over accounts. `config.artifact_origin_is_isolated` refuses an artifact origin that isn't a
  separate site. Never navigate users top-level to the artifact origin either: it is iframe-only.
- **VS Code extension.** Signs in by minting an `mdk_` token through `/extension/authorize`. It pushes on save
  with a revision compare-and-swap; on conflict it opens a diff.
- **Go CLI.** Speaks P2P protocol v1 (single recipient). The browser speaks v2 and negotiates down for the CLI.

**Request flow, viewing a document:** the browser hits `/<slug>` → Next serves the ISR page (anonymous) →
the API's `get_document` checks workspace, access level and password, and answers 401 with an
`X-Markdrop-Gate: signin|password` header when the reader needs to act → the client hydrates, retries with its
token if locked, sends a view beacon, and opens the live-refresh socket.

---

## 5. Local development setup

**Prerequisites:** Python 3.12 or 3.13 (recommended; 3.14 may need source builds for some pins),
Node.js 20+ (22 works), Docker (or native MongoDB 7 + Redis), Go 1.25+ (CLI only; `cli/go.mod` requires
go 1.25.0, and an older Go auto-downloads it when `GOTOOLCHAIN=auto`), VS Code (extension only).

### 5.1 MongoDB and Redis
```bash
docker run -d --name markdrop-mongo -p 27017:27017 mongo:7
docker run -d --name markdrop-redis -p 6379:6379 redis:7
```
Next time: `docker start markdrop-mongo markdrop-redis`. To reset local data: `docker rm -f markdrop-mongo`
and re-run the command above.

### 5.2 Backend
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```
Create `backend/.env` **from this template, not by copying `.env.example`**. The example carries
production-shaped values (hosted-DB URI format, production redirect URIs, a production CNAME target)
that you don't want locally.
```bash
rand() { python3 -c 'import secrets; print(secrets.token_urlsafe(48))'; }
cat > .env <<EOF
MARKDROP_MONGODB_URI=mongodb://localhost:27017
MARKDROP_MONGODB_DB=markdrop_dev
MARKDROP_REDIS_URL=redis://localhost:6379
MARKDROP_CORS_ORIGINS=["http://localhost:3000","http://127.0.0.1:3000"]
MARKDROP_FRONTEND_URL=http://localhost:3000
MARKDROP_API_BASE_URL=http://localhost:8080
MARKDROP_AUTH_SECRET=$(rand)
MARKDROP_ADMIN_USERNAME=admin
MARKDROP_ADMIN_PASSWORD=$(rand)
MARKDROP_ADMIN_SECRET=$(rand)
MARKDROP_IP_HASH_SALT=$(rand)
MARKDROP_GOOGLE_REDIRECT_URI=http://localhost:8080/api/v1/auth/google/callback
MARKDROP_GOOGLE_DOCS_REDIRECT_URI=http://localhost:8080/api/v1/google/callback
MARKDROP_EMAIL_REPLY_TO=you@example.com
EOF
uvicorn app.main:app --reload --port 8080      # run FROM backend/ so .env is found
curl http://localhost:8080/health              # {"status":"ok"}; Swagger at http://localhost:8080/docs
```
Always generate your own value for every secret, as the template above does. Settings are cached at
import time: **restart the server after any `.env` change**. List values such as `CORS_ORIGINS` must be JSON.

**What works without any external account:** markdown publish/view/edit/delete, passwords, expiry,
E2E encryption, live refresh, OG cards, the README builder, P2P share (direct connections, STUN only),
workspaces and folders (without automatic domain attach), per-document analytics (without geo), and the
admin panel at `/admin` (log in with your local `MARKDROP_ADMIN_*` values; the password is the
`MARKDROP_ADMIN_PASSWORD` line in `backend/.env`, e.g. `grep ADMIN_PASSWORD backend/.env`).

**What needs your OWN test accounts** (never ask for or use the owner's). Unconfigured, the app degrades cleanly:
| Feature | Needs (env vars in `config.py`) | Without it |
|---|---|---|
| Email sign-in | Resend API key + a verified sender (`RESEND_API_KEY`, `EMAIL_FROM*`) | `POST /auth/email/request` → 503 |
| Google sign-in | Google OAuth client (`GOOGLE_CLIENT_ID/SECRET`, localhost redirect URIs) | 503 |
| Google Docs export | Same client + `drive.file` scope + `TOKEN_ENCRYPTION_KEY` (Fernet) | 503 |
| Artifacts | Your own Cloudflare account: R2 bucket + S3 token, your own deployed copy of `worker/`, matching `ARTIFACT_SIGNING_KEY`; the six `R2_*`/`ARTIFACT_*` vars | upload endpoints → 503; `GET /api/v1/artifacts/status` shows what's missing |
| Custom-domain attach | Hosting-provider domains API token (`VERCEL_*`) | attach → 501 (DNS verification still works) |
| TURN relay | Cloudflare Realtime TURN key (`CF_TURN_*`) | STUN only |
| Geo in analytics | MaxMind GeoLite2 `.mmdb` (`GEOIP_DB_PATH`) | geo fields are null |

If you set up artifacts: point your Worker's R2 binding at **your** bucket in a local, uncommitted edit of
`worker/wrangler.toml`. The artifact origin must be a different host from `FRONTEND_URL` or the backend refuses it.

**Signing in locally without email or Google.** Mint a session for a local user with your own local secret:
```bash
# from the repo root, in a second terminal (uvicorn keeps running in the first)
cd backend && source .venv/bin/activate
python - <<'EOF'
import asyncio
from app.database import connect, get_database
from app.services.user import upsert_user
from app.utils.auth import create_access_token
async def main():
    await connect()
    u = await upsert_user(get_database(), "dev@example.com", provider="email", name="Dev")
    print(create_access_token(u.id, u.email)[0])
asyncio.run(main())
EOF
```
Then, in the browser console on `http://localhost:3000`: `localStorage.setItem("markdrop_token", "<token>")`
and reload. MongoDB must be running; the API doesn't need to be. After the reload the header should show
you signed in and `/dashboard` should load. Use `@example.com` addresses (`.test`/`.invalid` are rejected
by the email validator).

### 5.3 Frontend
```bash
cd frontend
npm install
cp .env.local.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:8080
npm run dev                            # http://localhost:3000
```
> **WARNING: if `NEXT_PUBLIC_API_URL` is unset, the frontend talks to the PRODUCTION API.** The default in
> `lib/api.ts` and several other modules is the production URL. Check `.env.local` exists before every
> `npm run dev` or `npm run build`. `NEXT_PUBLIC_*` values are inlined at build time, so restart or rebuild after changing them.
> Likewise `NEXT_PUBLIC_PRIMARY_HOST` defaults to `www.markdrop.in`. If you test custom-domain/tenant
> sign-in locally, set `NEXT_PUBLIC_PRIMARY_HOST=localhost:3000` in `.env.local`.

Optional: `NEXT_PUBLIC_PRIMARY_HOSTS` (the comma-separated list of non-tenant hosts; see section 8) and
`NEXT_PUBLIC_MAX_CONTENT_CHARS`. The defaults are fine for localhost. After running `tsc` or `npm run build`,
`git checkout frontend/tsconfig.tsbuildinfo` before committing (it's tracked by mistake).

### 5.4 VS Code extension
```bash
cd extension && npm install && npm run compile
```
Open `extension/` as its own VS Code window and press F5. `.vscode/` is git-ignored, so create
`extension/.vscode/launch.json` yourself:
```json
{ "version": "0.2.0", "configurations": [{ "name": "Run Extension", "type": "extensionHost",
  "request": "launch", "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
  "outFiles": ["${workspaceFolder}/out/**/*.js"], "preLaunchTask": "npm: compile" }] }
```
In the dev host, **set `markdrop.apiUrl` to `http://localhost:8080` and `markdrop.webUrl` to
`http://localhost:3000`** (they default to production). The `vscode://` deep link opens your normal VS Code,
not the F5 host. Instead, run the command **"Markdrop: Sign in with API token"** (`markdrop.signInWithToken`)
and paste a token created at `http://localhost:3000/settings/tokens`.
Don't publish this repo's own files with the extension.

### 5.5 Go CLI
```bash
cd cli && make build                   # writes ./markdrop
./markdrop send ./somefile --server http://localhost:8080 --origin http://localhost:3000
./markdrop get <room-id> --server http://localhost:8080 --origin http://localhost:3000
```
Without `--server` it uses the production signalling server. Note that `cli/markdrop` is (mistakenly) a tracked
binary, so **don't commit the rebuilt binary**: `git checkout cli/markdrop` before committing.

### 5.6 Design system preview
```bash
cd design-system && npm install
npm run preview                        # http://localhost:4000/previews/  (Dark / Light switch at the top)
npm run build                          # after editing tokens/tokens.json or src/
```
Never hand-edit generated files (`tokens.css`, `type-classes.css`, `tailwind-theme.css`, `bundle/`).

---

## 6. How to verify changes

There is **no automated test suite** and no backend/frontend CI. Verify every change by hand with these:

| Area | Command |
|---|---|
| Frontend types | `cd frontend && npx tsc --noEmit` |
| Frontend build (also checks ISR) | `cd frontend && npm run build` (`/[slug]` must appear under `dynamicRoutes` in `.next/prerender-manifest.json`) |
| Backend syntax | `cd backend && python -m compileall -q app` (or `python -m py_compile <file>`) |
| Backend boot | start uvicorn; startup runs every index creation, so a bad index spec fails here |
| Extension | `cd extension && npm run compile` |
| CLI | `cd cli && go vet ./... && make build` |
| Design system | `cd design-system && npm run build` |

`npm run lint` is **not** a usable gate: there is no ESLint config, so it prompts for setup.

**Manual checks that catch real regressions**
- Publish anonymously at `/new`, open the link, edit with the secret, delete. Do this after *any* document change.
- Open the same document in a private window (anonymous) and signed in.
- For a viewer change, load the page with JavaScript disabled: the content must be in the SSR HTML.
- For E2E, publish an encrypted doc on `localhost` (a secure context) and reopen it from the link.
- For P2P, send between two tabs on `localhost`, then try browser ↔ CLI. Check UI at desktop and phone widths.
- Exercise API changes with `curl` or Swagger at `/docs`; remember curl doesn't send CORS preflights, so also test from the browser.

**Adding tests is welcome.** If you touch an area, adding focused tests there (pytest + httpx against a
throwaway local database, or a small frontend test setup) is a good contribution. Agree the tooling with the owner first.

---

## 7. Conventions

**Git**
- Conventional commits: `type(scope): subject`, e.g. `fix(viewer): keep the gate after a failed unlock`.
  Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `content`. Scopes follow the area (`viewer`, `share`,
  `artifacts`, `workspaces`, `admin`, `extension`, `cli`, …).
- Commit bodies explain **why** and name the **root cause**, not just what changed. Mention rejected
  alternatives and how you verified the change.
- **No `Co-Authored-By` trailer** in this repo (owner's rule).
- Small, focused PRs. Don't mix refactors or formatting sweeps into a feature.

**Product and copy**
- UI copy is sentence case, plain, second person, present tense. Buttons are verbs that restate the outcome
  ("Publish", "Copy link"), never "OK" or "Submit". Status is a word plus a mark, not color alone. No emoji
  in UI chrome. The wordmark is always lowercase `markdrop`; in prose it's "Markdrop".
- Be honest and specific about privacy. For E2E, say "Markdrop stores ciphertext it has no key for", not
  "only authorised people can read it" (the link is the key). For P2P, don't claim bytes "never touch a
  server": a relay may carry them, and transfer metadata is logged.
- Remove a marketing claim the moment it stops being true. Don't promise unbuilt features.
- Emails are light-on-white (mobile Gmail force-inverts dark emails). Never rename or delete
  `frontend/public/email/*.png`: already-sent emails link to them.

**Design**
- New or reworked UI uses the **design-system tokens** (`bg-surface`, `text-text-muted`, `border-border`,
  `bg-accent`, `text-body`, …). **No raw hex and no Tailwind palette classes** (`bg-gray-900`, `text-blue-500`)
  in new UI. See `design-system/BRAND.md` and `design-system/README.md`.
- The design system is built on a **16px root**. The app still has `html { font-size: 17px }` in
  `globals.css`, so rem sizes come out about 6% larger until the revamp removes it. Don't "fix" it in passing;
  it's a planned, app-wide step.
- Until the revamp lands, the shipped app is dark-only. Keep the `@variant vscode` line in `globals.css`
  (removing it breaks compilation of old classes). Grid/flex children that hold long text need `min-w-0`.

**Backend**
- **Additive changes only.** Anonymous, owner-less and workspace-less documents must keep behaving exactly as before.
- **A new `Document` field must be added to `_doc_from_mongo`** in `backend/app/services/document.py`,
  with a default. Otherwise it is silently dropped and the feature is inert.
- Queries must tolerate missing fields (`{"kind": {"$ne": "artifact"}}`, not `{"kind": "markdown"}`).
- Indexes live in `database.py` and are only added. Changing an existing index's options under the same
  keys crashes startup.
- An invisible or non-member resource returns **404, not 403**, so existence isn't confirmed.
- Encrypted documents: every path that needs plaintext (copy, export, sync, admin edit) refuses with a clear error.
- **Server before client for new API fields.** Pydantic silently drops unknown fields, so the backend change
  must be deployed before a frontend that sends the field. Say so in the PR; the owner sequences the deploy.
- Keep in sync across the stack: `frontend/src/lib/slugify.ts` ↔ `backend/app/utils/slug.py`;
  `APP_ROUTES` in `frontend/src/lib/analyticsPath.ts` ↔ `backend/app/services/traffic.py`. When you add a
  top-level frontend route, add it to `APP_ROUTES` (both) and to `RESERVED_SLUGS` in `utils/slug.py`.
- Never serve user-authored HTML from the app origin (section 4).

**Frontend**
- **Never use `useSearchParams` in viewer routes** (`/[slug]`, `/h/...`). It turned the viewer into a
  client-only render with an empty `<main>`. Use `lib/useQueryFlags.ts` and wait for `ready`.
- `revalidate` on a dynamic segment only works with `generateStaticParams` (returning `[]` is enough).
- The SSR fetch is always anonymous (there is no localStorage on the server). Keep it that way so ISR caching stays safe.
- Read `localStorage`, `sessionStorage` and `location` in effects, never during render (hydration mismatches).
- Mount the artifact iframe only after hydration; one in the SSR HTML loads twice.
- Keep `lib/workspaces.ts` and other heavy modules out of `lib/api.ts`, which loads on every public document page.

---

## 8. Gotchas that cost real time

| Symptom | Cause | Fix |
|---|---|---|
| Your local frontend shows real documents | `NEXT_PUBLIC_API_URL` unset, so it hit production | Set it in `frontend/.env.local`, restart dev / rebuild |
| Env change has no effect (backend) | Settings cached at import | Restart uvicorn |
| Env change has no effect (frontend) | `NEXT_PUBLIC_*` inlined at build | Restart `npm run dev` / rebuild |
| Backend won't start: settings parse error | A list env var (`CORS_ORIGINS`) isn't JSON | `["http://localhost:3000"]`. If you `source` the file in a shell, single-quote it: `'["…"]'` |
| Every rate-limited route returns 500 | Redis isn't running | Start the Redis container |
| 429s in a test right after restarting the API | Rate-limit counters live in Redis and survive restarts | `redis-cli --scan --pattern 'LIMITS:*' \| xargs redis-cli del` (local only) |
| "Restarted" server still runs old code | Previous uvicorn still holds the port | Wait until `lsof -ti tcp:8080` is empty before starting again |
| Browser shows a CORS error on an API call | Often an unhandled 500 (the exception skips CORS headers) | Read the uvicorn log first |
| Every page 404s when opened from a phone on your LAN | The middleware treats a LAN IP as a custom (tenant) domain | Use `localhost`, or set `NEXT_PUBLIC_PRIMARY_HOSTS=markdrop.in,www.markdrop.in,localhost,<LAN-IP-or-tunnel-host>` (it *replaces* the default list, so keep `localhost`), point `NEXT_PUBLIC_API_URL` at an address the phone can reach, add that origin to backend `MARKDROP_CORS_ORIGINS`, and restart both |
| E2E encryption fails on `http://192.168…` | WebCrypto needs a secure context | `localhost` or https only |
| Email validation rejects your test address | `.test` / `.invalid` TLDs are refused | Use `@example.com` |
| A just-edited doc looks stale in a production build | ISR caches `/[slug]` for 60 s | `POST /api/revalidate {"slug":"…"}` on the frontend, or wait |
| Every document renders as 404 | The API is down or erroring (non-401 errors render "not found") | Check the backend, not the document |
| Analytics beacons "succeed" but nothing is recorded | Beacons always return 204 | Check MongoDB, not the status code |
| `grep` returns minified junk | A stray `.next` build folder | `grep -r --exclude-dir=.next --exclude-dir=node_modules` |
| `git status` shows `frontend/tsconfig.tsbuildinfo` or `cli/markdrop` modified | Both are build outputs tracked by mistake | Don't commit them; `git checkout` them |
| Extension sign-in never returns to the F5 window | `vscode://` opens your main VS Code | Paste an API token instead |

---

## 9. Current direction

- **UI revamp onto the design system.** `design-system/` holds the target: semantic tokens, Manrope +
  JetBrains Mono, 31 primitives and 17 Markdrop components, with **two equal themes**: dark (today's palette)
  and a new light theme (called "Light" in the committed tokens; the owner is refining it as "Mist", a dimmed
  slate with no pure white, in work not yet merged to `main`).
  **Nothing in `frontend/` uses it yet.** Wiring it in (tokens + Tailwind theme in `globals.css`, fonts,
  a no-flash theme switch, the 16px root) is "Phase 0" of the plan. `design-system/REVAMP_PLAN.md` (not in
  the repo yet; ask the owner for a copy) is the full phased plan (IA, theming, page-by-page redesign,
  codemod, QA). The owner is driving the revamp,
  so **coordinate before touching `design-system/` or doing app-wide restyling**.
- **Positioning change.** The product moved from "paste markdown, get a link" to **"Drop it. It renders."**,
  with documents and artifacts as equal pillars. `design-system/POSITIONING.md` (not in the repo yet; ask the
  owner for a copy) has the full copy kit (headline, subhead, title, meta description, CTAs "Start writing" /
  "Upload a file" / "Send a file"). New copy should follow it. **This copy sweep is not on `main` yet.** A fresh
  clone still shows the old landing copy. Don't redo the sweep yourself.
- **In flight at a high level:** the revamp foundations, the brand kit (`brand/`) not yet wired into the app,
  extension and CLI releases, and continued P2P reliability work. Ask the owner what's current before
  picking any of these up.

**How to pick work:** ask the owner. Don't start on something large uninvited. Tell the owner which item you're
taking before you start (or open a draft PR early) so two people don't do the same work. Good first areas,
low-risk and well-contained:
- Tests for a backend service you're touching (there are none yet).
- Completing `backend/.env.example` with every var from `config.py`, using local-safe placeholder values.
- Dashboard pagination (it shows only the first 20 documents).
- The extension's `.htm` handling: the server's extension map knows `html` but not `htm`, so `.htm` files publish as markdown.
- Fixing stale docs: README sections, `cli/README.md`.
- Untracking the build outputs (`cli/markdrop`, `frontend/tsconfig.tsbuildinfo`). Check with the owner first.
- Accessibility and mobile fixes on a single page, using design-system tokens.

---

## 10. Who to ask, and how to hand work back

**Owner:** Himanshu Kukreja, the sole maintainer. Ask him about scope, product and design decisions, anything
needing production (deploys, data, real accounts, secrets), and before any "ask first" change from section 1.
Reach him on GitHub (@himanshkukreja) or your usual private chat. For security issues, use only the private
channel, never GitHub.

**Handing work back**
1. Fork `himanshkukreja/markdrop` on GitHub, clone your fork, then
   `git remote add upstream https://github.com/himanshkukreja/markdrop.git`. Start each branch with
   `git fetch upstream && git switch -c feat/<thing> upstream/main`.
2. Make focused commits following section 7.
3. Run the checks from section 6 that apply; make sure `git status` shows no `.env`, secrets, rebuilt
   binaries or `tsbuildinfo`.
4. Open a PR from your fork to `himanshkukreja/markdrop:main` with:
   - **What and why** (the root cause for fixes);
   - **How you verified it** (commands run, manual steps, what you did *not* test);
   - **Screenshots** for UI changes (desktop and phone; both themes once the light theme exists);
   - **Deploy notes**: backend-first needed? New env vars (names only)? New indexes or fields?
   - Anything you noticed but deliberately left alone.
5. The owner reviews, merges and deploys. Never deploy, release or push to `main` yourself.
