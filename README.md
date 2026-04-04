# Markdrop

Minimal, anonymous markdown publishing tool. Paste markdown, get a shareable link instantly — no login required.

**Live:** [markdrop.in](https://markdrop.in)

---

## Features

- Paste markdown and publish with one click — no account needed
- Shareable links (`markdrop.in/abc123` or a custom slug you pick)
- Write / Split / Preview editor modes with scroll sync
- Markdown toolbar (Bold, Italic, Heading, Code, Code Block, Link, List)
- Document title support
- Syntax-highlighted code blocks (GitHub Dark theme)
- Edit or delete via a secret key shown once at publish — built-in editor
- Raw markdown view with copy-all button
- **Password protection** — optionally lock a document behind a read password
- **Document expiry** — set a TTL (1 day / 7 days / 30 days / custom date & time)
- **View count** — passively tracks how many times a document has been opened
- **3 themes** — VS Code dark grey (default), dark, and light — persisted to localStorage
- Export to PDF (print-optimised, no UI chrome)
- **P2P file sharing** — send any file directly to another browser, no server storage, end-to-end encrypted via WebRTC DataChannel ([technical docs →](FILESHARE.md))
- Fully responsive — works on mobile
- Rate-limited to prevent abuse

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI (Python 3.12) |
| Frontend | Next.js 15 + Tailwind CSS v4 |
| Database | MongoDB (Motor async driver) |
| Rate limiting | slowapi |
| Frontend hosting | Vercel |
| Backend hosting | AWS EC2 + nginx + systemd |
| CDN / DNS | Cloudflare |

---

## Project Structure

```
markdrop/
├── backend/                # FastAPI app
│   ├── app/
│   │   ├── main.py         # App entrypoint, lifespan (DB connect/disconnect)
│   │   ├── config.py       # Pydantic settings (env vars)
│   │   ├── database.py     # Motor MongoDB client + index setup
│   │   ├── models/         # Plain Python dataclasses
│   │   ├── schemas/        # Pydantic request/response schemas
│   │   ├── routers/        # FastAPI route handlers
│   │   │   ├── documents.py  # Document CRUD routes
│   │   │   └── share.py      # WebSocket signaling relay for P2P file sharing
│   │   ├── services/       # Business logic
│   │   └── utils/          # Slug generation, bcrypt secret hashing
│   └── requirements.txt
└── frontend/               # Next.js app
    └── src/
        ├── app/            # Pages (App Router)
        │   ├── page.tsx                  # Editor + publish page
        │   ├── [slug]/
        │   │   ├── page.tsx              # Document view (SSR, handles password gate)
        │   │   └── DocumentView.tsx      # Client viewer + inline editor
        │   └── share/
        │       ├── page.tsx              # P2P file uploader (WebRTC host)
        │       └── [id]/
        │           ├── page.tsx          # SSR wrapper — passes roomId to client
        │           └── DownloadView.tsx  # P2P file downloader (WebRTC guest)
        ├── components/
        │   ├── MarkdownPreview.tsx       # react-markdown + syntax highlighting
        │   ├── MarkdownToolbar.tsx       # Formatting toolbar
        │   ├── CopyButton.tsx
        │   └── ThemeToggle.tsx           # 3-theme cycle (vscode → dark → light)
        └── lib/
            ├── api.ts                   # API client (create, get, update, delete)
            └── webrtc.ts                # WebRTC utilities, chunk streaming, room ID
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
  "content": "# Hello\nMarkdown.", // required, max 50 000 chars
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

### DNS (Cloudflare)

| Type | Name | Value |
|------|------|-------|
| A | `api` | EC2 public IP (proxy OFF for SSL passthrough) |
| CNAME | `@` / `www` | Vercel domain |

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
| `MARKDROP_RATE_LIMIT_CREATE` | Create/update/delete rate limit | `10/minute` |
| `MARKDROP_RATE_LIMIT_READ` | Read rate limit | `60/minute` |

### Frontend (`frontend/.env.local`)

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL | `https://api.markdrop.in` |

---

## Roadmap

- [x] Phase 1 — Anonymous markdown publishing with edit/delete via secret key
- [x] Phase 2 — Custom slugs, expiry dates, view counts, password protection, markdown toolbar, 3 themes
- [x] Phase 3 — P2P file sharing (WebRTC DataChannel, no server storage)
- [ ] Phase 4 — User accounts, dashboard, document versioning, TURN server for file sharing behind strict NAT

---

## License

[MIT](LICENSE)
