/**
 * The job runner's steps, shared by both ways a job runs:
 *
 *   - GitHub Actions (run-job.mjs --job … --api … --token …): the spec comes from the API, progress
 *     and the result go back to it.
 *   - The Python worker (backend/scripts/docs_build_worker.py → run-job.mjs --spec f --result f):
 *     the spec is a file the worker wrote, progress goes to stdout, the result to a file.
 *
 * The spec is built by the backend (services/docs_snapshot.py): the content folder as a map of
 * files (site.json, pages with frontmatter, redirects.json), the site id and its hostnames. A site's
 * own files (images, clips, downloads) live in the docs R2 bucket under sites/<site>/assets/<rel>
 * and are served at /docs-assets/<rel> (an upload: <sha256>.<ext>; an import: import/<page>/<name>);
 * the runner fetches the ones the content refers to into <content>/public/docs-assets/<rel>.
 *
 * Nothing here prints page content: logs carry counts, sizes and timings only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "../builder/build.mjs";
import { FsStore, S3Store, publish } from "../builder/store.mjs";
import { writeMediaManifest } from "../builder/media.mjs";
import { mimeOf } from "../builder/mime.mjs";

/** The importer's asset folder name (its --id): files land at /docs-assets/import/<page>/<name>. */
export const IMPORT_ASSET_ID = "import";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");

/* ── configuration (env only) ──────────────────────────────────────────── */

export function configFromEnv(env = process.env) {
  const workDir = path.resolve(env.MARKDROP_DOCS_WORK_DIR || path.join(env.RUNNER_TEMP || os.tmpdir(), "markdrop-docs-work"));
  return {
    engineDir: path.resolve(env.MARKDROP_DOCS_ENGINE_DIR || path.join(REPO, "frontend")),
    workDir,
    assetCache: path.resolve(env.MARKDROP_DOCS_ASSET_CACHE || path.join(workDir, "asset-cache")),
    port: Number(env.MARKDROP_DOCS_BUILD_PORT || 3591),
    engineAssetsDir: env.MARKDROP_DOCS_ENGINE_ASSETS_DIR ? path.resolve(env.MARKDROP_DOCS_ENGINE_ASSETS_DIR) : undefined,
    importCache: env.MARKDROP_DOCS_IMPORT_CACHE_DIR ? path.resolve(env.MARKDROP_DOCS_IMPORT_CACHE_DIR) : undefined,
    keepGifs: env.MARKDROP_DOCS_KEEP_GIFS === "1" || env.MARKDROP_DOCS_KEEP_GIFS === "true",
    bucket: env.MARKDROP_DOCS_R2_BUCKET || "",
    storeDir: env.MARKDROP_DOCS_STORE_DIR || "",
  };
}

/**
 * The store a site publishes to: a folder (MARKDROP_DOCS_STORE_DIR, tests and self-host) or the docs
 * R2 bucket over S3 (MARKDROP_DOCS_R2_BUCKET + CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).
 * The keys are read once and then removed from this process's env, so nothing the runner starts
 * (next build, the importer) inherits them.
 */
export function storeFromEnv(env = process.env) {
  const cfg = configFromEnv(env);
  let store;
  if (cfg.storeDir) store = new FsStore(cfg.storeDir);
  else {
    if (!cfg.bucket) throw new Error("set MARKDROP_DOCS_R2_BUCKET (and CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY), or MARKDROP_DOCS_STORE_DIR");
    store = new S3Store({ accountId: env.CF_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: cfg.bucket });
  }
  for (const k of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CF_API_TOKEN", "CLOUDFLARE_API_TOKEN", "MARKDROP_DOCS_JOB_TOKEN"]) delete env[k];
  return store;
}

/* ── the content folder ────────────────────────────────────────────────── */

/** A relative path inside the content folder: no absolute paths, `..`, hidden or empty segments. */
export function safeRel(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 512 || rel.includes("\0") || rel.includes("\\")) return null;
  const parts = rel.split("/");
  for (const p of parts) if (!p || p === "." || p === ".." || p.startsWith(".")) return null;
  return parts.join("/");
}

/** Write the spec's files into `dir` (emptied first). Returns the number of files. */
export function writeContent(files, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const [rel, text] of Object.entries(files || {})) {
    const r = safeRel(rel);
    if (!r || r.split("/")[0] === "public") throw new Error(`bad content path ${JSON.stringify(rel)}`);
    const f = path.join(dir, ...r.split("/"));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(text));
    n++;
  }
  return n;
}

