# docs-platform: build at publish, serve from R2 + a Worker or one Docker image

Phase 1 spike for Markdrop Docs. A docs site is a content folder (`site.json`, pages,
`public/docs-assets`, `redirects.json`). This folder turns that into static, content-addressed
output and serves it in two ways: from R2 behind a Cloudflare Worker (our cloud), or from a single
self-host server (Docker). The renderer is the docs engine of docs.markdrop.in itself: the
frontend's `src/docs` and `src/app/docs-site`, built by its own Next app. There is no second
renderer.

Status: prototype. Nothing is deployed and no Cloudflare account is used. The Worker runs locally
in Miniflare (workerd).

## Decision: prerender with the real Next app, then crawl it (option A, on a staged copy)

| Option | What it is | Measured | Verdict |
|---|---|---|---|
| **A. Full app build + crawl** | `next build` of the whole frontend with `DOCS_CONTENT_DIR`, then crawl the docs routes | 72 s cold, 47 s warm (587 pages: the whole app plus 190 docs pages) | Works, but compiles and type-checks ~60 app routes no reader sees |
| **A′. Staged docs-only build + crawl (chosen)** | Same app and same code, but the app routes outside the docs are renamed `_off-*` (Next's private folders) in a reused copy (`builder/stage.mjs`), and type-check and lint are skipped | **Markdrop (190 pages): 33 s cold, 11.5 s warm** (next build 9.5 s + crawl 1.9 s). **Senseloaf (95 pages): 10.9 s warm**. Minimal 2-page site: about 15 s | Rendered DOM is identical to the full build on all 190 pages. Only the chunk and stylesheet tags differ (hashes and how chunks are split) |
| **B. `output: "export"`** | Static export of the same staged app | Fails. `apple-icon` and `manifest.webmanifest` need `force-static`. Then an EISDIR collision: the route handler `/og/changelog` (a file) vs `/og/changelog/<id>` (a folder). Middleware and `/mcp` have to be removed. `404.html` would be the app's root not-found. The client router asks for `*.txt` payloads under `/docs-site/…` | Needs engine changes (OG paths with an extension, force-static icons) and still needs the edge for negotiation. Not faster (~22 s) |
| C1. Read Next's prerender cache directly | Read `.next/server/app/docs-site/*.html/.rsc/.body/.meta` with no server | Would save the 1.9 s crawl | Couples the platform to Next's internal cache format. The crawl uses the public HTTP surface and records exactly what the server sends |
| C2. A separate renderer (Astro, Markdoc, …) | — | — | Ruled out: a second renderer |

Why the crawl is safe: the route list is the build's own `prerender-manifest.json` (every
`/docs-site/…` route Next generated), so nothing depends on following links. Every HTML route is
fetched twice through the docs host: once as HTML and once as its RSC payload (`RSC: 1`). The
prefetch variant was byte-identical to the full payload on all 285 pages measured, so it isn't
stored. The 404 page comes from a probe. Files the HTML references outside `/_next/static` (the
favicon, apple-icon) are fetched as well.

## What is static and what is dynamic

| Address | Served by | Notes |
|---|---|---|
| Pages, `/changelog`, entries | Static HTML object | |
| Client navigation (`RSC: 1`, prefetch) | Static RSC object, picked at the edge by header | `Vary: RSC, Next-Router-State-Tree, …, Accept`. Without this, navigation falls back to full page loads |
| `<page>.md`, `/index.md`, `Accept: text/markdown` | Static objects, negotiated at the edge | Uses the engine's own `docsRewritePath` / `prefersMarkdown` (`src/docs/host.ts`, bundled into the edge) |
| `llms.txt`, `llms-full.txt`, `skill.md`, `sitemap.xml`, `robots.txt`, `search-index.json`, `changelog.{md,rss,json}` | Static, with the engine's own cache headers | |
| `/og/**` | Static PNG | Rendered by `next/og` at build time |
| `/_next/static/**` | Static, immutable | Byte-identical across sites built by the same engine (192/192 chunks shared between Markdrop and Senseloaf), so they upload once |
| `/docs-assets/**` (site files) | Static, `Range` supported (video) | Copied from `<content>/public` |
| 404 | The engine's 404 page (status 404) | The Next server renders the 404 per request: same page, but the requested path appears in its payload |
| `redirects.json` | Edge | Applied only when no page or file matches |
| `/mcp` | **Edge code**: the frontend's own route (`src/app/docs-site/mcp/route.ts` → `src/docs/mcp.ts`), bundled with fs/path shims and run on a content snapshot stored with the build | One engine instance per site per build in each isolate. Answers are byte-identical to the Next server's (`search_docs`, `read_page` checked) |
| `/api/geo` (consent banner) | Edge: the app's own route, given `cf.country` | Only the Markdrop site uses it |
| Ask AI | Backend (`ai.api`, api.markdrop.in) | Already cross-origin. For self-host: bring your own backend, or turn it off (open) |
| Feedback / `report_problem` | `site.feedback` URL | External |

