# Markdrop Sync — VS Code extension

Publish and sync your Markdown files to [Markdrop](https://markdrop.in) without copy-pasting.
Great for AI-generated docs (Claude Code, Codex, etc.): edit locally, and your shared
Markdrop link stays up to date.

## Features (v0.1 — one-way sync)

- **Publish / link** the current Markdown file to Markdrop (owned by your account).
- **Push on save** — linked files sync to Markdrop automatically when you save (debounced).
- **Status bar** shows Synced / Unsynced / Publish / Sign in for the active Markdown file.
- **Conflict handling** — if the web copy changed, you choose *Overwrite web* or *Replace local*.
- **Sign in** via browser (OAuth deep-link) or by pasting an API token.

> Two-way live sync (remote → local polling with a side-by-side diff merge) is planned for v0.2.

## Setup (development)

```bash
cd extension
npm install
npm run compile
```

Then open the `extension/` folder in VS Code and press **F5** ("Run Markdrop Extension").
A new Extension Development Host window launches with the extension loaded.

## Usage

1. Run **Markdrop: Sign in** (Command Palette) — completes in the browser and returns to VS Code.
   - Or **Markdrop: Sign in with API token** and paste a token from markdrop.in → *API tokens*.
2. Open a `.md` file → **Markdrop: Publish / link current file** (or the status-bar button).
3. Edit and save — changes push to Markdrop automatically. Click the status bar to open in the browser.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `markdrop.apiUrl` | `https://api.markdrop.in` | Markdrop API base URL |
| `markdrop.webUrl` | `https://markdrop.in` | Markdrop web base URL |
| `markdrop.pushOnSave` | `true` | Auto-push linked files on save |

## How linking is stored

For files in a workspace, links live in a `.markdrop.json` file at the workspace root
(mapping relative path → `{ id, slug, baseRev, baseHash }`). You can commit it or ignore it.
Files outside a workspace fall back to VS Code global state.

Sync is keyed on the document's immutable id, so renaming the slug on the web won't break the link.
