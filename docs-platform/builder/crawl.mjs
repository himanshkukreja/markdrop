/**
 * Prerender by crawling: run the staged Next build with `next start` and fetch every docs route
 * through the docs host, exactly as a reader (or an agent, or the Next client router) would.
 *
 * The route list is the build's own prerender manifest (every /docs-site/… route Next generated:
 * pages, Markdown twins, OG cards, llms*.txt, feeds, the search index), so nothing depends on
 * guessing links. Each HTML route is fetched twice: as HTML and as its RSC payload (`RSC: 1`, what
 * the client router asks for on navigation). A missing address gives the 404 page. Same-origin
 * files the HTML points at outside /_next/static (the favicon, apple-icon) are fetched too.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const INTERNAL = "/docs-site";
const DOCS_HOST = "docs.localhost";

/** Response headers worth keeping (the rest are hop-by-hop, per-request or Next internals). */
const KEEP_HEADERS = new Set([
  "content-type",
  "link",
  "content-signal",
  "x-robots-tag",
  "access-control-allow-origin",
  "cache-control",
  "x-nextjs-stale-time",
  "x-nextjs-prerender",
  "x-nextjs-rewritten-path",
]);

/** The public address of an internal route (the inverse of docs/host.ts docsRewritePath). */
export function publicPath(internal) {
  if (internal === INTERNAL) return "/";
  const rest = internal.slice(INTERNAL.length);
  if (rest === "/md/index") return "/index.md";
  if (rest.startsWith("/md/")) return `${rest.slice(3)}.md`;
  return rest;
}

export function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: encodeURI(pathname), method: "GET", headers: { host: `${DOCS_HOST}:${port}`, "accept-encoding": "identity", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function keep(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!KEEP_HEADERS.has(k)) continue;
    out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

/** Start `next start` in the stage and resolve once it answers. */
export async function startServer({ stageDir, port, env }) {
  const bin = path.join(stageDir, "node_modules", ".bin", "next");
  // No -H: with `-H 127.0.0.1` Next's own origin differs from the URL the middleware builds
  // (localhost), so its docs rewrite becomes an external proxy that lands on the app host.
  const child = spawn(bin, ["start", "-p", String(port)], { cwd: stageDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited:\n${log}`);
    try {
      await get(port, "/robots.txt");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`next start did not answer:\n${log}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return {
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill("SIGTERM");
      }),
  };
}

/** Same-origin URLs an HTML page references outside /_next/static and the site's own files. */
function referencedFiles(html) {
  const out = new Set();
  const re = /(?:href|src|content)="(\/[^"#]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1].replace(/&amp;/g, "&");
    if (u.startsWith("//") || u.startsWith("/_next/")) continue;
    const p = u.split("?")[0];
    // Only things that look like files (an extension, or the framework's icon routes).
    if (/\.[a-z0-9]+$/i.test(p) || p === "/apple-icon" || p.startsWith("/apple-icon")) out.add(u);
  }
  return out;
}

/**
 * Crawl a running server. `onObject(kind, key, variant, res)` receives every response worth
 * keeping. Returns stats.
 */
export async function crawl({ stageDir, port, concurrency = 12, haveFile = () => false, onRoute, onFile }) {
  const pm = JSON.parse(fs.readFileSync(path.join(stageDir, ".next", "prerender-manifest.json"), "utf8"));
  const routes = Object.keys(pm.routes).filter((r) => r === INTERNAL || r.startsWith(`${INTERNAL}/`));
  const routePaths = new Set(routes.map(publicPath));
  const refs = new Set();
  let rscSameAsPrefetch = 0;
  let htmlRoutes = 0;
  const queue = [...routes];
  const work = async () => {
    for (;;) {
      const internal = queue.shift();
      if (!internal) return;
      const pub = publicPath(internal);
      const res = await get(port, pub);
      // A route the engine has no content for answers 404 (e.g. /changelog and its feeds on a site
      // with no changelog entries): left out, so the edge gives the 404 page (or a redirect) there.
      if (res.status === 404) continue;
      if (res.status !== 200) throw new Error(`${pub} (${internal}) answered ${res.status}`);
      const type = String(res.headers["content-type"] || "");
      const entry = { internal, public: pub, status: 200, headers: keep(res.headers), body: res.body };
      if (type.startsWith("text/html")) {
        htmlRoutes++;
        for (const u of referencedFiles(res.body.toString("utf8"))) refs.add(u);
        const rsc = await get(port, pub, { rsc: "1" });
        if (rsc.status !== 200 || !String(rsc.headers["content-type"]).startsWith("text/x-component")) throw new Error(`${pub}: RSC answered ${rsc.status}`);
        const pre = await get(port, pub, { rsc: "1", "next-router-prefetch": "1" });
        if (pre.body.equals(rsc.body)) rscSameAsPrefetch++;
        entry.rsc = { headers: keep(rsc.headers), body: rsc.body };
        if (!pre.body.equals(rsc.body)) entry.prefetch = { headers: keep(pre.headers), body: pre.body };
      }
      onRoute(entry);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));

  // The not-found page, as the docs host renders it for an address with no page.
  const nf = await get(port, "/__markdrop-docs-404-probe__");
  if (nf.status !== 404) throw new Error(`404 probe answered ${nf.status}`);
  onRoute({ internal: "404", public: null, status: 404, headers: keep(nf.headers), body: nf.body });
  for (const u of referencedFiles(nf.body.toString("utf8"))) refs.add(u);

  // Same-origin files the pages reference that are neither framework chunks nor site files.
  let files = 0;
  for (const u of refs) {
    const p = decodeURIComponent(u.split("?")[0]);
    if (haveFile(p) || routePaths.has(p)) continue;
    const res = await get(port, u);
    if (res.status !== 200) continue; // a broken reference stays broken; docs-check reports it
    onFile({ path: p, headers: keep(res.headers), body: res.body });
    files++;
  }
  return { routes: routes.length, htmlRoutes, rscSameAsPrefetch, extraFiles: files };
}
