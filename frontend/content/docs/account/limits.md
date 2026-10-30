---
title: Limits
description: Every limit in one place - document size, file sizes, storage, versions, sharing, workspaces, domains and request rates.
updated: 2026-10-30
keywords: [limits, quota, storage, max size, file size, rate limit, how many, maximum]
---

These are the limits Markdrop applies today. Sizes in MB and GB are binary units (1 MB = 1,024 KB).

## Documents

| What | Limit |
| --- | --- |
| Document length | 500,000 characters |
| Title | 200 characters |
| Custom address (slug) | 3 to 50 characters: letters, numbers, `-` and `_` |
| Read password | Up to 100 characters |
| Expiry | Never, 1 day, 7 days, 30 days, or a date you choose |

Some addresses are reserved because the app uses them, like `settings` or `login`. See [Addresses](/documents/addresses).

## Files

| What | Limit |
| --- | --- |
| One file | 25 MB |
| One video or audio file | 2 GB |
| Pasted HTML | 10 MB |
| Storage per account | 20 GB, old versions included |
| Versions kept per file | 5, the current one included |
| Zipped website | 500 files, 100 MB unpacked, 25 MB for any one file |
| Uploads in progress at once | 20 |

When you're signed in, the upload page shows your storage, like "1.2 GB of 20 GB used". If an upload would take you over, Markdrop first drops the oldest old versions of that file; if that isn't enough, the upload is refused and you need to delete files or old versions. See [Replace a file and versions](/files/replace-and-versions).

The PDF viewer shows the first 50 pages of a PDF and offers the rest as a download. That's a viewer limit, not an upload limit.

## Sharing

| What | Limit |
| --- | --- |
| People added to one document | 200 |
| Recipients of a peer-to-peer transfer at once | 10 |
| Peer-to-peer file size | No limit (the receiving browser must hold each file in memory) |

## Workspaces

| What | Limit |
| --- | --- |
| Workspaces you own | 10 |
| Members per workspace | 200 |
| Invitations waiting for a reply | 100 per workspace |
| Invitation link | Expires after 7 days |
| Folders | 500 per workspace, nested up to 8 deep, names up to 80 characters |
| Custom domains | 25 per workspace |
| Unverified domain | Dropped after 7 days |
| Logo or favicon upload | 2 MB |

## Sign-in and tokens

| What | Limit |
| --- | --- |
| Sign-in on markdrop.in | Lasts 30 days |
| Email sign-in code | 6 digits, expires after 15 minutes, 5 tries |
| Sign-in on a workspace's own domain | Lasts 12 hours |
| API tokens | No expiry; revoke them in Settings |
| Connected AI apps | Access renews every hour on its own. An app that isn't used for 60 days has to connect again. |

## Request rates

Markdrop limits how fast requests can come in, to keep the service fast for everyone. Most people never reach these. Limits are counted per IP address, except where it says per account.

| What | Limit |
| --- | --- |
| Publishing and changing documents | 10 a minute |
| Reading documents through the API | 60 a minute |
| Creating API tokens | 20 an hour |
| Sending workspace invitations | 20 an hour |
| AI assistant (MCP) changes | 60 a minute, per account |
| AI assistant (MCP) reads | 300 a minute, per account |

If you go over, the request is refused with HTTP status `429`. Wait a moment and try again.