/** `x.dark.webp` → `x.webp`, `clip.dark` → `clip` (the light file a dark variant goes with). */
const lightOf = (u) => u.replace(/\.dark(\.[a-z0-9]+)?$/i, "$1");
/** `clip.mp4` → `clip` (a clip is referenced by its base: `::clip{src="…/clip"}`). */
const baseOf = (u) => u.replace(/\.[a-z0-9]+$/i, "");

/**
 * The site's files the content refers to: an object is kept when its address, or the light file
 * or clip base it belongs to, appears in the text (pages + site.json). Files nothing refers to
 * (an image removed from every page) are left out of the build.
 */
export function referencedAssets(objects, siteId, text) {
  const prefix = `sites/${siteId}/assets/`;
  const urlBase = "/docs-assets/";
  return objects.filter((o) => {
    if (!o.key.startsWith(prefix)) return false;
    const rel = safeRel(o.key.slice(prefix.length));
    if (!rel) return false;
    const url = urlBase + rel;
    const light = lightOf(url);
    return [url, light, baseOf(url), baseOf(light)].some((c) => text.includes(c));
  });
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (;;) {
      const it = queue.shift();
      if (it === undefined) return;
      await fn(it);
    }
  }));
}

/**
 * Fetch the referenced files into `<content>/public/docs-assets/<rel>`. A local cache
 * (keyed by key + ETag) means a warm build machine downloads only what changed; files are
 * hard-linked from it (copied across filesystems), so their mtime, part of the build's change
 * key, stays stable between builds.
 */
