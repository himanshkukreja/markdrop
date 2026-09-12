# Markdrop — Context Transfer

Paste this at the start of a new session to pick up where we left off.
Last updated after the artifacts + VS Code HTML-sync work (`2f5ae6a`, `main`).

---

## What Markdrop is

**markdrop.in** — publish something, get a link that renders it.

It started as an anonymous markdown publisher (Rentry-like) and grew into a
small platform. The through-line: *anything you'd otherwise paste as raw text or
send as an unopenable attachment becomes a URL that just renders.*

Anonymous publishing is still first-class — accounts are additive, never
required for markdown.

### Feature surface

| Area | What it does |
|---|---|
| **Markdown publishing** | Paste → link. Custom slug, password, expiry, view counts, edit-by-secret. Mermaid + KaTeX render client-side. |
| **Artifacts** | Upload/paste HTML, PDF, Excel/CSV, Word, images, or a zipped site → a link that *renders* it. **The newest and largest feature.** |
| **VS Code sync** | Two-way sync of `.md` *and* `.html`/`.txt`/`.csv`/`.json`/`.svg` from the editor. Extension `HimanshuKukreja.markdrop`. |
| **Google Docs export** | md → Google Doc, with Mermaid/LaTeX/ASCII diagrams pre-rendered to PNGs (Drive can't render them). |
| **P2P file share** | Browser-to-browser over WebRTC, bytes never touch the server. Go CLI too. |
| **README builder** | `/builder` — drag-and-drop from ~45 section templates. |
| **Accounts** | Optional passwordless login (Google + email OTP/magic link), dashboard, per-doc analytics, API tokens. |
| **Admin** | `/admin` — documents, users, feature usage, feedback, **email campaigns**. |

---

## Architecture

```
markdrop.in (Vercel, region bom1)          ← Next.js 15 App Router, Tailwind v4
        │
        ├── api.markdrop.in (EC2 ap-south-1) ← FastAPI, nginx, systemd, Redis
        │        └── MongoDB Atlas (M0, 512 MB)
        │
        └── markdrop-artifacts.markdrop-in.workers.dev
                 ← Cloudflare Worker + R2 binding (the artifact origin)
```

Repo is a monorepo: `backend/` `frontend/` `worker/` `extension/` `cli/`

### The one architectural rule that governs everything

**User-authored HTML must never be served from the markdrop.in origin.**

The session token lives in `localStorage['markdrop_token']`; edit secrets and
read passwords live in `sessionStorage`. HTML on that origin could read all of
it. So artifacts render in a sandboxed iframe pointed at a *separate registrable
site*. `config.artifact_origin_is_isolated` refuses the app's own origin outright
and allows a subdomain only behind an explicit flag.

`*.workers.dev` is on the Public Suffix List, so it counts as a separate site
for cookies **and** domain reputation — for free. Artifact URLs are derived at
read time, never stored, so swapping in a bought domain later is one env var.

---

## Artifacts — how it actually works

**Upload** is a two-step handshake so bytes never touch the 2-vCPU EC2 box:

1. `POST /api/v1/artifacts/upload-url` → validates type + quota, returns a
   presigned PUT. The signature binds `Content-Type`, so a client can't declare
   CSV and upload HTML.
2. Browser PUTs straight to R2.
3. `POST /api/v1/artifacts` → server `HEAD`s the object for its **real** size
   and type before committing. A presigned PUT can't enforce a length range, so
   the declared size from step 1 is advisory only.

**Storage model.** Artifacts live in the same `documents` collection with
`kind: "artifact"` — inheriting slug uniqueness, edit secrets, password gating,
expiry TTL, ownership, analytics, reports and the dashboard. Extra fields:
`mime`, `blob_key`, `size_bytes`, `original_filename`, `bundle_prefix`.

`content` on an artifact is **only a filename stand-in for search** — never the
file. Several bugs came from code treating it as the document.

**Keys are random per-owner** (`art/<user_id>/<token>`), deliberately *not*
content-addressed: a client-supplied hash as the key would let one account
overwrite another's artifact.

**Privacy is fail-closed.** The Worker serves without a signed token only when
R2 metadata says `public=1`. Anything unmarked requires a token. The backend
marks objects on every creation path and flips the flag when a password is
added/removed, walking every object of a bundle.

**Bundles** (zipped sites) explode into one prefix; the doc points at the entry
HTML so relative assets resolve as siblings with no rewriting. Extraction caps
entry count, per-file and total uncompressed size (zip bombs) and refuses
entries escaping the prefix. Delete clears the whole prefix.

**Editor-synced blobs** are marked `live` and served `no-cache,
must-revalidate` — they keep a stable key while their bytes change, so a
revalidating header is what makes an edit visible.

---

## Deployment

**Backend** — push to `main`, then:

```bash
ssh -i ~/Downloads/server.pem ubuntu@ec2-43-205-199-138.ap-south-1.compute.amazonaws.com \
  /opt/markdrop/backend/deploy.sh
```

Hard-resets to origin/main (keeps git-ignored `.env`), reinstalls deps only if
`requirements.txt` changed, restarts systemd, polls `/health`.

**Frontend** — Vercel auto-deploys on push to `main`.

**Worker** — `cd worker && npx wrangler deploy` (manual).

**Extension** — bump `package.json` version, `npx @vscode/vsce package`, then
either `npx @vscode/vsce publish` (needs an Azure DevOps PAT with
*Marketplace → Manage*, org scope **All accessible organizations**) or upload the
`.vsix` at `marketplace.visualstudio.com/manage/publishers/HimanshuKukreja`.
Publishing does **not** push to your own editor — install the `.vsix` locally to
test. Users auto-update within a day.

**Server env** lives only at `/opt/markdrop/backend/.env` (mode 600), never
committed. See `backend/.env.example` for the full key list.

---

## Commit + working rules

- **Never add a `Co-Authored-By` trailer.** Plain conventional commits only.
- Conventional prefixes: `feat(scope):` `fix(scope):` `docs(scope):` `chore(scope):`
- Commit bodies explain **why**, and name the root cause when fixing something.
- Don't commit or push unless asked. Branch first if on `main` for large work.
- Never invent credentials, ticket IDs, or SRI hashes.

---

## Hard-won gotchas — read before debugging

**Verification**
- Local `next build` chunk hashes **never** match Vercel's. To check what's
  deployed, grep the served bundle for a string unique to the commit.
- `/[slug]` is ISR-cached, so its HTML keeps old chunk names across deploys — a
  static route like `/upload` is the honest signal.
- `export const revalidate` alone does nothing on a dynamic segment; it also
  needs `generateStaticParams` (returning `[]` is enough) or
  `prerender-manifest.json` `dynamicRoutes` stays empty.

**Cloudflare / R2**
- Bot protection **403s the `Python-urllib` UA** on workers.dev. Browsers, curl
  and `requests` are fine. Cost a false "the Worker is broken" alarm.
- R2 buckets have **no CORS by default** — browser uploads need a policy
  (`worker/r2/cors.json`). curl and Python don't send preflights, so tests pass
  while the browser fails.
- Registering the account workers.dev subdomain has no wrangler command, and an
  existing one **cannot be renamed**.
- Wrangler's OAuth session cannot create account API tokens — R2 S3 credentials
  must be made in the dashboard.

**Browser / email**
- `<embed type="application/pdf">` silently fails inside a sandboxed iframe
  (plugins are blocked). PDFs render via PDF.js to canvas, plus its text layer
  or the content isn't selectable.
- The `download` attribute is **ignored cross-origin** — it navigates instead.
  Artifacts expose a separate `download_url` (raw `/r/<key>`) because
  `artifact_url` is a *viewer page* for PDF/sheet/docx.
- `blob:` URLs **inherit the creating page's origin** — never preview user HTML
  that way. `srcDoc` + sandbox without `allow-same-origin` gives an opaque origin.
- Gmail's mobile apps ignore `color-scheme` and `prefers-color-scheme` and
  force-invert. Inversion flips white text dark but leaves saturated colours
  alone, so **email templates must be light-on-white**, never dark with light text.
- Never hand-write an SRI hash. Download and
  `openssl dgst -sha512 -binary | openssl base64 -A`.

**Infra**
- `html { font-size: 17px }` — rem sizes are 6% larger than the 16px default.
- Grid/flex items default to `min-width: auto` and won't shrink below
  min-content. One wide descendant widens the whole column past the viewport;
  `[&>*]:min-w-0` is the fix. This is what actually broke mobile, not font size.
- nginx `client_max_body_size` defaults to **1 MB**. Limits are now a ladder:
  nginx 12 MB > paste/sync 10 MB > markdown 500k chars; direct upload 25 MB
  never traverses nginx.
- Single uvicorn worker is **load-bearing** — the live-doc WebSocket and P2P
  signalling both use in-process state. Scaling to multiple workers needs Redis
  pub/sub first.

---

## Current state (verified)

- Cluster **17.3 MB of 512 MB** (`sample_mflix`, 137 MB of MongoDB demo data,
  was dropped — it was 91% of usage)
- 1,412 documents · **22 artifacts** · 15 users · 4 campaigns
- Page TTFB **0.23–0.35 s** (was 1.5–3.1 s) after: nginx gzip, Vercel region
  pinned to `bom1`, ISR on `/[slug]`
- Extension **0.3.0** built; Marketplace shows **0.2.0** — publish is pending

---

## Open / not built

- **Extension 0.3.0 not published** to the Marketplace yet
- Artifact **screenshots for OG cards** (currently a type-and-filename card;
  real screenshots need headless Chrome, which the 2-vCPU box won't love)
- **PPTX**, artifact-specific analytics, artifact versions/history
- `markdrop-in.workers.dev` still trips Chrome's **lookalike-domain** warning on
  *top-level* navigation (nothing navigates there now). A bought domain is one
  env var if it ever matters.
- Deferred: document version history via the existing `rev`, GitHub OAuth,
  folders/search, Google Docs two-way sync (Phase 3)

---

## Working agreements from this session

- Prefers Python/FastAPI, values simplicity, thinks in production systems
- Cares a lot about UI quality — "use the best UI you can", no generic layouts
- Wants root causes named, not just symptoms patched
- Verify against live systems rather than assuming; say plainly when something
  is unverified
