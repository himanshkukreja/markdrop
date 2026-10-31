# Docs job runner: builds and imports for Markdrop Docs sites

A docs site's publish or GitBook import is a **job** (`docs_jobs` in Mongo). The API decides where
each job runs (`backend/app/services/docs_dispatch.py`), and one Node program runs it
(`runner/run-job.mjs`) wherever that is:

| Job | Where | Why |
|---|---|---|
| `build` (publish) | **GitHub Actions** in a private builder repo; the API box only as a fallback | A build peaks at 0.6–2.5 GB of memory; the API box has 2 GB |
| `import` (GitBook) | The API box when the source is small (≤ `MARKDROP_DOCS_LOCAL_IMPORT_MAX_PAGES` pages in its `llms.txt`, GIFs kept as GIFs); else Actions (GIFs become MP4 clips) | Imports are light (~0.5 GB) except the ffmpeg step |
| `restore`, `unpublish` | The API process itself, right after it queues the job | One small R2 write (the site pointer) or a few deletes |

```
publish ─▶ API: snapshot + build row + job (a waiting build job is reused: publishes coalesce)
        ─▶ dispatcher: route ─▶ GitHub workflow_dispatch {job_id, site_id, kind, api_base, token}
              Actions run: checkout engine ▸ restore caches ▸ run-job.mjs
                 GET  /api/v1/internal/docs-jobs/<id>      claim → spec (content folder as JSON)
                 build + publish to R2 (only new objects)
                 POST …/progress (steps, heartbeat)         POST …/result {manifest_hash, stats}
        ◀─ API: build live, previous superseded, site pointer fields, pages published
```

Mongo never leaves the server. A runner gets one job's spec through the internal API with a
per-job token (HMAC of the job id and an expiry), and needs only R2 keys of the docs account.

## run-job.mjs

```bash
# From the API (Actions, or any machine with the engine checked out and node_modules installed)
MARKDROP_DOCS_JOB_TOKEN=<token> node runner/run-job.mjs --job <id> --api https://api.markdrop.in
# From a spec file (the Python worker does this; progress as "@@progress {json}" lines on stdout)
node runner/run-job.mjs --spec spec.json --result result.json
```