export async function fetchAssets({ store, siteId, contentDir, text, cacheDir, progress = () => {}, concurrency = 8 }) {
  const t = Date.now();
  const all = await store.listObjects(`sites/${siteId}/assets/`);
  const wanted = referencedAssets(all, siteId, text);
  fs.mkdirSync(cacheDir, { recursive: true });
  let fetched = 0;
  let bytes = 0;
  let done = 0;
  await pool(wanted, concurrency, async (o) => {
    const rel = safeRel(o.key.slice(`sites/${siteId}/assets/`.length));
    const cached = path.join(cacheDir, crypto.createHash("sha256").update(`${o.key}\n${o.etag}\n${o.size}`).digest("hex"));
    if (!fs.existsSync(cached)) {
      const body = await store.getBytes(o.key);
      if (!body) throw new Error(`asset ${o.key} vanished from the store`);
      const tmp = `${cached}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, cached);
      fetched++;
    }
    const out = path.join(contentDir, "public", "docs-assets", ...rel.split("/"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    try {
      fs.linkSync(cached, out);
    } catch {
      fs.copyFileSync(cached, out);
    }
    bytes += o.size;
    done++;
    if (done % 25 === 0 || done === wanted.length) progress({ step: "assets", done, total: wanted.length, message: `${done} of ${wanted.length} files` });
  });
  return { listed: all.length, used: wanted.length, fetched, bytes, ms: Date.now() - t };
}

/* ── build ─────────────────────────────────────────────────────────────── */

/**
 * spec: { job, build, bundle: { site_id, files }, publish: { site, hosts } }.
 * Writes the content folder, fetches the site's files, writes media.json, builds, publishes, and
 * returns { manifest_hash, unchanged, stats, timings }. One build at a time per work folder.
 */
export async function runBuild(spec, { store, cfg, progress = () => {}, log = () => {} }) {
  const t0 = Date.now();
  const siteId = spec.bundle?.site_id;
  if (!siteId || !/^[A-Za-z0-9_-]{1,64}$/.test(siteId)) throw new Error("spec.bundle.site_id is missing or invalid");
  const jobDir = path.join(cfg.workDir, "jobs", String(spec.job?.id || "local"));
  const contentDir = path.join(jobDir, "content");
  const outDir = path.join(jobDir, "dist");
  const timings = {};
  try {
    progress({ step: "prepare", done: 0, total: 4, message: "Writing pages" });
    const files = writeContent(spec.bundle.files, contentDir);
    const text = Object.values(spec.bundle.files).join("\n");
    progress({ step: "assets", done: 0, total: 0, message: "Fetching images and files" });
    const assets = await fetchAssets({ store, siteId, contentDir, text, cacheDir: cfg.assetCache, progress });
    timings.assets = assets.ms;
    const media = await writeMediaManifest(contentDir, { engineDir: cfg.engineDir });
    log(`content: ${files} files, ${assets.used} of ${assets.listed} site files (${assets.fetched} downloaded, ${(assets.bytes / 1e6).toFixed(1)} MB)`);

    progress({ step: "build", done: 1, total: 4, message: "Rendering pages" });
    const res = await build({
      contentDir,
      outDir,
      engineDir: cfg.engineDir,
      workDir: path.join(cfg.workDir, "engine"),
      port: cfg.port,
      engineAssetsDir: cfg.engineAssetsDir,
      log,
    });
    Object.assign(timings, res.timings);
    const pages = Object.values(res.manifest.routes).filter((r) => String(r.t).startsWith("text/html")).length;

    progress({ step: "publish", done: 2, total: 4, message: `Uploading (${pages} pages)` });
    const tp = Date.now();
    const pub = await publish({ distDir: outDir, store, site: spec.publish?.site || siteId, hosts: spec.publish?.hosts || [] });
    timings.publish = Date.now() - tp;
    progress({ step: "done", done: 4, total: 4, message: "Live" });
    let totalBytes = 0;
    for (const r of Object.values(res.manifest.routes)) totalBytes += (r.s || 0) + (r.rsc?.s || 0);
    for (const f of Object.values(res.manifest.files)) totalBytes += f.s || 0;
    return {
      manifest_hash: pub.manifest,
      unchanged: !!pub.unchanged,
      engine: res.manifest.engine,
      stats: {
        pages,
        routes: Object.keys(res.manifest.routes).length,
        objects: pub.objects ?? 0,
        uploaded: pub.uploaded ?? 0,
        bytes: pub.uploadedBytes ?? 0,
        total_bytes: totalBytes,
        assets: assets.used,
        media_files: media.files ?? 0,
        ms: Date.now() - t0,
      },
      timings,
    };
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

/* ── import ────────────────────────────────────────────────────────────── */

function runNode(args, { cwd, env, onLine, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (s) => (tail = (tail + s).slice(-4000));
    let buf = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      keep(s);
      buf += s;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine?.(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d) => keep(d.toString()));
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(tail);
      else reject(new Error(`exited with ${signal || code}: ${tail.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 600)}`));
    });
  });
}

const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const STANDARD_KEYS = new Set(["title", "description", "icon", "updated"]);

/** A page file → { title, description, icon, updated, frontmatter_extra, markdown (the body) }. */
export function readPageFile(src, parseYaml) {
  const m = FM.exec(src);
  if (!m) return { markdown: src, frontmatter_extra: {} };
  let data = {};
  try {
    data = parseYaml(m[1]) || {};
  } catch {
    data = {};
  }
  const extra = {};
  for (const [k, v] of Object.entries(data)) if (!STANDARD_KEYS.has(k) && v !== undefined && v !== null) extra[k] = v;
  const str = (v) => (v === undefined || v === null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  return {
    title: str(data.title),
    description: str(data.description),
    icon: data.icon ? String(data.icon) : null,
    updated: str(data.updated) || null,
    frontmatter_extra: extra,
    markdown: src.slice(m[0].length).replace(/^\s*\n/, ""),
  };
}

function walkMd(dir, rel = "", out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!rel && (e.name === "public" || e.name === "node_modules")) continue;
      walkMd(path.join(dir, e.name), r, out);
    } else if (e.name.endsWith(".md")) out.push(r);
  }
  return out;
}

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return fallback;
  }
};

/**
 * An imported content folder → what the API stores: site settings parts (description, home, tabs,
 * pages options, footer, brand), the nav by page path, every page (body + frontmatter fields),
 * redirects, videos, and the importer's report.
 */
export function readImportFolder(dir, { parseYaml }) {
  const site = readJson(path.join(dir, "site.json"), {});
  const navPaths = new Set((site.nav || []).flatMap((g) => g.pages || []));
  const pages = [];
  for (const rel of walkMd(dir).sort()) {
    const p = rel === "index.md" ? "/" : "/" + rel.replace(/\.md$/, "").replace(/\/index$/, "");
    const page = readPageFile(fs.readFileSync(path.join(dir, rel), "utf8"), parseYaml);
    pages.push({ path: p, ...page, hidden: p !== "/" && !navPaths.has(p) });
  }
  return {
    site: {
      name: site.name || null,
      description: site.description || null,
      eyebrow: site.eyebrow || null,
      headline: site.headline || null,
      home: site.home || null,
      tabs: site.tabs || [],
      pages: site.pages || null,
      footer: site.footer || null,
      embed_hosts: site.embedHosts || null,
      brand: site.brand || null,
    },
    nav: (site.nav || []).map((g) => ({ group: g.group, ...(g.icon ? { icon: g.icon } : {}), ...(g.tab ? { tab: g.tab } : {}), pages: g.pages || [] })),
    pages,
    redirects: readJson(path.join(dir, "redirects.json"), {}),
    videos: readJson(path.join(dir, "videos.json"), null),
    report: readJson(path.join(dir, "_import-report.json"), null),
  };
}

/**
 * Upload `<dir>/public/docs-assets/**` to sites/<site>/assets/** (skipping files the store has with
 * the same bytes). Returns counts plus one item per file (rel, size, sha256, content type) for the
 * API's asset rows.
 */
export async function uploadImportAssets({ store, siteId, dir, progress = () => {}, concurrency = 8 }) {
  const root = path.join(dir, "public", "docs-assets");
  const files = [];
  const walk = (d, rel = "") => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(root);
  const have = new Map((await store.listObjects(`sites/${siteId}/assets/`)).map((o) => [o.key, o]));
  let uploaded = 0;
  let uploadedBytes = 0;
  let bytes = 0;
  let done = 0;
  const items = [];
  await pool(files, concurrency, async (rel) => {
    const body = fs.readFileSync(path.join(root, ...rel.split("/")));
    const key = `sites/${siteId}/assets/${rel}`;
    bytes += body.length;
    const md5 = crypto.createHash("md5").update(body).digest("hex");
    items.push({ rel, size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex"), content_type: mimeOf(rel) });
    const cur = have.get(key);
    if (!cur || cur.size !== body.length || cur.etag !== md5) {
      await store.put(key, body);
      uploaded++;
      uploadedBytes += body.length;
    }
    done++;
    if (done % 25 === 0 || done === files.length) progress({ step: "upload", done, total: files.length, message: `${done} of ${files.length} files` });
  });
  items.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { files: files.length, bytes, uploaded, uploaded_bytes: uploadedBytes, items };
}

/**
 * spec: { job, import: { kind: "gitbook", url, site_id, keep_gifs? } }. Runs the GitBook importer
 * into a temp folder, uploads the site's files, and returns the folder read as data (the API
 * writes the pages, nav and brand; this process never touches the database).
 */
export async function runImport(spec, { store, cfg, progress = () => {}, log = () => {} }) {
  const t0 = Date.now();
  const imp = spec.import || {};
  const siteId = imp.site_id;
  if (!siteId || !/^[A-Za-z0-9_-]{1,64}$/.test(siteId)) throw new Error("spec.import.site_id is missing or invalid");
  if (imp.kind !== "gitbook") throw new Error(`unsupported import kind ${imp.kind}`);
  let url;
  try {
    url = new URL(imp.url);
  } catch {
    throw new Error("spec.import.url is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("the import URL must be http(s)");
  const jobDir = path.join(cfg.workDir, "jobs", String(spec.job?.id || "local"));
  const out = path.join(jobDir, "import");
  fs.rmSync(jobDir, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  try {
    progress({ step: "fetch", done: 0, total: 3, message: "Reading the GitBook site" });
    const args = [path.join(cfg.engineDir, "scripts", "docs-import", "gitbook.mjs"), url.href, "--out", out, "--id", IMPORT_ASSET_ID];
    if (cfg.importCache) args.push("--cache", path.join(cfg.importCache, url.hostname));
    if (cfg.keepGifs || imp.keep_gifs) args.push("--keep-gifs");
    let total = 0;
    const ti = Date.now();
    await runNode(args, {
      cwd: cfg.engineDir,
      env: { ...process.env, DEBUG: "" },
      timeoutMs: 20 * 60 * 1000,
      onLine: (line) => {
        const m = /^llms\.txt: (\d+) pages/.exec(line) || /^pages: (\d+)/.exec(line);
        if (m) {
          total = Number(m[1]);
          progress({ step: "fetch", done: 0, total: 3, message: `Converting ${total} pages` });
        } else if (/^done: /.test(line)) progress({ step: "convert", done: 1, total: 3, message: "Converted" });
      },
    });
    const importMs = Date.now() - ti;
    const require = createRequire(path.join(cfg.engineDir, "package.json"));
    const { parse: parseYaml } = require("yaml");
    const data = readImportFolder(out, { parseYaml });
    log(`import: ${data.pages.length} pages, ${data.nav.length} groups (${importMs} ms)`);
    progress({ step: "upload", done: 0, total: 0, message: "Uploading images and files" });
    const assets = await uploadImportAssets({ store, siteId, dir: out, progress });
    log(`import assets: ${assets.files} files, ${assets.uploaded} uploaded (${(assets.uploaded_bytes / 1e6).toFixed(1)} MB)`);
    progress({ step: "save", done: 2, total: 3, message: "Saving pages" });
    return { ...data, assets, timings: { import: importMs, total: Date.now() - t0 } };
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}
