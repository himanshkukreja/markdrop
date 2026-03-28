# Markdrop

Minimal, anonymous markdown publishing tool. Paste markdown, get a shareable link instantly — no login required.

**Live:** [markdrop.in](https://markdrop.in)

---

## Features

- Paste markdown and publish with one click
- Shareable links (`markdrop.in/abc123`)
- Write / Split / Preview editor modes with scroll sync
- Document title support
- Syntax-highlighted code blocks with copy button
- Edit or delete via a secret key (no account needed) — edit UI built in
- Raw markdown view with copy-all button
- Light / dark mode
- Export to PDF (print-optimised, no UI chrome)
- Fully responsive — works on mobile
- Rate-limited to prevent abuse

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI (Python 3.12) |
| Frontend | Next.js 15 + Tailwind CSS v4 |
| Database | MongoDB (Motor async driver) |
| Rate limiting | Redis + slowapi |
| Frontend hosting | Vercel |
| Backend hosting | AWS EC2 |
| CDN | Cloudflare |

---

## Project Structure

```
markdrop/
├── backend/                # FastAPI app
│   ├── app/
│   │   ├── main.py         # App entrypoint, lifespan (DB connect/disconnect)
│   │   ├── config.py       # Pydantic settings (env vars)
│   │   ├── database.py     # Motor MongoDB client
│   │   ├── models/         # Plain Python dataclasses
│   │   ├── schemas/        # Pydantic request/response schemas
│   │   ├── routers/        # FastAPI route handlers
│   │   ├── services/       # Business logic
│   │   └── utils/          # Slug generation, bcrypt secret hashing
│   ├── Dockerfile
│   └── requirements.txt
└── frontend/               # Next.js app
    └── src/
        ├── app/            # Pages (App Router)
        │   ├── page.tsx            # Editor page
        │   ├── [slug]/page.tsx     # Document view (SSR)
        │   └── [slug]/DocumentView.tsx  # Client viewer + editor
        ├── components/
        │   ├── MarkdownPreview.tsx  # react-markdown + syntax highlighting
        │   ├── CopyButton.tsx
        │   └── ThemeToggle.tsx
        └── lib/
            └── api.ts      # API client (create, get, update, delete)
```

---

## Local Development

### Prerequisites

- Python 3.12+
- Node.js 20+
- MongoDB Atlas URI (or local MongoDB)
- Redis (`brew install redis` on macOS)

### Backend

```bash
cd backend

# Install dependencies
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env — add your MongoDB URI
```

`.env` example:
```env
MARKDROP_MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
MARKDROP_MONGODB_DB=markdrop
MARKDROP_REDIS_URL=redis://localhost:6379
MARKDROP_DEBUG=true
MARKDROP_CORS_ORIGINS=["http://localhost:3000"]
```

```bash
# Start server (http://localhost:8080)
uvicorn app.main:app --reload --port 8080
```

No migrations needed — indexes are created automatically on startup.

Swagger docs at [http://localhost:8080/docs](http://localhost:8080/docs)

### Frontend

```bash
cd frontend

npm install

# Optional: create .env.local if backend is not on default port
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
  "title": "My Document",
  "content": "# Hello\nThis is **markdown**."
}
```

**Response `201`**
```json
{
  "slug": "abc123x",
  "url": "https://markdrop.in/abc123x",
  "title": "My Document",
  "content": "# Hello\nThis is **markdown**.",
  "edit_secret": "sk_9f8a7b...",
  "created_at": "2026-03-29T10:00:00Z",
  "updated_at": "2026-03-29T10:00:00Z"
}
```

> `edit_secret` is shown only once — save it to edit or delete later.

### Get a document

```http
GET /api/v1/documents/{slug}
```

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

### Backend (AWS EC2)

```bash
# On EC2 (Ubuntu 22.04)
sudo apt update && sudo apt install -y redis-server docker.io
sudo systemctl enable redis-server && sudo systemctl start redis-server

# Clone and configure
git clone https://github.com/yourusername/markdrop.git
cd markdrop/backend

cp .env.example .env
# Edit .env with production values:
#   MARKDROP_MONGODB_URI=<your-atlas-uri>
#   MARKDROP_MONGODB_DB=markdrop
#   MARKDROP_DEBUG=false
#   MARKDROP_CORS_ORIGINS=["https://markdrop.in"]

docker build -t markdrop-api .
docker run -d --network host --env-file .env --restart unless-stopped markdrop-api
```

### Frontend (Vercel)

1. Push to GitHub
2. Import repo at [vercel.com](https://vercel.com)
3. Set root directory to `frontend`
4. Add environment variable: `NEXT_PUBLIC_API_URL=https://api.markdrop.in`
5. Deploy

### DNS (Cloudflare)

| Type | Name | Value |
|------|------|-------|
| A | `api` | EC2 public IP (proxy OFF) |
| CNAME | `www` | `cname.vercel-dns.com` |

> Point `markdrop.in` to Vercel via their domain settings. Point `api.markdrop.in` directly to your EC2 IP.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `MARKDROP_MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `MARKDROP_MONGODB_DB` | MongoDB database name | `markdrop` |
| `MARKDROP_REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `MARKDROP_DEBUG` | Enable debug mode | `false` |
| `MARKDROP_CORS_ORIGINS` | Allowed CORS origins (JSON array) | — |
| `MARKDROP_SLUG_LENGTH` | Slug character length | `7` |
| `MARKDROP_RATE_LIMIT_CREATE` | Create rate limit | `10/minute` |
| `MARKDROP_RATE_LIMIT_READ` | Read rate limit | `60/minute` |

### Frontend (`frontend/.env.local`)

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL | `http://localhost:8080` |

---

## Roadmap

- [x] Phase 1 — Anonymous markdown publishing with edit/delete via secret key
- [ ] Phase 2 — Expiry dates, password protection, view counts, document versioning
- [ ] Phase 3 — User accounts, dashboard, file uploads, API access

---

## License

[MIT](LICENSE)
