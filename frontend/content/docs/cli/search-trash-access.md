---
title: Search, trash and access requests from the terminal
nav: Search, trash and access
description: Find anything you can open with markdrop search, delete and restore with markdrop trash, and ask for or answer access requests with markdrop access.
updated: 2026-11-04
prerequisites: [/cli/install, /cli/login-and-tokens]
since: CLI 0.6.0
keywords: [markdrop search, fuzzy search, search inside documents, snippet, markdrop trash, trash ls, trash restore, trash rm, delete forever, permanent, markdrop access, request edit access, approve, decline, access requests, json]
---

These commands need an API token. See [Sign in with an API token](/cli/login-and-tokens). Each takes `--json` to print one JSON object on standard output.

## Search

```bash
markdrop search roadmap
```

```text
KIND    TITLE         WHERE                LINK                                 MATCHED
page    Roadmap 2026  Acme                 https://docs.acme.com/roadmap-2026   Q3: ship the importer, then the roadmap review
file    roadmap.pdf   -                    https://markdrop.in/roadmap-pdf      Roadmap 2026 · Product, platform and growth
folder  Roadmaps      Acme / Plans         https://markdrop.in/w/671a…/f/671b…
guide   Release plan  Help center/release  https://markdrop.in/guides/…         How we plan a release and update the roadmap
```

Searches everything you can open, the same way as the search box in the app: titles, headings, the text of pages and documents, and the text inside HTML files and PDFs, plus folders, workspaces and the Guides pages you work on. Typos, partial words and any word order are fine: `markdrop search onbording plyabook` finds **Onboarding Playbook**. **MATCHED** shows the text that matched (with `--json`, `snippet`, and `match` says whether it was the `title`, a `heading` or the `body`). Encrypted documents are found by their link only, and nothing in the Trash is listed. Give at least two characters. See [Search](/workspaces/search) for how it ranks.

| Flag | What it does |
|---|---|
| `--kind` | Only `page`, `document`, `file`, `folder`, `workspace` or `guide`. |
| `--workspace` | Only results in that workspace (its id, name or custom domain). |
| `--limit` | How many results: 20 by default, at most 50. |

:::note
CLI 0.6.0 searches titles, addresses and file names only, up to 20 results per kind, and has no `guide` kind. Later versions search inside the text as above. They fall back to the titles-only search when the server doesn't have the full one yet.
:::

## Trash

Deleting a page, document or file moves it to the trash. Its link stops working at once, and for 30 days you can bring it back as it was; then it is deleted for good. See [Delete and restore](/documents/trash).

```bash
markdrop trash rm release-notes
markdrop trash ls
markdrop trash restore release-notes
```

```text
KEY             KIND  TITLE          FROM            DELETED               DAYS LEFT
release-notes   page  Release notes  Acme / Guides   2026-11-04 09:30 UTC  30
671b03f4a7c2…   folder  Old drafts   Acme            2026-11-02 14:05 UTC  28
```

- `trash ls` lists your deleted items, and everything deleted from workspaces you administer. `--workspace` narrows it to one.
- `trash restore` takes a slug or link, or for a folder the `KEY` that `trash ls` shows. A page comes back with the sub-pages deleted with it, a folder with everything in it.
- `trash rm` only deletes what you own. A page with pages inside it needs `--children delete` (they go to the trash with it, and come back with it) or `--children lift` (they move up a level and stay).

### Delete forever

```bash
markdrop trash rm release-notes --permanent
```

```text
  Delete release-notes forever? This can't be undone. [y/N]:
```

`--permanent` deletes it now, without the 30 days, also for an item that is already in the trash. It asks first. In a script, where nobody can answer, it refuses unless you add `--yes`.

## Access requests

### Ask for edit access

```bash
markdrop access request https://markdrop.in/handbook --message "Fixing the setup steps"
```

Asks for edit access to a page, document or file you can open but not edit, like **Request edit access** in the app. Its owner, or the workspace's admins when it has no owner who can be reached, get an email to approve or decline, with your message. You get an email when they decide. `--view` asks to open something you can't open yet instead. See [Request access](/sharing/request-access).

### Answer requests

```bash
markdrop access requests
```

```text
ID                        STATUS   WANTS  FROM                           DOCUMENT                ASKED
671d5e0aa4c2b9e1f3d7a812  pending  edit   Rahul Mehta <rahul@acme.com>   Handbook (handbook)     2026-11-04 08:55 UTC
  671d5e0aa4c2b9e1f3d7a812: "Fixing the setup steps"
```

```bash
markdrop access approve 671d5e0aa4c2b9e1f3d7a812
markdrop access decline 671d5e0aa4c2b9e1f3d7a812
```

`access requests` lists requests to open or edit your documents, newest first; `--status approved`, `declined` or `all` shows others. Approving shares the document with the requester's email address and sends them an email: a request to edit gives edit access to that page only, a request to open gives view access. `--role editor` or `--role viewer` gives other access than they asked for; a request to edit can only be approved as editor. Declining sends them an email too.