## Output and store format

`build` writes:

```
dist/manifest.json      routes (internal path → {o: sha256, t: type, s: size, h: extra headers,
                        rsc: {o, s}}), files (path → {o, t, s, immutable?}), notFound, redirects,
                        mcp (the content snapshot object), engine, inputs (change key)
dist/objects/<sha256>   every body, named by hash
```

Route keys are the engine's internal paths (`/docs-site/cli/install`, `/docs-site/md/cli/install`).
The edge maps a request to them with the same function the Next middleware uses, so an address
means the same thing on both.

Publishing (`builder/store.mjs`) uses the same keys in R2, in a local folder, or in Miniflare:

```
objects/<sha256>              immutable (cached forever; never purged)
manifests/<sha256>.json       immutable
sites/<site>/current.json     the pointer {manifest, engine, publishedAt, previous}
hosts/<hostname>.json         {site}
```

A publish uploads only the objects the store lacks. Objects referenced by the site's current
manifest are trusted; every other object gets one HEAD check. Then it writes the manifest, then
rewrites the pointer: that one-object write is the atomic switch. Readers see the old build until
the switch. A rollback means publishing the previous dist again, which uploads 0 objects. A
preview means publishing to another site id or pointer.

Build id: Next's build id is set to the **engine version**. That is a hash of `frontend/src`
(minus the turned-off app routes), the project configs, `stage.mjs` and the Next version, not a
random value. Every page embeds the build id, so a random one would change every object on every
publish.

No-change detection: `inputs` = hash(engine version, content snapshot, asset list). When it
matches the manifest already in `--out`, the build is skipped (28–120 ms).

## Measurements (Apple-silicon laptop, Next 15.5.14, Node 22.18)

| | Markdrop docs | Senseloaf (imported from GitBook) |
|---|---|---|
| Routes (HTML pages) | 556 (190) | 293 (95) |
| Objects / total size | 1,173 / 105.6 MB | 833 / 110.1 MB |
| …HTML, avg per page (raw → brotli) | 121 KB → 16.4 KB | 91 KB → 12.3 KB |
| …RSC payload, avg per page (raw → brotli) | 69 KB → 10.9 KB | 50 KB → 8.2 KB |
| …site files (docs-assets) / engine chunks | 51.7 MB / 6.5 MB | 86.0 MB / 6.5 MB |
| Manifest | 246 KB | 180 KB |
| Cold staged build | 33 s | — |
| Warm build (stage reused) | 11.5 s | 10.9 s |
| No-change publish (inputs match) | 28 ms, 0 uploads | same |
| Forced re-render, nothing changed | 0 new objects | 0 new objects |
| One-page edit (`cli/install`, one paragraph) | 11.4 s; **14 objects / 3.1 MB** uploaded: 5 pages + their payloads (the page and 4 pages that show it), its `.md`, `search-index.json`, `llms-full.txt`, the MCP snapshot | — |
| Second site into the same store | — | 654 of 833 objects uploaded (the engine chunks were already there) |
| Worker bundle (wrangler dry-run) | 399 KiB / 90 KiB gzip (free plan limit: 3 MB) | |

Determinism: two cold builds give byte-identical output, and so do two warm builds. **A cold
build and a warm build differ** on ~170 pages: Next's webpack cache changes which chunk ids a
client reference lists in the RSC payload. Both are valid. Effect: after a cache loss, the next
publish re-uploads about half the pages once (~35 MB for Markdrop). In CI, persist `.next/cache`
(the work folder) between builds. Neither `experimental.cpus` nor page concurrency changed this.

