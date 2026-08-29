# Markdrop

Minimal, anonymous markdown publishing tool. Paste markdown, get a shareable link instantly — no login required.

**Live:** [markdrop.in](https://markdrop.in)

---

## Features

### Publishing
- Paste markdown and publish with one click — no account needed
- Shareable links (`markdrop.in/abc123` or a custom slug you pick)
- Write / Split / Preview editor modes with scroll sync, and a markdown toolbar
- Syntax-highlighted code blocks, **Mermaid diagrams**, and **KaTeX math**
- Edit or delete via a secret key shown once at publish — built-in editor
- **Password protection**, **expiry** (1d / 7d / 30d / custom), and view counts
- **Dynamic link previews** — pasting a link in Slack/X/LinkedIn renders a card
- Export to PDF, raw markdown view, 3 themes, fully responsive

### Artifacts — share more than markdown
- Paste an **HTML page** or upload a **PDF**, **Word doc**, **Excel/CSV**, image,
  or a **zipped site** (HTML + CSS + JS + assets) and get a link that *renders* it
- Rendered on an **isolated origin**, so a published page can never reach your
  Markdrop account — see [Artifacts](#artifacts) below
- Same password, expiry, analytics and abuse-reporting as any document

### Beyond the browser
- **[README / markdown builder](https://markdrop.in/builder)** — assemble a doc
  from 45+ drag-and-drop section templates, then publish or download it
- **VS Code extension** — publish a `.md` file and two-way sync it on save
- **Export to Google Docs** — with Mermaid, LaTeX and ASCII diagrams rendered to
  images, since Drive's importer can't render them
- **P2P file sharing** — send any file browser-to-browser over WebRTC, with
  nothing stored on the server ([technical docs →](FILESHARE.md))
- **CLI** (`markdrop`) for file sharing from a terminal

### Accounts (all optional)
- Passwordless login (Google, or email magic-link / OTP)
- Dashboard of your documents and artifacts, with view / PDF / copy counts
- Per-document analytics: time series, countries, referrers
- API tokens for the extension and scripting
- Anonymous publishing keeps working exactly as before — accounts are additive

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI (Python 3.12+) |
| Frontend | Next.js 15 (App Router) + Tailwind CSS v4 |
| Database | MongoDB Atlas (Motor async driver) |
| Artifact storage | Cloudflare R2 (S3-compatible) |
| Artifact origin | Cloudflare Worker on a separate domain |
| Rate limiting | slowapi + Redis |
| Image rendering | Pillow (OG cards, diagrams) + matplotlib (LaTeX) |
| Frontend hosting | Vercel (`bom1`, co-located with the API) |
| Backend hosting | AWS EC2 (`ap-south-1`) + nginx + systemd |
| Editor integration | VS Code extension (TypeScript) |
| CLI | Go + GoReleaser |

---

## Project Structure

```
markdrop/
├── backend/                # FastAPI app
│   ├── app/
│   │   ├── main.py         # Entrypoint, lifespan (DB connect/disconnect)
│   │   ├── config.py       # Pydantic settings (env vars)
│   │   ├── database.py     # Motor MongoDB client + index setup
│   │   ├── models/         # Plain Python dataclasses
│   │   ├── schemas/        # Pydantic request/response schemas
│   │   ├── routers/
│   │   │   ├── documents.py  # Document CRUD, claim/copy, events, reports
│   │   │   ├── artifacts.py  # Artifact upload (presign → confirm) + paste
│   │   │   ├── auth.py / me.py / admin.py
│   │   │   ├── sync.py       # VS Code two-way sync (rev-based CAS)
│   │   │   ├── google.py     # Google Docs export + image endpoints
│   │   │   ├── og.py         # Dynamic link-preview PNGs
│   │   │   ├── live.py       # WebSocket: live document updates
│   │   │   └── share.py      # WebSocket signalling for P2P file sharing
│   │   ├── services/
│   │   │   ├── r2.py         # Cloudflare R2 (presign, head, delete, prefix)
│   │   │   ├── artifact.py   # Type registry, quota, signed artifact URLs
│   │   │   ├── bundle.py     # Zip extraction (zip-bomb + traversal guards)
│   │   │   ├── og_render.py / diagram_render.py / math_render.py
│   │   │   └── analytics.py / gdocs.py / oauth.py / mailer.py
│   │   └── utils/          # Slugs, bcrypt secrets, crypto, client IP
│   └── requirements.txt
├── worker/                 # Cloudflare Worker — the artifact origin
│   ├── src/index.js        # /r/<key> raw + /v/<renderer>/<key> viewers
│   └── wrangler.toml
├── frontend/               # Next.js app
│   └── src/
│       ├── app/
│       │   ├── page.tsx              # Landing
│       │   ├── new/                  # Editor + publish
│       │   ├── upload/               # Artifact upload / paste-HTML
│       │   ├── builder/              # Drag-and-drop README builder
│       │   ├── dashboard/            # Docs + artifacts, analytics
│       │   ├── [slug]/
│       │   │   ├── page.tsx          # ISR document route
│       │   │   ├── DocumentView.tsx  # Markdown viewer + inline editor
│       │   │   └── ArtifactView.tsx  # Sandboxed artifact viewer
│       │   └── share/                # P2P file sharing
│       ├── components/               # MarkdownPreview, ArtifactBadge, landing/
│       └── lib/                      # api.ts, webrtc.ts, readmeSections.ts
├── extension/              # VS Code extension (two-way markdown sync)
└── cli/                    # Go CLI for P2P file sharing
```

---

## Local Development

### Prerequisites

- Python 3.12+
- Node.js 20+
- MongoDB Atlas URI (or local MongoDB)

### Backend

```bash
cd backend

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env — set MARKDROP_MONGODB_URI
```

`.env` example:
```env
MARKDROP_MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?retryWrites=true&w=majority
MARKDROP_MONGODB_DB=markdrop
MARKDROP_DEBUG=true
MARKDROP_CORS_ORIGINS=["http://localhost:3000"]
```

```bash
# Start server (http://localhost:8080)
uvicorn app.main:app --reload --port 8080
```

Indexes (slug unique, TTL for expiry) are created automatically on startup. No migrations needed.

Swagger docs at [http://localhost:8080/docs](http://localhost:8080/docs)

### Frontend

```bash
cd frontend
npm install

# Optional: set API base URL if not on default port
echo "NEXT_PUBLIC_API_URL=http://localhost:8080" > .env.local

npm run dev   # http://localhost:3000
```

---

## API Reference

Base URL: `https://api.markdrop.in`

### Create a document

```http
POST /api/v1/documents
Content-Type: application/json

{
  "title": "My Document",          // optional
  "content": "# Hello\nMarkdown.", // required, max 500 000 chars
  "custom_slug": "my-slug",        // optional, 3-50 chars [a-zA-Z0-9_-]
  "expires_in": "7d",              // "never" | "1d" | "7d" | "30d" | "custom"
  "custom_expires_at": null,       // ISO 8601 datetime, required when expires_in="custom"
  "read_password": "secret123"     // optional — password-protect the document
}
```

**Response `201`**
```json
{
  "slug": "my-slug",
  "url": "https://markdrop.in/my-slug",
  "title": "My Document",
  "content": "# Hello\nMarkdown.",
  "edit_secret": "sk_9f8a7b...",
  "created_at": "2026-03-29T10:00:00Z",
  "updated_at": "2026-03-29T10:00:00Z",
  "expires_at": "2026-04-05T10:00:00Z",
  "views": 0,
  "is_password_protected": true
}
```

> `edit_secret` is shown **only once** — save it to edit or delete later.

### Get a document

```http
GET /api/v1/documents/{slug}
X-Read-Password: secret123   # required only if password-protected
```

Returns `401` if password is required but missing, `403` if wrong.

### Edit a document

```http
PUT /api/v1/documents/{slug}
X-Edit-Secret: sk_9f8a7b...
Content-Type: application/json

{
  "title": "Updated Title",
  "content": "# Updated content"
}
```

### Delete a document

```http
DELETE /api/v1/documents/{slug}
X-Edit-Secret: sk_9f8a7b...
```

Deleting an artifact also frees its R2 storage (the whole prefix, for bundles).

### Artifacts

All artifact endpoints require a logged-in user (session JWT or `mdk_` API token).

```http
GET  /api/v1/artifacts/status        # feature gate + quota; safe when unconfigured
POST /api/v1/artifacts/upload-url    # {filename, content_type, size_bytes} -> presigned PUT
POST /api/v1/artifacts               # {blob_key, title, filename, ...} -> publishes at a slug
POST /api/v1/artifacts/paste         # {content, title, ...} -> publish pasted HTML directly
```

`GET /api/v1/documents/{slug}` returns `kind: "artifact"` with `mime`,
`renderer`, `type_label`, `size_bytes` and an `artifact_url` on the artifact
origin. Password-protected artifacts get a short-lived signed token on that URL.

Errors worth handling: `415` unsupported type, `413` too large, `507` quota
exceeded, `422` bad zip bundle, `503` artifact storage not configured.

---

## Artifacts

An artifact is any non-markdown file that gets a shareable, **rendered** URL —
an HTML page, a PDF, a spreadsheet, a Word doc, or a zipped site. Upload at
[`/upload`](https://markdrop.in/upload) (requires login), share the resulting
`markdrop.in/<slug>` like any document.

### Why a separate origin

The session token lives in `localStorage` and edit secrets in `sessionStorage`
on the `markdrop.in` origin. HTML served from that same origin could read both
and take over the account. Hosting user HTML also attracts phishing, and a
Safe Browsing blocklisting applies to the *domain* — which would take the whole
product down with it.

So artifacts render inside a sandboxed iframe pointed at a **different
registrable site**. `markdrop.in` keeps the chrome (title, views, copy link,
report); only the file itself is served from elsewhere.

```
markdrop.in/<slug>                    ← your chrome, analytics, actions
   └─ <iframe sandbox>
        markdrop-artifacts…workers.dev ← Cloudflare Worker + R2 binding
             /r/<key>                    raw bytes (an HTML artifact IS the page)
             /v/<renderer>/<key>         PDF / spreadsheet / docx / text viewers
```

`*.workers.dev` is on the Public Suffix List, so it counts as a separate site
(isolated cookies, independent domain reputation) at no cost. Swapping in a
bought domain later is one env var — artifact URLs are derived at read time,
never stored. `MARKDROP_ARTIFACT_ALLOW_SUBDOMAIN_ORIGIN` exists for a subdomain
of the app, but the app's own origin is refused unconditionally.

### Supported types

| Type | Rendered as |
|------|-------------|
| HTML | The page itself, sandboxed |
| Zipped site | Exploded into one R2 prefix; assets resolve as siblings |
| PDF | Native viewer |
| Excel / CSV | SheetJS grid, one tab per sheet |
| Word (.docx) | mammoth → semantic HTML (structural, not pixel-exact) |
| Images / SVG | Direct (SVG stays sandboxed — it can carry script) |
| JSON / text | Escaped `<pre>` |

Anything outside this list is refused at upload; anything unexpected that does
reach the Worker is served `Content-Disposition: attachment` rather than rendered.

### Upload flow

Bytes never pass through the API server:

1. `POST /api/v1/artifacts/upload-url` — validates type + quota, returns a
   presigned PUT. The signature binds `Content-Type`, so a client can't declare
   CSV and upload HTML.
2. Browser `PUT`s straight to R2.
3. `POST /api/v1/artifacts` — the server `HEAD`s the object to learn its **real**
   size and type before committing. A presigned PUT can't enforce a length
   range, so the declared size from step 1 is advisory only.

Object keys are random and namespaced per owner (`art/<user_id>/<token>`) —
deliberately *not* content-addressed, because a client-supplied hash as the key
would let one account overwrite another's artifact.

Zip bundles are extracted server-side with caps on entry count, per-file size
and total uncompressed size, and any entry escaping the prefix via `..` or an
absolute path is refused.

---

## P2P File Sharing

Markdrop includes a zero-storage file transfer feature at `/share`. Files are streamed directly between browsers using **WebRTC DataChannels** — nothing is uploaded to the server.

```
Sender (host)  ──WS──▶  FastAPI relay  ◀──WS──  Recipient (guest)
                         (SDP / ICE)
     └────────────── RTCDataChannel (direct P2P) ──────────────┘
```

**How it works:**

1. Sender picks a file → opens a WebSocket to `/ws/share/{roomId}?role=host`
2. A unique share link (`markdrop.in/share/{roomId}`) is generated and displayed
3. Recipient opens the link → joins the same room as guest → WebRTC handshake completes
4. Sender's browser streams the file in 64 KB chunks directly to the recipient's browser
5. Recipient's browser assembles the chunks and triggers a native browser save

> The file never touches Markdrop servers. The relay only forwards ~few KB of SDP/ICE signaling JSON.

**Properties:**
- End-to-end encrypted (DTLS 1.2, mandatory in WebRTC)
- Any file type, any size (limited only by sender's RAM for now)
- Works across NAT/firewalls via STUN; no TURN fallback (same-network or open NAT required)
- Real-time progress bar on both sides

See [FILESHARE.md](FILESHARE.md) for full technical documentation, WebSocket API reference, and architecture diagrams.

### Backend (AWS EC2 — no Docker)

```bash
# On EC2 (Ubuntu 22.04)
sudo apt update && sudo apt install -y python3.12 python3.12-venv python3-pip nginx certbot python3-certbot-nginx

git clone https://github.com/himanshkukreja/markdrop.git /opt/markdrop
cd /opt/markdrop/backend

python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Create .env with production values
cp .env.example .env
```

Create `/etc/systemd/system/markdrop.service`:
```ini
[Unit]
Description=Markdrop API
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/opt/markdrop/backend
EnvironmentFile=/opt/markdrop/backend/.env
ExecStart=/opt/markdrop/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8080
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now markdrop
sudo certbot --nginx -d api.markdrop.in
```

Create `/etc/nginx/sites-available/markdrop-api`:
```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=60r/m;

server {
    listen 80;
    server_name api.markdrop.in;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.markdrop.in;

    ssl_certificate     /etc/letsencrypt/live/api.markdrop.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.markdrop.in/privkey.pem;

    # ── WebSocket (P2P signalling) ─────────────────────────────────────────
    # MUST come before the general location block.
    # Requires HTTP/1.1 + Upgrade header — without these nginx strips the
    # upgrade and FastAPI returns 404.
    location /ws/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_read_timeout 3600s;   # keep WS alive for up to 1 h
    }

    # ── Compression ────────────────────────────────────────────────────────
    # nginx.conf ships with "gzip on" but leaves gzip_types and gzip_proxied at
    # their defaults — text/html only, and NOTHING proxied. Both must be set or
    # API JSON goes out uncompressed (this was worth ~62% on a real document).
    gzip              on;
    gzip_proxied      any;
    gzip_vary         on;
    gzip_comp_level   5;
    gzip_min_length   512;
    gzip_types        application/json application/javascript application/xml
                      text/plain text/css text/xml image/svg+xml;

    # ── Regular HTTP API ───────────────────────────────────────────────────
    location / {
        limit_req zone=api burst=20 nodelay;

        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/markdrop-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **WebSocket gotcha** — the `/ws/` block **must** include `proxy_http_version 1.1` and
> `proxy_set_header Upgrade / Connection "upgrade"`. Without them nginx defaults to HTTP/1.0,
> strips the upgrade handshake, and FastAPI responds with 404.

### Frontend (Vercel)

1. Push to GitHub
2. Import repo at [vercel.com](https://vercel.com), set root directory to `frontend`
3. Add env var: `NEXT_PUBLIC_API_URL=https://api.markdrop.in`
4. Set ignored build step: `git diff HEAD^ HEAD --quiet -- frontend/` (only deploy on frontend changes)
5. Deploy

`frontend/vercel.json` pins functions to `bom1` (Mumbai). This matters: the
default region is `iad1` (Washington DC), which put every server render a
Pacific round trip away from the `ap-south-1` API. The `/[slug]` route also sets
`revalidate = 60` so the anonymous render is served from the edge — which is
why its `?new` / `?edit` flags are read via `useSearchParams` on the client
rather than from server `searchParams` (reading those forces a dynamic render
on every request, forfeiting the cache).

### Artifact origin (Cloudflare Worker + R2)

```bash
cd worker
npx wrangler login

# One-time: create the bucket and claim an account workers.dev subdomain
npx wrangler r2 bucket create markdrop-artifacts

npx wrangler deploy                              # -> <name>.<subdomain>.workers.dev
npx wrangler secret put ARTIFACT_SIGNING_KEY     # must equal MARKDROP_ARTIFACT_SIGNING_KEY
```

Then set the R2 variables in `backend/.env` (see [Environment Variables](#environment-variables))
and redeploy the backend. Confirm with:

```bash
curl -s https://api.markdrop.in/api/v1/artifacts/status
# {"configured": true, "origin_isolated": true, "origin_separate_site": true, ...}
```

> `origin_separate_site: false` means artifacts are running on a subdomain of the
> app — still safe from token theft, but sharing domain reputation with
> `markdrop.in`. Prefer a separate site.

> Cloudflare's bot protection returns `403` to the default `Python-urllib` user
> agent on `workers.dev`. Browsers, curl and `requests` are unaffected — but set
> a real UA if you ever fetch artifact URLs server-side.

### DNS

| Type | Name | Value |
|------|------|-------|
| A | `api` | EC2 public IP |
| CNAME | `@` / `www` | Vercel domain |

The artifact origin needs no DNS of its own while it runs on `workers.dev`.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `MARKDROP_MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `MARKDROP_MONGODB_DB` | MongoDB database name | `markdrop` |
| `MARKDROP_DEBUG` | Enable debug mode | `false` |
| `MARKDROP_CORS_ORIGINS` | Allowed CORS origins (JSON array) | — |
| `MARKDROP_SLUG_LENGTH` | Slug character length | `7` |
| `MARKDROP_MAX_CONTENT_CHARS` | Maximum document content length | `500000` |
| `MARKDROP_RATE_LIMIT_CREATE` | Create/update/delete rate limit | `10/minute` |
| `MARKDROP_RATE_LIMIT_READ` | Read rate limit | `60/minute` |
| `MARKDROP_FRONTEND_URL` | Public frontend URL (OAuth/email redirects) | `http://localhost:3000` |
| `MARKDROP_API_BASE_URL` | Public API URL (diagram/math image links) | `http://localhost:8080` |
| `MARKDROP_AUTH_SECRET` | JWT signing key for user sessions | — |
| `MARKDROP_GOOGLE_CLIENT_ID` / `_SECRET` | Google OAuth (login + Docs) | — |
| `MARKDROP_TOKEN_ENCRYPTION_KEY` | Fernet key for Google refresh tokens | — |
| `MARKDROP_RESEND_API_KEY` | Resend key for passwordless email login | — |
| `MARKDROP_GEOIP_DB_PATH` | MaxMind GeoLite2 City DB (analytics geo) | — |
| `MARKDROP_IP_HASH_SALT` | Salt for hashed visitor IPs | — |

#### Artifacts (Cloudflare R2)

| Variable | Description | Default |
|----------|-------------|---------|
| `MARKDROP_R2_ACCOUNT_ID` | Cloudflare account ID | — |
| `MARKDROP_R2_ACCESS_KEY_ID` | R2 S3 access key | — |
| `MARKDROP_R2_SECRET_ACCESS_KEY` | R2 S3 secret | — |
| `MARKDROP_R2_BUCKET` | Bucket name | — |
| `MARKDROP_ARTIFACT_ORIGIN` | Artifact origin URL (**must be a separate site**) | — |
| `MARKDROP_ARTIFACT_SIGNING_KEY` | HMAC key for private artifact tokens (must match the Worker secret) | — |
| `MARKDROP_ARTIFACT_MAX_BYTES` | Per-file limit | `26214400` (25 MB) |
| `MARKDROP_ARTIFACT_USER_QUOTA_BYTES` | Per-account total | `262144000` (250 MB) |
| `MARKDROP_ARTIFACT_ALLOW_SUBDOMAIN_ORIGIN` | Permit a subdomain of the app (weaker — shares domain reputation) | `false` |

Artifacts stay dormant until all of these are set: `/upload` shows a
"not enabled yet" state and the endpoints return `503`.

### Frontend (`frontend/.env.local`)

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL | `https://api.markdrop.in` |
| `NEXT_PUBLIC_MAX_CONTENT_CHARS` | Editor character limit | `500000` |

---

## Roadmap

- [x] Phase 1 — Anonymous markdown publishing with edit/delete via secret key
- [x] Phase 2 — Custom slugs, expiry, view counts, password protection, toolbar, themes
- [x] Phase 3 — P2P file sharing (WebRTC DataChannel, no server storage)
- [x] Phase 4 — Accounts, dashboard, per-document analytics, API tokens
- [x] Phase 5 — VS Code two-way sync, Google Docs export, live document updates
- [x] Phase 6 — Mermaid + KaTeX rendering, dynamic OG link previews, README builder
- [x] Phase 7 — Artifacts: HTML, PDF, Office and zipped sites on R2 + isolated origin
- [ ] Next — Artifact screenshots for OG cards, PPTX, document version history,
      TURN server for P2P behind strict NAT, Google Docs two-way sync

---

## License

[MIT](LICENSE)
