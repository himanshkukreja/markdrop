#!/usr/bin/env node
/**
 * Run the Worker (edge/dist/worker.mjs) in Miniflare — the workerd runtime wrangler dev uses —
 * with an emulated R2 bucket filled from a local store, behind a counting proxy.
 *
 *   node test/miniflare.mjs --store <dir> [--port 3563]
 *
 * Every request the proxy forwards is one Worker invocation; GET /__stats on the proxy returns
 * the counts by kind (page, rsc, chunk, file, text, og, mcp, 404…) since the last GET /__reset.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (i % 2 ? a : [...a, [v.replace(/^--/, ""), arr[i + 1]]]), []));
const storeDir = path.resolve(args.store);
const port = Number(args.port || 3563);

const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    {
      name: "markdrop-docs-edge",
      modules: true,
      scriptPath: path.join(ROOT, "edge", "dist", "worker.mjs"),
      compatibilityDate: "2026-01-01",
      r2Buckets: ["DOCS"],
      bindings: { POINTER_TTL_MS: "1000" },
    },
  ],
}));
await mf.ready;
const bucket = await mf.getR2Bucket("DOCS");

// Sync the store into the emulated bucket (objects that are already there are skipped).
let synced = 0;
const t0 = Date.now();
const walk = (dir, rel = "") => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else if (!e.name.endsWith(".tmp")) files.push(r);
  }
};
const files = [];
walk(storeDir);
const queue = [...files];
await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (;;) {
      const key = queue.shift();
      if (!key) return;
      if (key.startsWith("objects/") && (await bucket.head(key))) continue;
      await bucket.put(key, fs.readFileSync(path.join(storeDir, key)));
      synced++;
    }
  }),
);
console.error(`[miniflare] synced ${synced}/${files.length} keys in ${Date.now() - t0} ms`);

let stats = {};
const kindOf = (pathname, headers, status) => {
  if (pathname.startsWith("/_next/static/")) return "chunk";
  if (headers.rsc === "1") return headers["next-router-prefetch"] === "1" ? "rsc-prefetch" : "rsc";
  if (status === 404) return "404";
  if (pathname === "/mcp") return "mcp";
  if (pathname.startsWith("/docs-assets/")) return "file";
  if (pathname.startsWith("/og/")) return "og";
  if (/\.(json|txt|md|xml|rss)$/.test(pathname)) return "text";
  return "page";
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(stats));
  }
  if (url.pathname === "/__reset") {
    stats = {};
    res.writeHead(204);
    return res.end();
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  const response = await mf.dispatchFetch(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    redirect: "manual",
  });
  const kind = kindOf(url.pathname, req.headers, response.status);
  stats[kind] = (stats[kind] || 0) + 1;
  stats.total = (stats.total || 0) + 1;
  if (kind === "404" || kind === "text") (stats[`${kind}Paths`] ||= []).push(url.pathname);
  const out = {};
  response.headers.forEach((v, k) => (out[k] = v));
  res.writeHead(response.status, out);
  if (response.body && req.method !== "HEAD") res.end(Buffer.from(await response.arrayBuffer()));
  else res.end();
});
server.listen(port, () => console.error(`[miniflare] Worker on http://localhost:${port} (stats: /__stats, reset: /__reset)`));

const stop = async () => {
  server.close();
  await mf.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