### Worker requests per page view (Miniflare + headless Chromium, `test/pageview.mjs`)

| | First view | Repeat view (HTTP cache warm) | Click to another page |
|---|---|---|---|
| Markdrop `/cli/install` | 43 = 1 page + 29 chunks + 10 RSC prefetches + 1 search index + 2 × 404 (`/_vercel/*insights/script.js`) | 12 (1 page + 9 prefetches + 2 × 404) | 4 prefetches; the navigation itself used a prefetched payload |
| Senseloaf `/hiring-agents/sia-hiring-ai` | 50 = 1 page + 27 chunks + 20 RSC prefetches + 1 image + 1 search index | 21 (1 page + 20 prefetches) | 1 image |

**Prefetching costs more than anything else.** Next prefetches every link in view (the sidebar),
so a view costs 10–20 Worker invocations for prefetches alone. If the chunks are kept off the Worker
(see open decision 2), a first view costs 14–23 invocations. With sidebar prefetch off or on hover,
it costs 2–4. On the Workers free plan (100k requests a day), that is the difference between about
4–7k page views a day and about 30k.

## Verification (`test/verify.mjs`: every route compared against `next start` of the same build)

| Server | Markdrop | Senseloaf |
|---|---|---|
| Self-host (Node, `server/server.mjs serve`) | 1,316 / 1,319 byte-identical | 673 / 676 byte-identical |
| Worker in Miniflare (`test/miniflare.mjs`) | 1,316 / 1,319 byte-identical | — (same handler) |

The checks cover every route as HTML, RSC, prefetch and `Accept: text/markdown`, a trailing-slash
variant of every page, chunks and 404s. The 3 differences are the 404 cases:
- The requested path appears in the 404 payload.
- `/docs-assets/missing.png`: Next answers with the **Markdrop app's** 404 page there. The edge
  answers with the docs 404, which is better on a customer domain.

