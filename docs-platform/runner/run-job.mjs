#!/usr/bin/env node
/**
 * Run one Markdrop Docs job (a build or a GitBook import) and report back.
 *
 *   From the API (GitHub Actions, or any machine with the engine checked out):
 *     node runner/run-job.mjs --job <id> --api <https://api.markdrop.in> --token <job token> [--runner <id>]
 *
 *   From a file (the Python worker, backend/scripts/docs_build_worker.py):
 *     node runner/run-job.mjs --spec <spec.json> --result <result.json>
 *     (progress: one "@@progress {json}" line per step on stdout)
 *
 * Env: MARKDROP_DOCS_R2_BUCKET + CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (or
 * MARKDROP_DOCS_STORE_DIR for a folder store); optional MARKDROP_DOCS_ENGINE_DIR (default
 * ../frontend), MARKDROP_DOCS_WORK_DIR (stage + Next cache, reuse it between jobs),
 * MARKDROP_DOCS_ASSET_CACHE, MARKDROP_DOCS_BUILD_PORT, MARKDROP_DOCS_ENGINE_ASSETS_DIR,
 * MARKDROP_DOCS_IMPORT_CACHE_DIR, MARKDROP_DOCS_KEEP_GIFS, MARKDROP_DOCS_JOB_STARTED_AT (epoch
 * seconds when the Actions job started: the minutes it bills). The job token may also come from
 * MARKDROP_DOCS_JOB_TOKEN instead of --token (keeps it out of the process list).
 *
 * Exit codes: 0 = reported (success or a failure the API now knows about), 3 = the job isn't ours
 * to run (taken, finished, or another build of the site is running), 1 = couldn't report.
 * Logs are counts and timings; page content is never printed.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { configFromEnv, runBuild, runImport, storeFromEnv } from "./lib.mjs";

function parse(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    opt[a.slice(2)] = v;
  }
  return opt;
}

const log = (m) => console.error(`[run-job] ${m}`);

/** The API's job token (services/docs_jobs.job_token): `<expiry>.<base64url HMAC-SHA256("docs-job:<id>:<expiry>")>`. */
export function mintToken(jobId, secret, ttlSeconds = 3 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto.createHmac("sha256", secret).update(`docs-job:${jobId}:${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The API transport: GET the spec, POST progress (throttled, also a heartbeat), POST the result. */
function apiTransport({ api, job, token, runner }) {
  const base = `${api.replace(/\/+$/, "")}/api/v1/internal/docs-jobs/${encodeURIComponent(job)}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "markdrop-docs-runner/1" };
  const call = async (method, url, body, tries = 4) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
        if (r.status >= 500 || r.status === 429) throw Object.assign(new Error(`HTTP ${r.status}`), { retry: true });
        return r;
      } catch (e) {
        last = e;
        if (e.retry === false) throw e;
        await sleep(1000 * 2 ** i);
      }
    }
    throw last;
  };
  let lastProgress = null;
  let lastSent = 0;
  let pending = null;
  const send = async (p) => {
    lastSent = Date.now();
    try {
      const r = await call("POST", `${base}/progress`, { runner, ...p }, 2);
      if (r.status === 409 || r.status === 410) log(`progress refused (${r.status}): the job was taken over or finished`);
    } catch (e) {
      log(`progress not sent: ${e.message}`);
    }
  };
  const heartbeat = setInterval(() => lastProgress && Date.now() - lastSent > 25_000 && send(lastProgress), 5_000);
  heartbeat.unref();
  return {
    async spec() {
      const r = await call("GET", `${base}?runner=${encodeURIComponent(runner)}`);
      if (r.status === 409 || r.status === 410 || r.status === 404) {
        const body = await r.text();
        return { skip: `${r.status} ${body.slice(0, 200)}` };
      }
      if (!r.ok) throw new Error(`GET job: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return { spec: await r.json() };
    },
    progress(p) {
      lastProgress = p;
      // At most one progress call every 2 s (the last one wins); steps that change always go out.
      if (Date.now() - lastSent > 2000 || p.step === "done") {
        pending = send(p);
      }
    },
    async result(kind, body) {
      clearInterval(heartbeat);
      await pending;
      const r = await call("POST", `${base}/${kind === "import" && body.ok ? "import-result" : "result"}`, { runner, ...body });
      if (!r.ok) throw new Error(`result: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    },
  };
}

/** The file transport (the Python worker): spec from a file, progress on stdout, result to a file. */
function fileTransport({ spec, result }) {
  return {
    async spec() {
      return { spec: JSON.parse(fs.readFileSync(spec, "utf8")) };
    },
    progress(p) {
      process.stdout.write(`@@progress ${JSON.stringify(p)}\n`);
    },
    async result(_kind, body) {
      const tmp = `${result}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body));
      fs.renameSync(tmp, result);
    },
  };
}

async function main() {
  const opt = parse(process.argv.slice(2));
  const runner = opt.runner || (process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}` : `local-${process.pid}`);
  let transport;
  if (opt.spec) {
    if (!opt.result) throw new Error("--spec needs --result");
    transport = fileTransport(opt);
  } else {
    // The token from the dispatch, or one minted here from the shared secret (a builder repo that
    // holds MARKDROP_DOCS_JOB_SECRET never needs the token in its run inputs).
    const token = opt.token || process.env.MARKDROP_DOCS_JOB_TOKEN || (opt.job && process.env.MARKDROP_DOCS_JOB_SECRET ? mintToken(opt.job, process.env.MARKDROP_DOCS_JOB_SECRET) : "");
    delete process.env.MARKDROP_DOCS_JOB_SECRET;
    if (!opt.job || !opt.api || !token) throw new Error("usage: run-job.mjs --job <id> --api <base> --token <token>  |  --spec <file> --result <file>");
    if (!/^https:\/\//.test(opt.api) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(opt.api.replace(/\/+$/, ""))) throw new Error("--api must be https (or a local http address)");
    transport = apiTransport({ api: opt.api, job: opt.job, token, runner });
  }
  const startedAt = Number(process.env.MARKDROP_DOCS_JOB_STARTED_AT || 0) * 1000 || Date.now();
  const cfg = configFromEnv();
  const store = storeFromEnv(); // also drops the keys from the env children inherit

  const got = await transport.spec();
  if (got.skip) {
    log(`not running job ${opt.job}: ${got.skip}`);
    process.exit(3);
  }
  const spec = got.spec;
  const kind = spec.job?.kind;
  log(`job ${spec.job?.id} (${kind}) for site ${spec.bundle?.site_id || spec.import?.site_id}`);
  const t0 = Date.now();
  let body;
  try {
    if (kind === "build") {
      const res = await runBuild(spec, { store, cfg, progress: (p) => transport.progress(p), log });
      log(`built and published: ${res.stats.pages} pages, ${res.stats.uploaded} of ${res.stats.objects} objects uploaded (${(res.stats.bytes / 1e6).toFixed(1)} MB) in ${res.stats.ms} ms`);
      body = { ok: true, ...res };
    } else if (kind === "import") {
      const res = await runImport(spec, { store, cfg, progress: (p) => transport.progress(p), log });
      body = { ok: true, import: res };
    } else throw new Error(`unknown job kind ${kind}`);
  } catch (e) {
    log(`failed: ${e.message}`);
    body = { ok: false, error: String(e.message || e).slice(0, 2000) };
  }
  body.runner_ms = Date.now() - startedAt;
  body.job_ms = Date.now() - t0;
  await transport.result(kind, body);
  log(`reported (${body.ok ? "ok" : "failed"}) after ${body.job_ms} ms`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
