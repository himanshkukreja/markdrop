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
│   │   ├── services/       # Business logic
│   │   └── utils/          # Slug generation, bcrypt secret hashing
│   └── requirements.txt
└── frontend/               # Next.js app
    └── src/
        ├── app/            # Pages (App Router)
        │   ├── page.tsx                  # Editor + publish page
        │   └── [slug]/
        │       ├── page.tsx              # Document view (SSR, handles password gate)
        │       └── DocumentView.tsx      # Client viewer + inline editor
        ├── components/
        │   ├── MarkdownPreview.tsx       # react-markdown + syntax highlighting
        │   ├── MarkdownToolbar.tsx       # Formatting toolbar
        │   ├── CopyButton.tsx
        │   └── ThemeToggle.tsx           # 3-theme cycle (vscode → dark → light)
        └── lib/
            └── api.ts                   # API client (create, get, update, delete)
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
  "content": "# Hello\nMarkdown.", // required, max 20 000 chars
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

## Deployment

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

Configure nginx to proxy `api.markdrop.in` → `127.0.0.1:8080` with `limit_req_zone` rate limiting.

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
- [ ] Phase 3 — User accounts, dashboard, document versioning, file uploads

---

## License

[MIT](LICENSE)