Also checked: Range on site files (206 with correct bytes), ETag → 304, the MCP `initialize`,
`search_docs` and `read_page` (identical to Next's `/mcp`), and redirects (unit test). Full-app
build vs staged build: the rendered DOM of all 190 Markdrop pages is identical. Self-host
`--watch`: an edit went live in 16 s with 6 objects uploaded, and the old build was served until
then. `test/edge.test.mjs` (4 tests) covers routing, negotiation, caching, Range, redirects, 404
and the host check.

## Commands

```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
cd docs-platform && npm install          # esbuild, wrangler (Miniflare)
npm test                                 # bundle the edge + unit tests

# Build (the engine is ../frontend; it needs its node_modules)
node builder/cli.mjs build <content-dir> --out <dist> [--work <dir>] \
     [--assets <dir>=<url-prefix>]... [--port 3591] [--force]
#   Markdrop's own docs keep their files in frontend/public:
node builder/cli.mjs build ../frontend/content/docs --out /tmp/md-dist \
     --assets ../frontend/public/docs-assets=/docs-assets

# Publish to a store (a folder here; R2 in production), flip the pointer, map hostnames
node builder/cli.mjs publish <dist> --store <dir> [--site <id>] [--host <hostname>]... [--dry-run]
node builder/cli.mjs diff <old manifest.json> <new manifest.json>    # what a publish would upload

# Serve
node builder/cli.mjs bundle                                     # edge/dist/{worker,handler,mcp-engine}.mjs
node server/server.mjs serve --store <dir> [--site <id>] --port 3562      # Node, many sites by host
node test/miniflare.mjs --store <dir> --port 3563                         # the Worker in workerd
node server/server.mjs start --content <dir> --data <dir> --port 8080 --watch   # self-host: build + serve

# Verify
node test/verify.mjs --manifest <dist>/manifest.json --next <next-start port> --edge <port> --edge-host <host>
node test/pageview.mjs --origin http://<host>.localhost:3563 --path /some/page

# Docker (not built here: no Docker on the dev machine; the Node server above is what it runs)
docker build -f docs-platform/docker/Dockerfile -t markdrop-docs .
docker run --rm -p 8080:8080 -v "$PWD/my-docs:/site:ro" -v markdrop-docs-data:/data markdrop-docs
```

## Layout

```
builder/  cli.mjs (build, publish, diff, bundle) · stage.mjs (the engine stage) · crawl.mjs ·
          build.mjs (objects + manifest) · store.mjs (stores + publish) · bundle.mjs (esbuild) · mime.mjs
edge/     handler.mjs (the fetch handler) · worker.mjs (R2 + Cache API) · wrangler.toml ·
          mcp-entry.mjs + shims/ (fs, path, next/server for the bundled MCP route)
server/   server.mjs (Node: serve a store, or build + serve + watch a folder)
docker/   Dockerfile (+ .dockerignore; context = repo root)
examples/ minimal/ (a 2-page site; also warms the Docker image's build cache)
test/     edge.test.mjs · verify.mjs · miniflare.mjs · pageview.mjs
```

## Open decisions for the owner

1. **Next's link prefetch** is most of a page view's Worker cost (10–20 per view). Options: keep it;
   sidebar `prefetch={false}` (hover prefetch); or turn it off on the docs entirely. This is an
   engine change.
2. **Where engine chunks are served.** They are identical across sites, so they can skip the
   Worker:
   - (a) Ship them as Workers Static Assets with the Worker deployment. Free, not counted as
     requests, still on the customer's domain. Needs the deployed Worker to carry the chunks of
     every live engine version.
   - (b) Use an `assetPrefix` host on R2's public custom domain. The CDN caches it, but the chunks
     move off the customer's domain, which affects CSP.
   - (c) Keep them in the Worker as now. This costs the most requests.
3. **Builds in customer CI vs our build workers.** A build needs the full frontend
   `node_modules` (Next, React, Tailwind) and about 10–35 s. The CLI could ship as a prebuilt
   engine tarball or Docker image (the Dockerfile here). Upload to R2 needs a credential: presigned
   URLs from our API (Fern's model) or a per-site upload token.
4. **Publish → live delay.** The pointer is trusted in each isolate for 5 s (`POINTER_TTL_MS`).
   Lower costs an R2 read per request. Higher means slower publishes.
5. **Hostname map.** Today it's R2 objects (`hosts/<host>.json`, cached 60 s per isolate). KV or
   D1 would be the production choice with Cloudflare for SaaS custom hostnames.
6. **Self-host scope.** Ask AI needs the backend (BYO key or off). Also undecided: whether the
   self-host image should also accept prebuilt dists (`serve --store`) so it can run without the
   engine's `node_modules` (an image of about 1 GB vs about 100 MB).
7. **Markdrop's own docs on this path.** The static output still references `/_vercel/insights`
   and `/_vercel/speed-insights` scripts, which 404 off Vercel. Drop or replace them, and build
   with the production `NEXT_PUBLIC_*` env (these are inlined at build time).
8. **Cold/warm cache variance.** Persist `.next/cache` per build worker, or accept a one-time
   re-upload after a cache loss.

## Engine issues found (for the engine owner; reproducible on `next start` too)

- Every docs page links `<link rel="manifest" href="/manifest.webmanifest">` (the root's
  file-based manifest wins over the docs layout's `manifest: null`). On the docs host that address
  is a 404, and on a customer site it would be Markdrop's manifest. The stage keeps `manifest.ts`
  only for parity.
- `AuthContext` (root layout, not inside `AppTrackers`) sends `POST https://api.markdrop.in/api/v1/beat`
  on **every** docs site, including Senseloaf's (seen twice per view).
- A missing file under a pass-through path (`/docs-assets/x.png`) renders the **Markdrop app's**
  404 page on the docs host.

## Known limits of the prototype

- One build at a time per work folder (the stage and its `.next` are shared). Use one work folder
  per build worker. `--port` picks the crawl port.
- No R2 upload client yet. `publish` takes a folder store; `R2Store` wraps a bucket binding
  (Worker or Miniflare). Production upload needs the S3 API or presigned URLs.
- `--watch` uses `fs.watch` (recursive). Docker Desktop bind mounts on macOS may need polling.
- The asset hash uses path, size and mtime (not content) for the change key. Objects themselves
  are content-hashed.
- Per-site assets, redirects and anchors are being reworked in the engine concurrently. The
  builder reads `<content>/public` and `redirects.json` (`{status, redirects: [{from, to, same}]}`)
  as they are today.
