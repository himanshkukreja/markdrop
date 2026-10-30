/**
 * build <content-dir> --out <dist>: a docs content folder → static, content-addressed output.
 *
 *   dist/manifest.json      what the edge serves: route → object, files, redirects, 404, MCP data
 *   dist/objects/<sha256>   every body, named by its hash (immutable: cached forever, uploaded once)
 *
 * Steps: stage the engine (stage.mjs) → `next build` with DOCS_CONTENT_DIR → `next start` + crawl
 * (crawl.mjs) → hash everything into objects/ → manifest. A build whose inputs (engine version +
 * content + assets) match the manifest already in --out is skipped: a no-change publish costs a
 * hash of the folder, not a render.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { stage, engineVersion } from "./stage.mjs";
import { crawl, startServer } from "./crawl.mjs";
import { mimeOf } from "./mime.mjs";

export const FORMAT = "markdrop-docs/1";

/** Content-folder entries that are never pages, data or MCP input. */
const SKIP = new Set(["public", "video-scenes", "node_modules"]);
/** Files the backend reads (Ask AI prompt) that must not ship to readers. */
const PRIVATE = new Set(["ai.json"]);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function walkFiles(dir, rel = "", out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    const p = path.join(dir, e.name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkFiles(p, r, out);
    else if (st.isFile()) out.push({ rel: r, abs: p, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/**
 * The text the engine reads from a content folder (site.json, pages, changelog, OpenAPI, media
 * manifests) plus the video chapter files it reads from public/: the MCP server's input, and the
 * build's change key. Paths are virtual: /site/<rel> and /public/<rel>.
 */
export function contentSnapshot(contentDir, assets) {
  const files = {};
  for (const f of walkFiles(contentDir)) {
    const top = f.rel.split("/")[0];
    if (SKIP.has(top) || PRIVATE.has(f.rel) || top.startsWith("_")) continue;
    if (!/\.(md|json|ya?ml)$/i.test(f.rel)) continue;
    files[`/site/${f.rel}`] = fs.readFileSync(f.abs, "utf8");
  }
  for (const a of assets) {
    for (const f of walkFiles(a.dir)) {
      if (!f.rel.endsWith(".vtt")) continue;
      files[`/public${a.prefix === "/" ? "" : a.prefix}/${f.rel}`] = fs.readFileSync(f.abs, "utf8");
    }
  }
  return files;
}

/** Hash of every asset file (path, size, mtime: content hashing 80 MB of video per publish is waste). */
function assetsKey(assets) {
  const h = crypto.createHash("sha256");
  for (const a of assets) for (const f of walkFiles(a.dir).sort((x, y) => (x.rel < y.rel ? -1 : 1))) h.update(`${a.prefix}|${f.rel}|${f.size}|${f.mtimeMs}\n`);
  return h.digest("hex");
}

function run(cmd, args, { cwd, env, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      if (log) fs.writeFileSync(log, out);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} failed (${code}):\n${out.slice(-4000)}`));
    });
  });
}

/** The site's redirects.json ({status, redirects:[{from,to,same?}]}) as edge rules. */
function readRedirects(contentDir) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(contentDir, "redirects.json"), "utf8"));
  } catch {
    return [];
  }
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.redirects) ? doc.redirects : [];
  const status = [301, 302, 307, 308].includes(doc?.status) ? doc.status : 308;
  const out = [];
  for (const r of list) {
    if (!r || typeof r.from !== "string" || typeof r.to !== "string" || r.same || r.from === r.to) continue;
    out.push({ from: r.from, to: r.to, status: [301, 302, 307, 308].includes(r.status) ? r.status : status });
  }
  return out;
}

class ObjectWriter {
  constructor(dir) {
    this.dir = dir;
    this.written = 0;
    this.reused = 0;
    this.bytes = 0;
    this.hashes = new Set();
    fs.mkdirSync(dir, { recursive: true });
  }
  put(body) {
    const hash = sha256(body);
    this.hashes.add(hash);
    const file = path.join(this.dir, hash);
    if (fs.existsSync(file)) this.reused++;
    else {
      fs.writeFileSync(file, body);
      this.written++;
    }
    this.bytes += body.length;
    return hash;
  }
  /** Large files are hashed by streaming-free read (fine for docs assets; videos are read once). */
  putFile(abs) {
    return this.put(fs.readFileSync(abs));
  }
}

/** Drop the headers every object of a kind shares (the edge sets those). */
function slimHeaders(h, type) {
  const out = { ...h };
  delete out["content-type"];
  if (out["cache-control"] === "s-maxage=31536000") delete out["cache-control"];
  if (type.startsWith("text/html") || type.startsWith("text/x-component")) {
    delete out["x-nextjs-prerender"];
    delete out["x-nextjs-stale-time"];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Build one site. Options: contentDir, outDir, engineDir (the frontend), workDir (stage + cache,
 * reused between builds), assets ([{dir, prefix}], default <content>/public at /), port, force.
 */
export async function build(opts) {
  const t0 = Date.now();
  const contentDir = path.resolve(opts.contentDir);
  const outDir = path.resolve(opts.outDir);
  const engineDir = path.resolve(opts.engineDir);
  const workDir = path.resolve(opts.workDir);
  const assets = (opts.assets?.length ? opts.assets : [{ dir: path.join(contentDir, "public"), prefix: "/" }])
    .map((a) => ({ dir: path.resolve(a.dir), prefix: a.prefix }))
    .filter((a) => fs.existsSync(a.dir));
  const log = opts.log || (() => {});
  const timings = {};
  const mark = (k, since) => (timings[k] = Date.now() - since);

  const engine = engineVersion(engineDir);
  const snapshot = contentSnapshot(contentDir, assets);
  const snapshotJson = JSON.stringify({ format: FORMAT, files: snapshot });
  const inputs = sha256(`${engine}\n${sha256(snapshotJson)}\n${assetsKey(assets)}`);
  mark("hashInputs", t0);

  const manifestFile = path.join(outDir, "manifest.json");
  if (!opts.force && fs.existsSync(manifestFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (prev.inputs === inputs) {
        log(`no change (inputs ${inputs.slice(0, 12)}): kept ${manifestFile}`);
        return { skipped: true, manifest: prev, timings: { ...timings, total: Date.now() - t0 } };
      }
    } catch {
      /* rebuild */
    }
  }

  // 1. Stage the engine.
  let t = Date.now();
  const stageDir = path.join(workDir, "stage");
  const changed = stage({ engineDir, stageDir, assets });
  mark("stage", t);
  log(`stage: ${changed} engine files changed, engine ${engine}`);

  // 2. next build.
  t = Date.now();
  const env = { DOCS_CONTENT_DIR: contentDir, MARKDROP_DOCS_BUILD_ID: engine, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" };
  await run(path.join(stageDir, "node_modules", ".bin", "next"), ["build"], { cwd: stageDir, env, log: path.join(workDir, "next-build.log") });
  mark("nextBuild", t);
  log(`next build: ${timings.nextBuild} ms`);

  // 3. Crawl.
  t = Date.now();
  const objects = new ObjectWriter(path.join(outDir, "objects"));
  const routes = {};
  const files = {};
  let notFound = null;
  const addFile = (p, body, type, extra) => {
    files[p] = { o: objects.put(body), t: type, s: body.length, ...(extra ? { h: extra } : {}) };
  };
  // Site files first, so the crawl doesn't fetch them again.
  for (const a of assets) {
    for (const f of walkFiles(a.dir)) {
      const p = `${a.prefix === "/" ? "" : a.prefix}/${f.rel}`;
      files[p] = { o: objects.putFile(f.abs), t: mimeOf(f.rel), s: f.size };
    }
  }
  // Framework chunks (content-hashed by Next, the same for every site built by this engine).
  const staticDir = path.join(stageDir, ".next", "static");
  for (const f of walkFiles(staticDir)) {
    files[`/_next/static/${f.rel}`] = { o: objects.putFile(f.abs), t: mimeOf(f.rel), s: f.size, immutable: true };
  }
  const port = opts.port || 3591;
  const server = await startServer({ stageDir, port, env });
  let stats;
  try {
    stats = await crawl({
      stageDir,
      port,
      haveFile: (p) => !!files[p],
      onRoute: (r) => {
        const type = r.headers["content-type"] || "application/octet-stream";
        const entry = { o: objects.put(r.body), t: type, s: r.body.length };
        const h = slimHeaders(r.headers, type);
        if (h) entry.h = h;
        if (r.rsc) {
          entry.rsc = { o: objects.put(r.rsc.body), s: r.rsc.body.length };
          const rh = slimHeaders(r.rsc.headers, "text/x-component");
          if (rh) entry.rsc.h = rh;
        }
        if (r.prefetch) entry.prefetch = { o: objects.put(r.prefetch.body), s: r.prefetch.body.length };
        if (r.status === 404) notFound = entry;
        else routes[r.internal] = entry;
      },
      onFile: (f) => addFile(f.path, f.body, f.headers["content-type"] || mimeOf(f.path), slimHeaders(f.headers, f.headers["content-type"] || "")),
    });
  } finally {
    await server.stop();
  }
  mark("crawl", t);

  // 4. MCP input (never served as a file: only the edge's /mcp reads it).
  const mcp = { o: objects.put(Buffer.from(snapshotJson)), s: snapshotJson.length };

  let site = {};
  try {
    site = JSON.parse(snapshot["/site/site.json"] || "{}");
  } catch {
    /* defaults */
  }
  const manifest = {
    format: FORMAT,
    site: { id: site.id || "default", name: site.name || "Docs", url: (site.url || "").replace(/\/+$/, "") },
    engine,
    inputs,
    builtAt: new Date().toISOString(),
    routes,
    notFound,
    files,
    redirects: readRedirects(contentDir),
    mcp,
  };
  const manifestJson = JSON.stringify(manifest);
  fs.writeFileSync(manifestFile, manifestJson);
  timings.total = Date.now() - t0;

  // Objects a previous build left behind (not referenced any more) are pruned from dist.
  let pruned = 0;
  for (const name of fs.readdirSync(objects.dir)) {
    if (!objects.hashes.has(name)) {
      fs.rmSync(path.join(objects.dir, name));
      pruned++;
    }
  }
  return {
    skipped: false,
    manifest,
    timings,
    stats: {
      ...stats,
      routes: Object.keys(routes).length,
      files: Object.keys(files).length,
      objects: objects.hashes.size,
      objectsWritten: objects.written,
      objectsPruned: pruned,
      manifestBytes: manifestJson.length,
    },
  };
}
