---
title: Self-hosting
nav: Self-hosting
description: Run a guide on your own server with the open-source engine behind Markdrop Guides. Export it from the studio and serve it with one Docker command.
updated: 2026-11-02
prerequisites: [/guides/what-readers-get]
keywords: [self-host, self-hosting, docker, docker image, ghcr, open source, mit, export, download guide, zip, content folder, no lock-in, leave markdrop, own server, reverse proxy, caddy, nginx, docs-platform, node]
---

The engine that builds every Markdrop Guides site, and docs.markdrop.in, is open source under the MIT license. It lives in the [Markdrop repository](https://github.com/himanshkukreja/markdrop) (`docs-platform/`, with the renderer in `frontend/`). It takes a **content folder** (a `site.json`, one Markdown file per page, and the images and files the pages use) and serves it as a guide: the same pages, search, themes and link previews readers get on Markdrop.

You can export any guide from the studio as that folder at any time, so your guide is never locked in.

:::note[Early]
Self-hosting is new. The image is published from the repository with each release; the first one appears with the first release tag. Commands may still change before version 1.
:::

## What works on your own server

**On your server:**

- Every page, the sidebar, tabs and redirects
- [Themes](/guides/themes), including a custom theme from the theme builder, fonts and your logo
- Search, link previews, light and dark mode
- The [changelog](/guides/changelog) with its RSS feed
- The [API reference](/guides/api-reference), Try it included
- Videos, and the [Markdrop files your pages embed](/guides/embed-files)
- `llms.txt`, a Markdown copy of each page, and the `/mcp` server

**Stays with Markdrop:**

- The [editor](/guides/editor), [reviews](/guides/reviews) and roles. You edit the Markdown files.
- [Ask AI](/guides/ask-ai). It runs on Markdrop's API, which answers only a guide's own Markdrop addresses.
- [Insights](/guides/insights), the [Fix list](/guides/fix-list) and "Did this page help?". They report to Markdrop.
- [Private pages](/guides/private-pages), passwords and members-only sign-in.
- [GitHub sync](/guides/import-from-github) and one-click publishing.
- The HTTPS certificate for your domain. Point the domain at your server and put a [reverse proxy](#behind-a-reverse-proxy) in front.

A self-hosted guide sends nothing to Markdrop or to any analytics service. The one exception is a `::markdrop` block: it loads that file from Markdrop, as it does on any site.

## Quick start

::::steps
### Get a content folder
[Export your guide](#export-a-guide-from-the-studio) from the studio and unzip it, or [write one yourself](#the-content-folder).

### Run the image
You need [Docker](https://docs.docker.com/get-started/get-docker/). From the folder that holds your guide's folder:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/my-guide:/site:ro" \
  -v markdrop-guides-data:/data \
  ghcr.io/himanshkukreja/markdrop-guides
```

The image runs on `linux/amd64` and `linux/arm64`.

### Open it
Open `http://localhost:8080`. The first build takes 20 to 60 seconds, depending on the machine; the guide answers once it's done.
::::

The container builds the folder mounted at `/site` and serves it. When a file changes, it rebuilds and switches to the new build only once it's complete. If a build fails, it keeps serving the last good one and logs why. Keep `/data` on a volume: it holds the builds and the engine's build cache, so later builds take seconds.

## Export a guide from the studio

::::steps
### Open Settings › Export & self-host
Open the guide and choose **Settings**, then **Export & self-host**. Only Guides admins can export.

### Choose what to export
- **The live guide**: what readers see now. Or **The drafts**: everything as it is in the editor, unpublished changes included.
- **Private pages and sections**: **Leave them out** (the default), or **Include them as public pages**. A self-hosted guide has no reader sign-in, so there's no way to keep them private there.

### Download
Choose **Download .zip**. The download starts at once; the link behind it works for five minutes.
::::

The zip holds one folder, named after the guide's address, with everything the engine reads:

- `site.json`: the name, sidebar, tabs, theme (with your custom theme), brand, footer and the API reference settings
- one Markdown file per page, with its title and description in front matter
- `public/docs-assets/`: the images, clips and files the pages use, and `media.json` with their sizes
- `redirects.json`, `changelog.json`, `openapi.json` and `videos.json`, when the guide has them
- `README.txt`: the command above, and what's different from the guide on Markdrop

What the export changes for a copy on your server: **Ask AI** and **Insights** are switched off in `site.json`, private content is left out or made public (your choice), and a password or members-only guide becomes public. Put your own sign-in in front of the server if it must stay private.

:::tip
Set `url` in `site.json` to the address readers will use, like `https://help.example.com`. The export keeps the guide's Markdrop address there, and the engine uses `url` for canonical links, the sitemap and `llms.txt`.
:::

## The content folder

```text title="my-guide/"
my-guide/
├── site.json                 the guide's name, sidebar, theme and brand
├── index.md                  the home page (optional)
├── guide/
│   ├── start.md              one Markdown file per page: /guide/start
│   └── publish.md
├── public/docs-assets/       images and files the pages use: /docs-assets/…
├── media.json                image sizes (optional, see below)
└── redirects.json            old addresses → new ones (optional)
```

```json title="site.json"
{
  "id": "example",
  "name": "Example Guide",
  "description": "A two-page guide that shows the shape of a content folder.",
  "url": "http://localhost:8080",
  "tabs": [],
  "nav": [
    { "group": "Guide", "icon": "home", "pages": ["/guide/start", "/guide/publish"] }
  ],
  "theme": { "preset": "clean", "mode": "both" }
}
```

Pages are Markdown with a front matter block (`title`, `description`, `updated`), in the same format as the editor's [Markdown mode](/guides/editor#visual-or-markdown): callouts, steps, tabs, cards and code blocks work the same. `theme.preset` is any of the [fourteen themes](/guides/themes#the-fourteen-themes) (`clean`, `editorial`, `technical`, `minimal`, `playful`, `helpcenter`, `midnight`, `paper`, `terminal`, `corporate`, `studio`, `academic`, `atlas`, `pastel`); `theme.custom` holds a [custom theme](/guides/themes#customize-a-theme), which is easiest to make in the studio and export. `docs-platform/examples/minimal` in the repository is a complete two-page example.

`media.json` lists each image's size, so pages don't jump while images load and dark-mode variants (`x.dark.png` beside `x.png`) are used. An export includes it. For a folder you write yourself, generate it with the image:

```bash
docker run --rm -v "$PWD/my-guide:/site" --entrypoint node \
  ghcr.io/himanshkukreja/markdrop-guides \
  /opt/markdrop/docs-platform/builder/cli.mjs media /site
```

## Run it with Node

Without Docker, you need Node 22 and a clone of the repository, with dependencies installed in `frontend/` and `docs-platform/` (`npm ci` in each).

```bash
cd docs-platform
node builder/cli.mjs bundle
node server/server.mjs start --content ../my-guide --data ../my-guide-data --port 8080 --watch
```

`start` builds the folder, serves it and, with `--watch`, rebuilds when a file changes. Leave `--watch` off on a server whose files change only when you deploy, and restart it instead.

## Configuration

- **Port:** `-p 8080:8080` maps it; inside the container it's `PORT` (default `8080`). With Node, `--port`.
- **`/site`** (`--content`): the content folder. Mount it read-only.
- **`/data`** (`--data`): builds, the published files and the engine's build cache. One server per data folder.
- **`MARKDROP_DOCS_BUILD_CPUS`**: how many processes render pages during a build. Set `1` on a machine with 1 to 2 GB of memory (`-e MARKDROP_DOCS_BUILD_CPUS=1`).
- **`MARKDROP_DOCS_BUILD_PORT`**: a local port each build uses while it renders the pages. Default `3591`; change it if something else uses it.

There's no setting for an AI key: Ask AI isn't available on a self-hosted guide yet. There's nothing to turn off for analytics either: a self-hosted guide doesn't collect any.

## Update

```bash
docker pull ghcr.io/himanshkukreja/markdrop-guides
```

Then start the container again. A new engine rebuilds every page on its first start. Tags: `latest` is the newest release, `0.1.0` and `0.1` pin a release, and `edge` follows the repository's main branch (it may break). With Node, pull the repository, run `npm ci` in both folders and `node builder/cli.mjs bundle` again.

## Behind a reverse proxy

Run the container on a local port and let a proxy handle HTTPS for your domain. The server sends relative redirects and compresses responses itself.

::::tabs
:::tab[Caddy]
```text title="Caddyfile"
help.example.com {
  reverse_proxy 127.0.0.1:8080
}
```
Caddy gets and renews the certificate for you.
:::

:::tab[nginx]
```nginx title="/etc/nginx/sites-available/help.example.com"
server {
  listen 443 ssl http2;
  server_name help.example.com;
  ssl_certificate     /etc/letsencrypt/live/help.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/help.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
  }
}
```
:::
::::

Publish the container only on the local interface (`-p 127.0.0.1:8080:8080`) so readers always come through the proxy.

## Troubleshooting

- **The page doesn't load for the first minute.** The first build is running. `docker logs <container>` shows `serving site "site"` when it's ready.
- **A change doesn't show up.** The log says `build failed, still serving the last good build` and why (often a broken `site.json`). On Docker Desktop for Mac and Windows, file changes in a mounted folder sometimes don't reach the container: restart it.
- **Images render without a size, or dark versions aren't used.** The folder has no `media.json`: [generate one](#the-content-folder).
- **Links point at the Markdrop address.** Change `url` in `site.json`.
- **A page links to a page that isn't there.** It linked to a private page the export left out. Remove the link, or export with private content included.
- **A page shows a lock.** The folder still has private-page rules (`access` in `site.json` or a page's front matter) and nothing on your server can unlock them. Export again from the studio, or remove those `access` entries.

Want Git *and* the hosted editor? [Import from GitHub](/guides/import-from-github) keeps a guide on Markdrop in sync with every push, and you can still export it any time.
