# Markdrop

Minimal, anonymous markdown publishing tool. Paste markdown, get a shareable link instantly — no login required.

**Live:** [markdrop.in](https://markdrop.in)

---

## Features

- Paste markdown and publish with one click
- Shareable links (`markdrop.in/abc123`)
- Edit or delete via a secret key (no account needed)
- Raw markdown view
- Rate-limited to prevent abuse

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI (Python 3.12) |
| Frontend | Next.js 15 + Tailwind CSS v4 |
| Database | PostgreSQL (Neon) |
| Cache / Rate limiting | Redis |
| Frontend hosting | Vercel |
| Backend hosting | AWS EC2 |
| CDN | Cloudflare |

---

## Project Structure

```
markdrop/
├── backend/        # FastAPI app
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── database.py
│   │   ├── models/
│   │   ├── schemas/
│   │   ├── routers/
│   │   ├── services/
│   │   └── utils/
│   ├── alembic/    # DB migrations
│   ├── Dockerfile
│   └── requirements.txt
└── frontend/       # Next.js app
    └── src/
        ├── app/    # Pages (App Router)
        ├── components/
        └── lib/    # API client
```

---

## Local Development

### Prerequisites

- Python 3.12+
- Node.js 20+
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
# Edit .env — add your Neon connection string

# Run DB migrations
MARKDROP_ALLOW_MIGRATE=1 alembic upgrade head

# Start server (http://localhost:8080)
uvicorn app.main:app --reload --port 8080
```

Swagger docs available at [http://localhost:8080/docs](http://localhost:8080/docs)

### Frontend

```bash
cd frontend

npm install

cp .env.local.example .env.local
# NEXT_PUBLIC_API_URL=http://localhost:8080 (default)

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
  "content": "# Hello\nThis is **markdown**."
}
```

**Response `201`**
```json
{
  "slug": "abc123",
  "url": "https://markdrop.in/abc123",
  "content": "# Hello\nThis is **markdown**.",
  "edit_secret": "sk_9f8a7b...",
  "created_at": "2026-03-28T10:00:00Z",
  "updated_at": "2026-03-28T10:00:00Z"
}
```

> Save the `edit_secret` — it is shown only once.

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

# Clone and run
git clone https://github.com/yourusername/markdrop.git
cd markdrop/backend

cp .env.example .env
# Edit .env with production values:
#   MARKDROP_DEBUG=false
#   MARKDROP_CORS_ORIGINS=["https://markdrop.in"]
#   MARKDROP_DATABASE_URL=<neon-connection-string>

docker build -t markdrop-api .
docker run -d --network host --env-file .env --restart unless-stopped markdrop-api

# Run migrations
MARKDROP_ALLOW_MIGRATE=1 alembic upgrade head
```

### Frontend (Vercel)

1. Push to GitHub
2. Import repo in [vercel.com](https://vercel.com)
3. Set root directory to `frontend`
4. Add environment variable: `NEXT_PUBLIC_API_URL=https://api.markdrop.in`
5. Deploy

### DNS (Cloudflare)

| Type | Name | Value |
|------|------|-------|
| A | `@` | EC2 public IP (proxy OFF for API) |
| A | `api` | EC2 public IP (proxy OFF) |
| CNAME | `www` | `cname.vercel-dns.com` |

> Point `markdrop.in` to Vercel via their domain settings. Point `api.markdrop.in` to your EC2 IP.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `MARKDROP_DATABASE_URL` | PostgreSQL connection string | — |
| `MARKDROP_REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `MARKDROP_DEBUG` | Enable debug mode | `false` |
| `MARKDROP_CORS_ORIGINS` | Allowed CORS origins (JSON array) | — |

### Frontend (`frontend/.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL |

---

## Roadmap

- [x] Phase 1 — Anonymous markdown publishing with edit/delete via secret key
- [ ] Phase 2 — Syntax highlighting, expiry, password protection, view counts
- [ ] Phase 3 — User accounts, dashboard, file uploads, API access

---

## License

[MIT](LICENSE)
