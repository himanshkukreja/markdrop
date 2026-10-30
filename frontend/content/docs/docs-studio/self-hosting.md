---
title: Self-hosting (early)
nav: Self-hosting
description: The engine behind Docs Studio is open source. Build a folder of Markdown into a docs site and serve it on your own machine with Node or Docker. Early.
updated: 2026-10-31
prerequisites: [/docs-studio/what-readers-get]
keywords: [self-host, self-hosting, docker, open source, docs-platform, build, serve, static site, markdown folder, own server]
---

:::warning[Early]
Self-hosting is early. It works, but it hasn't had much use outside Markdrop yet, there's no published image (you build it from the repository), and its commands may still change. Docs Studio itself, at markdrop.in, is the supported way to run a docs site.
:::

The engine that builds Docs Studio sites and docs.markdrop.in lives in the [Markdrop repository](https://github.com/himanshkukreja/markdrop) under `docs-platform/`, with the renderer in `frontend/`. It's MIT-licensed. It takes a **content folder** and turns it into a static site: pages, a Markdown copy of each, search, link-preview images, `llms.txt` and the `/mcp` server. Then it serves that site, on one machine.

## What a content folder looks like

```text title="my-docs/"
my-docs/
├── site.json                 the site's name, sidebar, theme and brand
├── guide/
│   ├── start.md              one Markdown file per page
│   └── publish.md
├── public/docs-assets/       images and files the pages use
└── redirects.json            old addresses → new ones (optional)
```

```json title="site.json"
{
  "id": "example",
  "name": "Example Docs",
  "description": "A two-page site that shows the shape of a docs content folder.",
  "url": "http://localhost:8080",
  "tabs": [],
  "nav": [
    { "group": "Guide", "icon": "home", "pages": ["/guide/start", "/guide/publish"] }
  ]
}
```

Pages are Markdown with a front matter block (`title`, `description`, `updated`), in the same format as Docs Studio's [Markdown mode](/docs-studio/editor#visual-or-markdown): callouts, steps, tabs, cards and code blocks work the same. `site.json` also takes a `theme` with the [six presets](/docs-studio/themes), fonts, corners, colour mode and custom CSS. `docs-platform/examples/minimal` is a complete two-page example.

## Run it with Docker

From a clone of the repository:

```bash
docker build -f docs-platform/docker/Dockerfile -t markdrop-docs .
docker run --rm -p 8080:8080 \
  -v "$PWD/my-docs:/site:ro" \
  -v markdrop-docs-data:/data \
  markdrop-docs
```

Open `http://localhost:8080`. The container builds the folder mounted at `/site` and serves it. When a file changes it rebuilds, and switches to the new build only once it's complete; if a build fails, it keeps serving the last good one. Keep `/data` on a volume so rebuilds only redo what changed. The image includes the engine's dependencies, so it's large (around 1 GB).

## Run it with Node

You need Node 22 and the repository's dependencies installed in both `frontend/` and `docs-platform/` (`npm ci` in each).

```bash
cd docs-platform
node builder/cli.mjs bundle
node server/server.mjs start --content ../my-docs --data /tmp/my-docs-data --port 8080 --watch
```

## What's different from Docs Studio

- **No editor, roles or reviews.** You edit the files; your Git workflow is your review.
- **Ask AI** needs Markdrop's backend. Leave it off in `site.json`.
- **Page feedback** needs a URL of your own to receive it.
- **No password or members-only access.** Put the server behind your own sign-in if you need that.
- **One build at a time** per data folder.

Want the Markdown in Git *and* the Docs Studio editor? That's [GitHub sync](/docs-studio/github-sync), which is coming soon.
