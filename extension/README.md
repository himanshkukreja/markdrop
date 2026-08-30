<p align="center">
  <img src="https://raw.githubusercontent.com/himanshkukreja/markdrop/main/extension/icon.png" width="96" height="96" alt="Markdrop" />
</p>

<h1 align="center">Markdrop Sync</h1>

<p align="center">Publish and two-way sync your Markdown &amp; HTML to <a href="https://markdrop.in">Markdrop</a> — straight from VS Code.</p>

---

Stop copy-pasting AI-generated docs into a browser. Write in VS Code (Claude Code,
Codex, your own notes), **publish once**, and share the link. When the file
changes — locally *or* on the web — both stay in sync.

Markdown publishes as a rendered document. **HTML publishes as a live page** at
its own link, not as escaped source — so a report, dashboard or one-off page you
are editing locally is always current at a URL you can send anyone.

## What you can sync

| File | Publishes as |
|------|--------------|
| `.md` `.markdown` `.mdx` | A rendered Markdown document |
| `.html` `.htm` | A **live page** at its own link |
| `.txt` `.csv` `.json` `.svg` | An artifact, rendered for its type |

Binary files — PDF, Word, Excel, zipped sites — can't be edited as text, so they
aren't syncable from the editor. Upload those at
[markdrop.in/upload](https://markdrop.in/upload).

## Features

- **📤 Publish in one click** — turn the active `.md` into a shareable `markdrop.in/<filename>` link, owned by your account.
- **🔁 Two-way sync** — save locally → pushes to Markdrop; edited on the web → pulls back into your file automatically.
- **🧭 Smart URLs** — the link uses your file name (`Release Notes.md` → `/Release-Notes`); collisions get a short suffix.
- **⚔️ Safe conflict handling** — if both sides changed, a side-by-side **diff** opens and you choose *keep mine*, *use web*, or *merge manually*. No silent overwrites.
- **🔒 Secure** — signs in via your browser (or a pasted API token); the token is kept in VS Code's encrypted Secret Storage and is revocable anytime.
- **📍 Status bar** — always shows whether the current file is Synced, Unsynced, or needs publishing.

## Quick start

1. **Sign in** — Command Palette (`Cmd/Ctrl+Shift+P`) → **Markdrop: Sign in**. Approve in the browser and you're back in VS Code.
   *(Alternatively: **Markdrop: Sign in with API token** and paste a token from markdrop.in → account menu → API tokens.)*
2. **Publish** — open a Markdown or HTML file → **Markdrop: Publish / link current file** (or click the status-bar button). You get a link.
3. **Edit & save** — changes sync automatically. Click the status bar to open the doc in your browser.

## Commands

| Command | What it does |
|---------|--------------|
| `Markdrop: Publish / link current file` | Create a Markdrop doc from the current file and link it |
| `Markdrop: Sync now` | Push local changes and pull remote changes immediately |
| `Markdrop: Open current document in browser` | Open the linked doc on markdrop.in |
| `Markdrop: Unlink current file` | Stop syncing this file (the web doc is left untouched) |
| `Markdrop: Sign in` / `Sign in with API token` / `Sign out` | Manage your session |

## How conflicts work

Sync uses a document revision number. A push only succeeds if you're up to date; otherwise Markdrop returns the current web version and the extension opens a **diff** (web ↔ local) with three choices:

- **Keep my local version** — overwrite the web copy with yours.
- **Use the web version** — replace your local file with the web copy.
- **Merge manually** — edit your file using the diff as reference, then save to push the merged result.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `markdrop.pushOnSave` | `true` | Push linked files to Markdrop on save |
| `markdrop.autoPull` | `true` | Pull remote changes into the local file |
| `markdrop.pollSeconds` | `10` | How often to check for remote changes (min 5) |
| `markdrop.apiUrl` | `https://api.markdrop.in` | Markdrop API base URL |
| `markdrop.webUrl` | `https://markdrop.in` | Markdrop web base URL |

## Where links are stored

Links live in a `.markdrop.json` file at your workspace root (relative path → document id/slug/revision). Commit it to share links with teammates, or add it to `.gitignore` — your call. Sync is keyed on the document's immutable id, so renaming its URL on the web won't break the link.

## Privacy

Your API token is stored in VS Code Secret Storage. Document content is sent only to your configured Markdrop API. Revoke a token anytime at markdrop.in → **API tokens**.

---

Built for [Markdrop](https://markdrop.in). Issues & source: [github.com/himanshkukreja/markdrop](https://github.com/himanshkukreja/markdrop).