Env: `MARKDROP_DOCS_R2_BUCKET` + `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (or
`MARKDROP_DOCS_STORE_DIR` for a folder store); `MARKDROP_DOCS_WORK_DIR` (stage + Next cache: keep it
between jobs), `MARKDROP_DOCS_BUILD_CPUS` (Next render workers; 1 on small machines),
`MARKDROP_DOCS_ENGINE_DIR`, `MARKDROP_DOCS_ASSET_CACHE`, `MARKDROP_DOCS_BUILD_PORT`,
`MARKDROP_DOCS_IMPORT_CACHE_DIR`, `MARKDROP_DOCS_KEEP_GIFS`, `MARKDROP_DOCS_JOB_SECRET` (mint the
token here instead of taking it from the dispatch). The R2 keys are dropped from the environment
before `next build` or the importer start. Logs are counts, sizes and timings: never page content.
Exit 3 = not this runner's job (taken, finished, or the site's other build is running).

A build: write the content folder from the spec (`site.json`, pages with frontmatter,
`redirects.json`) → fetch the site's files the pages refer to from `sites/<site>/assets/` (cached
by ETag) → `media.json` → `builder/build.mjs` → `publish` (uploads only objects R2 doesn't have,
then flips `sites/<site>/current.json` and maps the hostnames). An import: the GitBook importer into
a temp folder → upload `public/docs-assets/**` to `sites/<site>/assets/**` → the folder as data
(pages, nav, brand, redirects, `_import-report.json`) to the API, which writes the drafts.

## Owner setup (once)

1. **Create the private builder repo**, e.g. `himanshkukreja/markdrop-docs-builder` (empty is fine).
   Copy `docs-platform/runner/github-workflow.yml` to `.github/workflows/docs-job.yml` there.
2. **Repo secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: the docs Cloudflare account's R2
     key pair (Object Read & Write on `markdrop-docs-sites`), the same values as `docs-platform/.env`.
   - `DOCS_JOB_SECRET` (recommended): the same value as the server's `MARKDROP_DOCS_JOB_SECRET`. The
     run then mints its own token and never shows one in its inputs. Without it the run uses the
     token from the dispatch (valid 3 hours for that one job; GitHub shows dispatch inputs to people
     who can read the private repo).
3. **Repo variables** (optional): `DOCS_API_BASE` (pins where runs call back; default: the
   dispatch's `api_base`), `ENGINE_REF` (the markdrop commit or branch that builds sites; default
   `main`; pin a tag for repeatable builds), `ENGINE_REPO`, `DOCS_R2_BUCKET`, `DOCS_RUNNER`
   (self-hosted runner label, below), `DOCS_BUILD_CPUS`.
4. **A token for the server**: a fine-grained personal access token with access to that one repo
   only, permission **Actions: Read and write** (nothing else). It only starts runs.
5. **Server env** (backend `.env`), then restart the API:
   ```
   MARKDROP_DOCS_JOB_SECRET=<openssl rand -hex 32>
   MARKDROP_DOCS_BUILDER_REPO=himanshkukreja/markdrop-docs-builder
   MARKDROP_DOCS_BUILDER_TOKEN=<the token from step 4>
   MARKDROP_DOCS_BUILDER_WORKFLOW=docs-job.yml        # default
   MARKDROP_DOCS_BUILDER_REF=main                      # the builder repo's branch with the workflow
   MARKDROP_DOCS_JOB_API_BASE=https://api.markdrop.in  # default: MARKDROP_API_BASE_URL
   MARKDROP_DOCS_BUILD_TARGETS=actions,local           # default; "actions" = never build on the box
   MARKDROP_DOCS_ACTIONS_MONTHLY_MINUTES=1800          # stop using Actions before the free 2,000
   MARKDROP_DOCS_R2_BUCKET=markdrop-docs-sites         # + MARKDROP_DOCS_R2_ACCOUNT_ID / _ACCESS_KEY_ID /
                                                       #   _SECRET_ACCESS_KEY (restores, unpublish, uploads)
   ```
   nginx: the internal routes take JSON up to 32 MB (an import of a big site); if
   `client_max_body_size` is lower for `/api/`, raise it for `/api/v1/internal/docs-jobs/`.

Moving the builder to an organisation or another repo later is only these env values.

## Minutes, caching and self-hosted runners

The workflow caches `node_modules` themselves (frontend + docs-platform, keyed by both lockfiles;
a hit skips `npm ci`) and the builder's work folder (the staged engine + Next's `.next/cache`,
keyed by engine commit + site, falling back to the same engine, then any). Imports skip the build
cache and install ffmpeg only for themselves.

Estimate on a GitHub-hosted runner (not yet measured there; the builder repo doesn't exist yet):
checkout (sparse: `frontend`, `docs-platform`) ~5 s, node_modules cache ~15–25 s (≈900 MB
unpacked), build cache ~5–10 s (≈430 MB), build 15–35 s, publish 2–10 s: **~1–1.5 minutes per warm
build, billed as 2** (GitHub rounds each job up to the minute). A cache miss adds `npm ci` (~1–2
min). With 2,000 free minutes a month that is roughly 900–1,000 publishes; the server stops
dispatching at `MARKDROP_DOCS_ACTIONS_MONTHLY_MINUTES` (counted from each job's own timing) and
falls back to the API box under its guards. Publishes coalesce, so a burst costs one build.

**Self-hosted runner** (a spare machine; uses no minutes): install the GitHub Actions runner on it
for the builder repo with a label, e.g. `docs-builder`, and set the repo variable
`DOCS_RUNNER=docs-builder`. Unset the variable to go back to GitHub-hosted. A self-hosted runner
keeps its caches on disk, so warm builds skip the cache restore entirely (~20–40 s per build).
Requirements, from the measurements below: **2+ vCPU, 4 GB RAM** (set `DOCS_BUILD_CPUS=1` under
4 GB; 8 GB lets Next use every core), **10 GB free disk** (node_modules ~0.9 GB, work folder
~0.5–1 GB, asset cache = the sites' files), **Node 22** (setup-node installs it), ffmpeg for imports,
outbound HTTPS to github.com, api.markdrop.in and `<account>.r2.cloudflarestorage.com`.

## Measurements (Apple M3 Pro, 11 cores, Node 22.18, Next 15.5; peak = RSS of the whole process tree)

`builder/cli.mjs build`, `--force`, same work folder for cold (fresh) then warm:

| Settings | Markdrop docs (190 pages, 560 routes): cold / warm | Pilot GitBook import (95 pages, 293 routes): cold / warm |
|---|---|---|
| Next default (all cores, 22 processes) | 32.7 s, 2,475 MB / 26.7 s, 1,681 MB | 41.6 s, 1,742 MB / 24.5 s, 1,919 MB |
| 1 render worker, heap cap 1,024 MB | 35.2 s, 1,091 MB / 22.9 s, 693 MB | 27.4 s, 1,161 MB / 26.5 s, 617 MB |
| 1 render worker, heap cap 768 MB (local default) | 32.2 s, 1,145 MB / 19.5 s, 785 MB | 49.1 s, 973 MB / 32.0 s, 567 MB |
| 1 render worker, heap cap 640 MB | 90.0 s, 701 MB / 20.2 s, 837 MB | 41.0 s, 777 MB / 19.1 s, 748 MB |

The render-worker count is what bounds memory (`MARKDROP_DOCS_BUILD_CPUS=1`). The heap cap does
not, reliably: SWC and webpack hold native memory outside the V8 heap, and a tight cap makes a cold
build slow (90 s at 640 MB). Whole jobs, end to end against the docs account's R2:

| Job | Path | Time | Peak | Uploaded |
|---|---|---|---|---|
| New 6-page site, first build (fresh stage) | run-job.mjs ← local API (the Actions path) | 41 s | 1.3 GB | 141 of 212 objects, 5.4 MB |
| Same site, warm | Actions path | 16 s | 1.8 GB (all cores) | 14 objects, 0.4 MB |
| Same site, a page edited | Python worker (1 render worker, heap 768, nice) | 16.9 s | 1.04 GB | 124 objects, 5.3 MB (another work folder: see cold/warm variance) |
| Restore to version 1 | inline in the API process | 1.4 s (+ ≤ 5 s pointer TTL) | — | 1 pointer write |
| GitBook import of the pilot site (HTTP cache on disk; 81 GIFs → clips) | Actions path | 19.3 s | 0.5 GB | 269 files, 86 MB |
| Pilot site first publish | Actions path | 52 s (files 11 s, next build 10.7 s, publish 23 s) | 2.3 GB (all cores) | 387 of 832 objects, 20.6 MB |

## The local worker (API box fallback, local development, a dedicated box)

`backend/scripts/docs_build_worker.py` claims jobs routed `local`, writes the spec file and runs the
same `run-job.mjs`. Guards for the 2 GB API box: one local build at a time (across processes),
no build unless `MemAvailable` ≥ `MARKDROP_DOCS_LOCAL_MIN_FREE_MB` (default 1,200, from the
measured peak of ~1.15 GB cold / ~0.85 GB warm with one render worker), `nice -n 15` + `ionice -c3`,
`NODE_OPTIONS=--max-old-space-size=$MARKDROP_DOCS_LOCAL_BUILD_MAX_MB` (768), one Next render
worker, a hard timeout (`MARKDROP_DOCS_LOCAL_BUILD_TIMEOUT_SECONDS`, 900). When the guards say no,
the build stays queued, and goes back to Actions as soon as Actions works again.

**On 2 GB, local builds are a last resort.** A warm build (~0.6–0.85 GB) fits beside the API; a cold
one (first build after an engine release, ~1.1 GB) only with the API idle. Add a **2 GB swap file**
on the box (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon
/swapfile`, plus an `/etc/fstab` line) so a spike pages out instead of waking the OOM killer, and run
the worker in its own cgroup so the kernel kills a runaway build, never the API:

```ini
# /etc/systemd/system/markdrop-docs-worker.service
[Unit]
Description=Markdrop Docs local job worker
After=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/markdrop/backend
EnvironmentFile=/home/ubuntu/markdrop/backend/.env
Environment=MARKDROP_DOCS_WORK_DIR=/var/lib/markdrop-docs
Environment=MARKDROP_DOCS_BUILD_CPUS=1
ExecStart=/home/ubuntu/markdrop/backend/.venv/bin/python -m scripts.docs_build_worker
Restart=on-failure
RestartSec=10
# Builds are background work: the API always wins the CPU and the memory.
Nice=10
CPUWeight=20
IOWeight=20
MemoryHigh=1100M
MemoryMax=1400M
MemorySwapMax=1G
TasksMax=256
# SIGTERM: running jobs get MARKDROP_DOCS_WORKER_GRACE_SECONDS (120) to finish, then go back to the queue.
TimeoutStopSec=150
KillMode=mixed

[Install]
WantedBy=multi-user.target
```

The box also needs Node 22, `frontend/node_modules` and `docs-platform/node_modules` installed
(`npm ci` in both), and ~2 GB of disk for the work folder. Restores and unpublishes don't need the
worker: the API runs them inline.

Local development: `MARKDROP_DOCS_BUILD_TARGETS=local`, then `python -m scripts.docs_build_worker`
(or `--once`) next to the API; `MARKDROP_DOCS_STORE_DIR=<folder>` publishes to a folder that
`node server/server.mjs serve --store <folder>` serves by hostname.
