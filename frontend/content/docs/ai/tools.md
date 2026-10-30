---
title: MCP tools
nav: Tools
description: Every tool of Markdrop's hosted MCP server and the local markdrop mcp server, grouped by area, with the permission and inputs each one takes.
updated: 2026-10-30
keywords: [mcp tools, publish_document, publish_page, set_access, create_upload, upload_file, share_files, get_document_analytics, scopes, reference]
---

Markdrop has two MCP servers. The hosted server at `https://api.markdrop.in/mcp` has 26 tools; the local server, `markdrop mcp` in the CLI, has 11. Your assistant picks the tool from what you ask; you rarely need the names. This page is the reference for when you do.

In the tables, **Permission** is the one the app must have been given when you approved it: `read` is `documents:read` and `write` is `documents:write`. See [Connect an AI app](/ai/hosted-mcp#the-two-permissions).

Wherever a tool takes `document`, it accepts a slug (`q3-report`), a markdrop.in link, or the document's link on a workspace's own domain. Wherever it takes `workspace`, it accepts the workspace's id, its name or one of its custom domains.

## Hosted server tools

### Publish and edit

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `publish_document` | write | Publishes Markdown as a document that renders headings, tables, code, Mermaid diagrams and math. Returns the link. | `markdown`, and the publish options below |
| `publish_page` | write | Publishes a complete HTML page, or a `.txt`, `.csv`, `.json` or `.svg` file, as a link that opens rendered. Up to 25 MB. | `filename` (with its extension), `content`, and the publish options |
| `update_document` | write | Replaces the full content of a document or text file, keeping its link. Works on documents you own or can edit. | `document`, `content`, `title` |
| `delete_document` | write | Deletes a document or file you own, permanently. Marked as destructive, so apps that honour that ask you first. | `document` |

The **publish options** are all optional:

| Option | Values |
|---|---|
| `title` | Up to 200 characters |
| `slug` | A custom address, 3 to 50 letters, digits, `-` or `_`. A taken slug is an error, never a silent rename. Random when omitted. |
| `access` | `link` (anyone with the link, the default outside a workspace), `private`, `password` or `workspace` |
| `password` | Required with `access: "password"` |
| `expires` | `never` (default), `1h`, `1d`, `7d` or `30d`, counted from now |
| `workspace`, `folder` | File it in a workspace and an existing folder there. Without `access`, the folder's setting for new items applies, otherwise the workspace's default. |

Results carry `url` (on the workspace's custom domain when it has a live one), `markdrop_url`, `slug`, `title`, `access` and `expires_at`.

### Read and find

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `get_document` | read | Reads a document or text file you can open: content (up to 200,000 characters), title, access, views, workspace and folder. For other files it returns the file's details instead. | `document` |
| `list_documents` | read | Lists documents and files, newest first. | `query`, `kind` (`all`, `document`, `file`), `scope`, `limit` (1–50, default 20), `cursor` |
| `search` | read | Searches titles and slugs (and, for your own documents, text). Returns ids to pass to `fetch`. | `query`, `scope` |
| `fetch` | read | Returns the full text of a search result. | `id` |

`scope` is `mine` (default: your own), `workspaces` (what you can open in your workspaces) or `all` (both, plus documents shared with you).

Password-protected and end-to-end encrypted documents can't be read by any tool.

### Access

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `set_access` | write | Changes who can open a document you own: `link`, `private`, `password` or `workspace`. A document has one access level at every address, so `link` on a workspace document makes it public on markdrop.in and on the workspace's domain alike. | `document`, `access`, `password`, `remove_password`, `expires` |

With `access: "link"`, a password the document already has is kept and applies again unless `remove_password` is `true`.

### Files and uploads

For files up to 2 GB that live on the machine where the assistant can run shell commands. If the assistant runs on your computer, the local server's `upload_file` and `replace_file` are simpler.

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `create_upload` | write | Starts an upload of a new file, or of a replacement for an existing one (`target_slug`). Returns signed part addresses and the exact shell commands (`split` and `curl`) that send the file straight to storage. | `file_name`, `size_bytes`, `sha256`; `target_slug`, `content_type`, `title`; for new files `access`, `password`, `workspace`, `folder`, `slug` |
| `complete_upload` | write | Finishes the upload: Markdrop checks the size and SHA-256, then publishes the file or swaps it in as a new version. Returns the link, or `verifying` for a large file. Safe to call again. | `upload_id`, `parts` (optional) |
| `get_upload_status` | read | State of an upload: `uploading` (with parts received), `verifying`, `done` (with the link and version), `failed`, `expired` or `cancelled`. | `upload_id` |
| `get_file_info` | read | A file's type, size, SHA-256, current version and, for video or audio, duration, dimensions, poster and download links. | `document` |
| `list_file_versions` | read | The kept versions of one of your files, newest first, marking the current one. Up to five are kept. | `document` |
| `restore_file_version` | write | Makes an earlier version current again, as a new version. Nothing is deleted. | `document`, `version` |

Zipped websites can't be uploaded with `create_upload`; use [markdrop.in/upload](https://markdrop.in/upload).

### Analytics

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `get_document_stats` | read | Views, unique readers, read depth, top referrers and the last view of a document you own. | `document` |
| `get_document_analytics` | read | How a document or file you own is doing: views, people, top sources and what the dashboard noticed. For video and audio: how many are still watching at 0:30, 25%, 50%, 75% and the end, where most leave, and playback health. For Markdown: how far readers get section by section and what they copy and click. For PDFs: how many reach each page. Returns a short summary you can quote. | `document`, `range` (`7d`, `30d` (default), `90d`, `all`) |

Your own views are never counted, and views by members of the document's workspace are left out. See [What gets counted](/analytics/what-gets-counted).

### Workspaces and folders

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `list_workspaces` | read | Your workspaces: id, name, your role, custom domains (and whether each is live) and the default access for new documents. | none |
| `list_folders` | read | A workspace's folders as paths (`guides/setup`), with how many items you can open in each. | `workspace` |
| `list_workspace_items` | read | Documents and files you can open in a workspace or one folder of it, newest first, with their links. | `workspace`, `folder`, `query`, `limit` (1–100, default 50), `cursor` |
| `add_to_workspace` | write | Files one of your own documents into a workspace (and folder). It keeps its link; its access changes only if you pass `access`. | `document`, `workspace`, `folder`, `access` (`link`, `private`, `workspace`) |
| `remove_from_workspace` | write | Takes a document out of its workspace (its owner or a workspace admin). It keeps its markdrop.in link; a members-only document becomes private. | `document` |
| `create_folder` | write | Creates a folder by path, with any missing parent folders. | `workspace`, `path` |
| `move_to_folder` | write | Moves a workspace document to another folder of the same workspace, or to the top level when `folder` is omitted. | `document`, `folder` |

### Peer-to-peer shares

The hosted server can't send or receive files; that needs the [local server](/ai/local-mcp). It can see your shares.

| Tool | Permission | What it does | Main inputs |
|---|---|---|---|
| `list_shares` | read | Peer-to-peer shares you started while signed in (in the browser, or from the CLI with your API token), newest first: whether each is live, recipients connected now and downloads finished in a browser. A share is listed once its first recipient has connected. | `limit` (1–50, default 20), `live_only` |
| `get_share_status` | read | Whether a share link's sender is online and people can join. For your own shares, also what is shared and how many have downloaded. | `link` |

## Local server tools

These run on your computer, inside `markdrop mcp`. They have no permissions to approve; the file and workspace tools act as the owner of the API token the server was given. See [Add the local MCP server](/ai/local-mcp).

### Publish files from disk

| Tool | Token | What it does | Main inputs |
|---|---|---|---|
| `upload_file` | Yes | Publishes a file from this computer (video and audio up to 2 GB) and returns its link. Resumes when called again with the same arguments. | `path`, `title`, `access` (`link`, `private`, `password`, `workspace`), `password`, `workspace`, `folder`, `slug` |
| `replace_file` | Yes | Replaces the file behind an existing link with a file from this computer. Link, access, title and views stay; the previous version is kept. | `document`, `path`, `title` |
| `list_file_versions` | Yes | A file's versions, newest first. Up to five are kept. | `document` |
| `restore_file_version` | Yes | Makes an earlier version current again, as a new version. | `document`, `version` |
| `get_file_info` | Yes | Link, type, size, SHA-256, version, dates and video or audio details. | `document` |

Results of `upload_file` and `replace_file` carry `url`, `markdrop_url`, `slug`, `version`, `size_bytes` and `sha256`.

### Workspaces

| Tool | Token | What it does | Main inputs |
|---|---|---|---|
| `list_workspaces` | Yes | Your workspaces: id, name, role, custom domains (verified, live, default) and default access. | none |
| `list_folders` | Yes | A workspace's folders: id, name, path, depth and item count. | `workspace` |

### Share peer to peer

| Tool | Token | What it does | Main inputs |
|---|---|---|---|
| `share_files` | No | Shares files or folders and returns a `markdrop.in/share` link. Several paths or a folder go as one zip. Serves one recipient at a time until stopped or the app closes. | `paths` (1–100) |
| `share_status` | No | State (`waiting`, `connecting`, `transferring`, `done`, `stopped`, `error`), progress, recipients served, saved paths and the last error of each share and download in the session. | `share_id` (a share id or a receive id; omit for everything) |
| `stop_share` | No | Stops a share; anyone downloading is told the sender stopped. Given a receive id, cancels that download. | `share_id` |
| `receive_share` | No | Downloads a share link into `~/Downloads/Markdrop` or a folder you name, in the background. Never overwrites. | `link`, `directory` |

With a token, shares started by `share_files` are also listed by the hosted server's `list_shares`.

## Same name, two servers

`get_file_info`, `list_file_versions`, `restore_file_version`, `list_workspaces` and `list_folders` exist on both servers and do the same thing. If an app has both servers, either may answer.
