# Markdrop

Minimal, anonymous markdown publishing tool. Paste markdown, get a shareable link instantly — no login required.

Optionally **end-to-end encrypted**: your browser encrypts the document before it
leaves the tab and the key travels in the URL fragment, so Markdrop stores
ciphertext it holds no key to.

For teams, **workspaces** add custom domains, white-label branding and a shared
library — without changing anything for the people using Markdrop on their own.

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
- **Live updates** — an open document refreshes itself when it changes elsewhere
- Documents open **full screen** by default — one keypress back to the details
- Export to PDF, raw markdown view, fully responsive

### End-to-end encryption (opt-in)
- Tick one box on `/new` and the document — **title included** — is encrypted in
  your browser with AES-256-GCM before it is sent
- The key lives in the `#` fragment of the link, which browsers never transmit
  and strip from `Referer`, so it reaches no server, log or database
- **Rotate the key** at any time; the old link stops opening the document
- The key is remembered in the publishing browser, so losing the link isn't
  automatically fatal — with a control to forget it on shared machines
- See [End-to-end encryption](#end-to-end-encryption) for the threat model and
  what it deliberately does *not* protect against

### Artifacts — share more than markdown
- Paste an **HTML page** or upload a **PDF**, **Word doc**, **Excel/CSV**, image,
  **video** (mp4 / mov / webm), or a **zipped site** (HTML + CSS + JS + assets)
  and get a link that *renders* it
- Video streams with **HTTP Range requests**, so seeking fetches only the bytes
  it needs, and plays in a custom player — scrubber with buffered track, speed,
  picture-in-picture, frame stepping and keyboard control
- Rendered on an **isolated origin**, so a published page can never reach your
  Markdrop account — see [Artifacts](#artifacts) below
- Same password, expiry, analytics and abuse-reporting as any document

### Workspaces — for teams and companies
- **Your own domain**: point `docs.yourcompany.com` at Markdrop, verified by DNS
  and served over TLS we issue for you
- **White-label**: your name, uploaded favicon and logo, and accent colour on
  page titles and link preview cards — with the option to drop Markdrop entirely
- **View-only mode** turns a domain into a plain document CDN, and reads can be
  gated behind sign-in
- **Shared library** of documents and artifacts, with folders and roles
  (owner / admin / member / viewer)
- **Invitations by email** — nobody is added to a workspace without accepting
- Everything here is additive: without a workspace, Markdrop behaves exactly as
  it always has — see [Workspaces](#workspaces--custom-domains)

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
| Encryption | AES-256-GCM via WebCrypto, in the browser only |
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
│   │   │   ├── workspaces.py # Workspaces, invitations, branding uploads
│   │   │   ├── invites.py    # Accept / decline an invitation (pre-auth)
│   │   │   ├── library.py    # The shared workspace document library
│   │   │   ├── domains.py    # Custom domains, DNS verify, provider hints
│   │   │   ├── folders.py    # Workspace filing
│   │   │   ├── sync.py       # VS Code two-way sync (rev-based CAS)
│   │   │   ├── google.py     # Google Docs export + image endpoints
│   │   │   ├── og.py         # Dynamic link-preview PNGs
│   │   │   ├── live.py       # WebSocket: live document updates
│   │   │   └── share.py      # WebSocket signalling for P2P file sharing
│   │   ├── services/
│   │   │   ├── r2.py         # Cloudflare R2 (presign, head, delete, prefix)
│   │   │   ├── artifact.py   # Type registry, quota, signed artifact URLs
│   │   │   ├── bundle.py     # Zip extraction (zip-bomb + traversal guards)
│   │   │   ├── workspace.py  # Tenancy, roles, the viewer-chrome safety rule
│   │   │   ├── invitation.py # Consent-based membership, hashed tokens
│   │   │   ├── library.py    # Sharing — and the privacy boundary around it
│   │   │   ├── domain.py     # DNS verification, hosting attach/detach
│   │   │   ├── dns_provider.py # Who runs this zone's DNS, and its wording
│   │   │   ├── branding.py   # Favicon/logo re-encode (the security control)
│   │   │   ├── og_render.py / diagram_render.py / math_render.py
│   │   │   └── analytics.py / gdocs.py / oauth.py / mailer.py
│   │   └── utils/          # Slugs, bcrypt secrets, crypto, client IP
│   └── requirements.txt
├── worker/                 # Cloudflare Worker — the artifact origin
│   ├── src/index.js        # /r/<key> raw, /v/<renderer>/<key> viewers,
│   │                       # /b/<key> branding assets
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
│       │   ├── settings/workspaces/  # Workspace settings (library, brand,
│       │   │                         # domains, people, folders)
│       │   ├── invite/[token]/       # Accept or decline an invitation
│       │   ├── enterprise/           # Custom domains / white-label page
│       │   ├── h/[host]/             # Requests arriving on a custom domain
│       │   └── share/                # P2P file sharing
│       ├── components/               # MarkdownPreview, ArtifactBadge,
│       │                             # landing/, workspace/
│       ├── middleware.ts             # Routes non-primary hosts to /h/<host>
│       └── lib/                      # api.ts, workspaces.ts, e2e.ts,
│                                     # webrtc.ts, dnsCsv.ts, readmeSections.ts
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
  "read_password": "secret123",    // optional — password-protect the document
  "encrypted": false               // optional — see below
}
```

Set `encrypted: true` only when `content` is already a client-produced envelope
(`mdx1.<iv>.<ciphertext>`) and `title` is `null`. The server never verifies it —
it cannot, holding no key — it records it so every path that would read, render,
export or overwrite plaintext refuses instead. The flag is **immutable after
creation**: the server can neither encrypt an existing document nor decrypt one.

Encrypted documents reject Google Docs export (`422`), VS Code sync (`409`),
server-side copy (`422`) and admin edit (`422`).

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

### Workspaces

All of these require a session. Roles are enforced per endpoint; a caller who
isn't a member gets `404` rather than `403`.

```http
GET    /api/v1/workspaces                          # yours, with your role in each
POST   /api/v1/workspaces                          # {name}
GET    /api/v1/workspaces/{id}                     # viewer+
PUT    /api/v1/workspaces/{id}                     # admin+ — branding, settings
DELETE /api/v1/workspaces/{id}                     # owner only, {confirm_name}

GET    /api/v1/workspaces/{id}/members             # viewer+
PUT    /api/v1/workspaces/{id}/members/{user_id}   # admin+ — change role
DELETE /api/v1/workspaces/{id}/members/{user_id}   # admin+, or leave yourself

POST   /api/v1/workspaces/{id}/branding/{favicon|logo}   # admin+, multipart
```

### Invitations

```http
GET    /api/v1/workspaces/{id}/invitations   # admin+
POST   /api/v1/workspaces/{id}/invitations   # admin+ — {email, role}; sends mail
DELETE /api/v1/workspaces/{id}/invitations/{invite_id}   # admin+ — revoke

GET    /api/v1/invites/{token}               # preview; no account needed
POST   /api/v1/invites/{token}/accept        # requires the invited address
POST   /api/v1/invites/{token}/decline       # no account needed
```

### Shared library

```http
GET    /api/v1/workspaces/{id}/documents          # viewer+; ?q=&kind=&folder_id=
GET    /api/v1/workspaces/{id}/documents/counts   # per-folder totals
POST   /api/v1/workspaces/{id}/documents          # {document_id} — owner only
DELETE /api/v1/workspaces/{id}/documents/{doc_id} # unshare (never deletes)
PUT    /api/v1/workspaces/{id}/documents/{doc_id}/folder
```

### Domains & folders

```http
GET    /api/v1/workspaces/{id}/domains
POST   /api/v1/workspaces/{id}/domains            # admin+ — {host, kind}
POST   /api/v1/workspaces/{id}/domains/{did}/verify   # checks authoritative NS
POST   /api/v1/workspaces/{id}/domains/{did}/attach   # issues TLS
GET    /api/v1/workspaces/{id}/domains/{did}/provider # DNS provider + wording
DELETE /api/v1/workspaces/{id}/domains/{did}      # detaches from hosting first

GET|POST /api/v1/workspaces/{id}/folders
PUT|DELETE /api/v1/workspaces/{id}/folders/{folder_id}
```

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
| Video (mp4/mov/webm/ogg) | Custom player, served with Range support for seeking |
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

## End-to-end encryption

Opt-in per document. Everything below happens in the browser; the server is
never given the means to undo any of it.

### How it works

1. The browser generates an **AES-256-GCM** key with WebCrypto.
2. Title and body are sealed into one envelope,
   `mdx1.<base64url iv>.<base64url ciphertext>`, over `{"t": title, "c": body}`.
3. Only the envelope is sent. The stored `title` column is `null`.
4. The key is appended to the link as a **fragment**: `markdrop.in/slug#k=…`.

Fragments are the one part of a URL browsers do not put in the request line, and
they are stripped from `Referer`. The key therefore never reaches nginx, Vercel,
the API, the logs or MongoDB. You can confirm this yourself in a network tab.

The title is sealed *inside* the envelope rather than encrypted into its own
column for two reasons: a document called "Q4 layoffs" leaks the thing worth
protecting even when the body is safe, and the ciphertext of a 200-character
title overflows that column anyway.

Because base64 costs a third, an encrypted document holds about **370,000**
characters of text against the usual 500,000.

### What this does and does not give you

**It does mean:** Markdrop stores ciphertext it has no key for. A database dump,
a subpoena, or a rogue operator yields bytes and nothing else.

**It does not mean** only authorised people can read the document. *The link is
the key.* Anyone you forward it to can read it, and so can anyone who finds it
in your browser history. Encryption removes the server from the set of people
who can read your document; it does not remove anyone you send the link to.

For the second property you want a passphrase-derived key — on the roadmap, and
additive to what exists.

### Losing the key

There is no recovery path, and being logged in does not create one. Ownership
gives you control of the *record* — delete, expiry, analytics — never access to
the contents. If logging in could unlock the document, the encryption would be
theatre.

Two things soften it in practice:

- The key is remembered in `localStorage` on browsers that have opened the
  document, so losing the link is survivable if you still have the machine.
  It never leaves the browser, and **Forget key on this device** removes it.
- **Rotation** issues a new key and invalidates the old link — useful when a
  link has spread further than intended. It cannot un-read what was already read.

### What encrypted documents give up

Every server-side feature that needs to read the text is refused rather than
silently broken: **Google Docs export** (it renders Mermaid and LaTeX
server-side), **VS Code sync** (both directions — a push would overwrite the
ciphertext with plaintext and destroy the document), **server-side copy**, and
**admin edit**. Moderation keeps delete and expiry, which need no plaintext.
Link previews fall back to a generic card.

Artifacts are **not** encrypted: their bytes live in R2 and the viewers render
them server-side. That is a separate design.

---

## Workspaces & custom domains

A workspace is the tenant that owns domains, branding, folders, members and a
shared library. **It is entirely additive**: a user with no workspace, and a
document with no workspace, behave exactly as they did before any of this
existed.

### Roles

`viewer < member < admin < owner`. Authorization is a rank comparison rather
than scattered special cases. Non-members get **404, not 403**, so the API never
confirms that a workspace exists to someone with no access to it.

| Role | Can |
|------|-----|
| viewer | read the shared library |
| member | publish into it, edit shared documents, file them into folders |
| admin | manage members, domains, branding; rename and delete shared documents |
| owner | everything, plus delete the workspace |

### The privacy boundary

**A document is private until its owner shares it.**

This is structural rather than a filter: the library listing matches on
`workspace_id`, and a private document does not have one. There is no flag to
forget and no query to get wrong — joining a workspace exposes nothing you wrote
before joining it.

- Sharing is the **owner's decision alone**. A workspace admin cannot reach into
  someone's private library and publish from it.
- Shared is not owned. Ownership never moves, so unsharing — or deleting the
  entire workspace — hands the document back with its slug, links and analytics
  intact. Deleting a workspace never deletes a member's documents.
- Editing a shared document follows the workspace role. **Deleting and renaming
  require admin**, because destroying someone else's work is a different act
  from editing it.
- A document lives in at most one workspace.

### Invitations

Membership begins with an invitation the recipient accepts. There is no endpoint
that adds somebody without their say-so.

- The emailed link is a bearer token, so it is **never sufficient on its own**:
  accepting requires being signed in as the address the invitation was sent to.
  Mail gets forwarded, shared inboxes have many readers, and archives leak.
- Tokens are stored as SHA-256 hashes and expire after 7 days.
- Re-inviting the same address replaces the pending invitation and invalidates
  the old link, so it doubles as "resend".
- **Declining never requires an account** — making someone sign up in order to
  say no would be absurd. Declined and withdrawn links keep resolving so the
  page can explain itself instead of returning a dead end.
- An invitation can never lower an existing role.

### Custom domains

Two DNS records: a `TXT` proving ownership, then a `CNAME` (or `A` at an apex)
routing the hostname. Ownership is always checked before a host is attached —
otherwise anyone could point a hostname they do not control at us and have a
certificate issued for it.

Verification queries the domain's **authoritative nameservers** rather than a
recursive resolver, because verification runs moments after someone edits DNS
and a cached negative answer would report failure for hours.

Each domain declares what it is, and the kind is never inferred from the name:

| Kind | Serves |
|------|--------|
| **Documents** | Pages and sign-in — the full app |
| **Files only** | Uploaded artifacts, and never runs the app |

One host cannot be both. A slug belonging to another workspace returns 404 on
your host.

### Making DNS setup survivable

One-click DNS setup at GoDaddy and IONOS sits behind a paid intermediary, so
Markdrop does the free thing that removes most of the failures instead:

- Detects the **DNS provider** from the zone's authoritative nameservers — keyed
  on the nameserver, not the registrar, since a domain bought at one and pointed
  at another is edited at the second
- Deep-links straight to that provider's DNS page, and labels the field whatever
  that provider calls it
- Writes the record name **the way that panel expects it**. Most panels append
  the zone themselves, so pasting a fully-qualified name silently creates
  `host.example.com.example.com` — which looks correct in the form and fails
  verification with no explanation
- Exports every record as **CSV**, and generates a **handover message** for
  whoever actually controls the DNS, stating what the records do and what they
  do not touch (no MX or SPF changes, nothing at the apex)

Unrecognised providers fall back to the generic instructions.

### Branding assets

Favicons and logos are uploaded, not linked. The bytes pass through the API
rather than going straight to object storage, because the re-encode is the
security control: the image is decoded and written out as a fresh PNG, so
polyglot files, embedded markup and EXIF payloads cannot survive into a URL we
serve. Keys are content-addressed, so replacing a logo publishes a new URL and
no cache can serve the old one.

### One rule that is not configurable

View-only mode hides the control that exits full screen — which is also an
anonymous visitor's only route to **Report**. That trade belongs to a workspace
owner on a domain they are accountable for. It is never theirs to make on
markdrop.in, where the liability is ours, so the setting is ignored entirely off
their own domains.

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
| `MARKDROP_ARTIFACT_MAX_VIDEO_BYTES` | Per-file limit for video | `524288000` (500 MB) |
| `MARKDROP_VERCEL_API_TOKEN` | Attaches verified custom domains so TLS is issued. Unset → domains verify but must be attached by hand | — |
| `MARKDROP_VERCEL_PROJECT_ID` | Hosting project the domain is added to | — |
| `MARKDROP_VERCEL_TEAM_ID` | Only when the project lives in a team | — |
| `MARKDROP_CUSTOM_DOMAIN_CNAME_TARGET` | What customers point their `CNAME` at | `cname.vercel-dns.com` |

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
- [x] Phase 2 — Custom slugs, expiry, view counts, password protection, toolbar
- [x] Phase 3 — P2P file sharing (WebRTC DataChannel, no server storage)
- [x] Phase 4 — Accounts, dashboard, per-document analytics, API tokens
- [x] Phase 5 — VS Code two-way sync, Google Docs export, live document updates
- [x] Phase 6 — Mermaid + KaTeX rendering, dynamic OG link previews, README builder
- [x] Phase 7 — Artifacts: HTML, PDF, Office and zipped sites on R2 + isolated origin
- [x] Phase 8 — Opt-in end-to-end encryption, key rotation and recovery
- [x] Phase 9 — Workspaces: custom domains, white-label branding, view-only CDN
      mode, folders, roles, consent-based invitations and a shared library
- [x] Phase 10 — Video artifacts with a custom player and Range-based seeking
- [ ] Next — Workspace ownership transfer, passphrase-derived keys (nothing
      secret in the link), encrypted artifacts, artifact screenshots for OG
      cards, PPTX, document version history, TURN server for P2P behind strict
      NAT, Google Docs two-way sync

---

## License

[MIT](LICENSE)
