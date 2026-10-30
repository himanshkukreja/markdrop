# docs-platform: build at publish, serve from R2 + a Worker or one Docker image

Phase 1 spike for Markdrop Docs. A docs site is a content folder (`site.json`, pages,
`public/docs-assets`, `redirects.json`). This folder turns that into static, content-addressed
output and serves it in two ways: from R2 behind a Cloudflare Worker (our cloud), or from a single
self-host server (Docker). The renderer is the docs engine of docs.markdrop.in itself: the
frontend's `src/docs` and `src/app/docs-site`, built by its own Next app. There is no second
renderer.

Status: prototype. Deployed only as two noindex previews on a separate Cloudflare account used for
docs previews (`markdrop-docs-edge` serving docs.markdrop.in's content, and `senseloaf-preview`, both
on workers.dev). Locally the Worker runs in Miniflare (workerd).

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
| `/_next/static/{chunks,css,media}/**` | **Workers Static Assets** (no Worker invocation), immutable | Content-hashed engine output, shared by every site an engine builds (175 of 190 between Markdrop and Senseloaf; the rest differ only by inlined `NEXT_PUBLIC_*` values, so they have other names). Also in R2: the Worker serves one from there when the deployed assets lack it. See "Engine files as static assets" |
| `/_next/static/<build id>/*` | Static, from R2 through the Worker | `_buildManifest.js` carries the site's rewrites (its docs hosts), so it differs per site under one name. The app router never requests it |
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

### Engine files as static assets

`build` also copies the shared engine files (manifest `files` entries marked `shared`:
`/_next/static/{chunks,css,media}/**`) into an assets folder (`--engine-assets`, default
`edge/assets`, git-ignored), with a `_headers` file that makes them immutable. `wrangler deploy`
uploads that folder as the Worker's static assets (`[assets]` in `edge/wrangler.toml`, or
`--assets <dir>`); Cloudflare answers those paths itself, free and not counted as requests.

- **Routing.** Assets first, then the Worker. The folder holds only `/_next/static/` files, so every
  docs address misses it and runs the Worker. No `run_worker_first` rules: a path that a rule sends
  to the assets (`["/*", "!/_next/static/*"]`) is answered by the assets alone, and a miss there is
  a bare 404 that never reaches the Worker (tried on the preview). That would break the fallback.
- **Fallback.** Manifests still list every chunk and `publish` still uploads them to R2. A chunk
  missing from the deployed assets (a deploy from a fresh folder, a pruned version) runs the
  Worker, which serves it from R2. It costs a request; nothing breaks.
- **Versions.** The folder is additive: a build adds its engine's files and never removes any, so
  one deployment carries the files of every engine version a live site uses. Two sites built by
  different engines both work. Names are content hashes, so files never collide. A build fails if a
  name already in the folder has other bytes, rather than serve one site's file to another. Chunks
  hold engine code and public env, never site content: a site's text reaches readers only through
  its HTML, payloads and files.
- **Order.** Build → deploy the Worker (wrangler uploads only new files) → publish (flip the
  pointer). Any order works: a site published before the deploy gets its new chunks from R2 until
  the deploy.
- **Rebuild and cleanup.** `markdrop-docs assets <dir> --r2 <bucket> [--prune] [--dry-run]` reads
  every site's pointer (current and previous manifest, so a rollback keeps its files). It fetches the
  shared files the folder lacks from R2, which is how a fresh CI machine rebuilds the folder. With
  `--prune`, it deletes engine files that no live manifest references. Then deploy. Pruning never
  breaks a page: an old page still open in a tab that lazy-loads a pruned chunk gets it from R2
  through the Worker (R2 objects are never deleted). Plan: run `assets --prune` and redeploy after
  an engine release once every site has been rebuilt on it, or weekly. The folder stays a few MB
  per live engine version (about 200 files, 6.5 MB), well under the free plan's 20,000 files per
  Worker version.

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

### After: hover prefetch + engine files as static assets (live previews, `pageview.mjs --live`)

Measured on the deployed previews (workers.dev) before and after the change. Counts are Worker
invocations: requests that left the browser and that the Worker answered (Static Assets answers
carry no `X-Robots-Tag`, which the Worker sets on every preview response). The scripted visit
loads the page, idles 3 s, scrolls, opens search, then hovers and clicks a sidebar link.

| | First view | Repeat view | Click (hover, then click) |
|---|---|---|---|
| Markdrop `/cli/install`, before | 44 = 1 page + 30 chunks + 10 prefetches + 1 search index + 2 × 404 | 12 | 4 prefetches |
| Markdrop `/cli/install`, after | **4** = 1 page + 1 search index + 2 × 404 (`/_vercel/*insights`, open decision 7); 25 chunks from Static Assets | **3** | **1** (the hover prefetch; the click used it) |
| Senseloaf `/hiring-agents/sia-hiring-ai`, before | 50 = 1 page + 27 chunks + 20 prefetches + 1 image + 1 search index | 21 | 1 image |
| Senseloaf `/hiring-agents/sia-hiring-ai`, after | **3** = 1 page + 1 image + 1 search index; 26 chunks from Static Assets | **1** | **2** (hover prefetch + 1 image) |

A reader moving the pointer over the sidebar adds one prefetch per link they pass over (the
router's cache makes a second pass free). On the free plan (100k requests a day) a first view now
costs 3–4 requests instead of 44–50.

## Verification (`test/verify.mjs`: every route compared against `next start` of the same build)

| Server | Markdrop | Senseloaf |
|---|---|---|
| Self-host (Node, `server/server.mjs serve`) | 1,329 / 1,331 byte-identical (after the hover-prefetch build) | 673 / 676 byte-identical (before) |
| Worker in Miniflare (`test/miniflare.mjs`) | 1,316 / 1,319 byte-identical (before) | — (same handler) |

The checks cover every route as HTML, RSC, prefetch and `Accept: text/markdown`, a trailing-slash
variant of every page, chunks and 404s. The 2 differences are the page 404s (`/no/such/page` and its
`.md`): the requested path appears in the 404 payload. A missing `/docs-assets/` file is now the same
plain-text 404 on both (it used to be the Markdrop app's 404 page on Next).

Also checked: Range on site files (206 with correct bytes), ETag → 304, the MCP `initialize`,
`search_docs` and `read_page` (identical to Next's `/mcp`), and redirects (unit test). Full-app
build vs staged build: the rendered DOM of all 190 Markdrop pages is identical. Self-host
`--watch`: an edit went live in 16 s with 6 objects uploaded, and the old build was served until
then. `test/edge.test.mjs` (4 tests) covers routing, negotiation, caching, Range, redirects, 404
and the host check; `test/assets.test.mjs` covers which engine files are shared, the additive export
with its collision guard, and the `assets` rebuild/prune.

## Commands

```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
cd docs-platform && npm install          # esbuild, wrangler (Miniflare)
npm test                                 # bundle the edge + unit tests

# Build (the engine is ../frontend; it needs its node_modules)
node builder/cli.mjs build <content-dir> --out <dist> [--work <dir>] \
     [--assets <dir>=<url-prefix>]... [--port 3591] [--force] [--engine-assets <dir>|none]
#   Markdrop's own docs keep their files in frontend/public:
node builder/cli.mjs build ../frontend/content/docs --out /tmp/md-dist \
     --assets ../frontend/public/docs-assets=/docs-assets

# Publish to a store (a folder, or R2 over its S3 API), flip the pointer, map hostnames
node builder/cli.mjs publish <dist> --store <dir> [--site <id>] [--host <hostname>]... [--dry-run]
node builder/cli.mjs publish <dist> --r2 <bucket> ...    # CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
node builder/cli.mjs diff <old manifest.json> <new manifest.json>    # what a publish would upload
node builder/cli.mjs point --r2 <bucket> --site <id> --manifest <sha256>   # restore: re-point to an earlier build
node builder/cli.mjs media <content-dir>       # media.json from <content>/public/docs-assets (sizes, clips)

# Run one dashboard job (build or GitBook import): see runner/README.md
node runner/run-job.mjs --job <id> --api <base>          # GitHub Actions (MARKDROP_DOCS_JOB_TOKEN in the env)
node runner/run-job.mjs --spec spec.json --result r.json  # the backend's local worker

# Engine files for the Worker's static assets: rebuild the folder from the live manifests, prune
node builder/cli.mjs assets edge/assets --r2 <bucket> [--prune] [--dry-run]

# Deploy the Worker (bundle first) with the engine files as its static assets
cd edge && CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler deploy [--assets <dir>] [--name <worker>]

# Serve
node builder/cli.mjs bundle                                     # edge/dist/{worker,handler,mcp-engine}.mjs
node server/server.mjs serve --store <dir> [--site <id>] --port 3562      # Node, many sites by host
node test/miniflare.mjs --store <dir> --port 3563                         # the Worker in workerd
node server/server.mjs start --content <dir> --data <dir> --port 8080 --watch   # self-host: build + serve

# Verify
node test/verify.mjs --manifest <dist>/manifest.json --next <next-start port> --edge <port> --edge-host <host>
node test/pageview.mjs --origin http://<host>.localhost:3563 --path /some/page   # Miniflare (counts chunks too)
node test/pageview.mjs --live --origin https://<worker>.workers.dev --path /some/page  # a deployed Worker

# Docker (not built here: no Docker on the dev machine; the Node server above is what it runs)
docker build -f docs-platform/docker/Dockerfile -t markdrop-docs .
docker run --rm -p 8080:8080 -v "$PWD/my-docs:/site:ro" -v markdrop-docs-data:/data markdrop-docs
```

## Layout

```
builder/  cli.mjs (build, publish, point, assets, media, diff, bundle) · stage.mjs (the engine stage) ·
          crawl.mjs · build.mjs (objects + manifest + engine assets) · store.mjs (stores, publish,
          point, assets sync) · media.mjs (media.json) · bundle.mjs (esbuild) · mime.mjs
runner/   run-job.mjs + lib.mjs (one build or import job, from the API or a spec file) ·
          github-workflow.yml (the private builder repo's workflow) · README.md (setup, routing,
          measurements, the local worker's systemd unit)
edge/     handler.mjs (the fetch handler) · worker.mjs (R2 + Cache API) · wrangler.toml ·
          mcp-entry.mjs + shims/ (fs, path, next/server for the bundled MCP route) ·
          assets/ (git-ignored: the shared engine files, deployed as Static Assets)
server/   server.mjs (Node: serve a store, or build + serve + watch a folder)
docker/   Dockerfile (+ .dockerignore; context = repo root)
examples/ minimal/ (a 2-page site; also warms the Docker image's build cache)
test/     edge.test.mjs · assets.test.mjs · runner.test.mjs · verify.mjs · miniflare.mjs · pageview.mjs
```

## Open decisions for the owner

1. ~~Next's link prefetch~~ **Decided and built: prefetch on intent.** Docs links
   (`src/docs/client/Link.tsx`) prefetch on pointerenter, touchstart and focus, not when they
   scroll into view.
2. ~~Where engine chunks are served~~ **Decided and built: (a) Workers Static Assets**, with the
   R2 fallback and the cleanup plan in "Engine files as static assets". (The other options were an
   `assetPrefix` host on R2's public domain, which moves chunks off the customer's domain and
   affects CSP, or keeping them in the Worker.)
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
   and `/_vercel/speed-insights` scripts, which 404 off Vercel. That is 2 of the 4 Worker requests
   a first view now costs. Drop or replace them, and build with the production `NEXT_PUBLIC_*` env
   (these are inlined at build time).
8. **Cold/warm cache variance.** Persist `.next/cache` per build worker, or accept a one-time
   re-upload after a cache loss.

## Engine issues found (all fixed)

- ~~Every docs page linked `/manifest.webmanifest`~~ (a 404 on the docs host; on a customer site
  it would have been Markdrop's manifest). The root's file-based manifest was re-applied below the
  docs layout, so its `manifest: null` had no effect. Fixed: the manifest is a route
  (`app/manifest.webmanifest/route.ts`), linked from the root layout's metadata, and the docs
  layout drops it. App pages are unchanged.
- ~~`AuthContext` sent `POST https://api.markdrop.in/api/v1/beat` on every docs site~~. Fixed in
  4f7f941; no `/api/v1/beat` on either preview.
- ~~A missing `/docs-assets/x.png` rendered the Markdrop app's 404 page~~ on the docs host. Fixed:
  the docs-assets rewrite exists for every docs site, so a miss gets the route's plain-text 404, on
  Next and on the edge alike.

## Known limits of the prototype

- One build at a time per work folder (the stage and its `.next` are shared). Use one work folder
  per build worker. `--port` picks the crawl port.
- `publish --r2` uploads with an R2 API key pair (S3 API). Customer CI would need presigned URLs
  or a per-site token instead (open decision 3).
- `test/miniflare.mjs` doesn't emulate Static Assets: its counts still include chunks. Use
  `pageview.mjs --live` against a deployed Worker for real numbers.
- `--watch` uses `fs.watch` (recursive). Docker Desktop bind mounts on macOS may need polling.
- The asset hash uses path, size and mtime (not content) for the change key. Objects themselves
  are content-hashed.
- Per-site assets, redirects and anchors are being reworked in the engine concurrently. The
  builder reads `<content>/public` and `redirects.json` (`{status, redirects: [{from, to, same}]}`)
  as they are today.
