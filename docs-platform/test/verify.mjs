#!/usr/bin/env node
/**
 * Compare the edge (Worker in Miniflare, or the self-host server) with `next start` for one site:
 * every route of the manifest as HTML, as the RSC payload, as Markdown (`.md` and
 * `Accept: text/markdown`), plus 404s, trailing slashes, chunks, site files and a Range read.
 *
 *   node test/verify.mjs --manifest <dist>/manifest.json --next 3561 --edge 3562 --edge-host <host>
 *
 * Bodies must be byte-identical (both serve the same build); headers are compared on the ones that
 * matter to clients (status, content-type).
 */
import http from "node:http";
import fs from "node:fs";
import { publicPath } from "../builder/crawl.mjs";

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  return o;
}

function get(port, host, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: encodeURI(p), headers: { host, "accept-encoding": "identity", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const o = opts(process.argv.slice(2));
const m = JSON.parse(fs.readFileSync(o.manifest, "utf8"));
const nextHost = `docs.localhost:${o.next}`;
const edgeHost = o["edge-host"];
const results = { compared: 0, same: 0, diffs: [] };

async function compare(label, p, headers = {}, { body = true } = {}) {
  const [a, b] = await Promise.all([get(o.next, nextHost, p, headers), get(o.edge, edgeHost, p, headers)]);
  results.compared++;
  const ta = String(a.headers["content-type"] || "").split(";")[0];
  const tb = String(b.headers["content-type"] || "").split(";")[0];
  const problems = [];
  if (a.status !== b.status) problems.push(`status ${a.status} vs ${b.status}`);
  if (ta !== tb) problems.push(`type ${ta} vs ${tb}`);
  if (body && !a.body.equals(b.body)) problems.push(`body ${a.body.length} vs ${b.body.length} bytes`);
  if (problems.length) results.diffs.push(`${label} ${p}: ${problems.join(", ")}`);
  else results.same++;
}

const routes = Object.entries(m.routes);
const queue = [];
for (const [internal, r] of routes) {
  const p = publicPath(internal);
  queue.push(() => compare("route", p));
  if (r.rsc) {
    queue.push(() => compare("rsc", p, { rsc: "1" }));
    queue.push(() => compare("prefetch", p, { rsc: "1", "next-router-prefetch": "1" }));
    queue.push(() => compare("accept-md", p, { accept: "text/markdown" }));
    if (p !== "/") queue.push(() => compare("slash", `${p}/`));
  }
}
queue.push(() => compare("404", "/no/such/page"));
queue.push(() => compare("404-md", "/no/such/page.md"));
queue.push(() => compare("404-asset", "/docs-assets/missing.png"));
const chunk = Object.keys(m.files).find((f) => f.startsWith("/_next/static/chunks/"));
queue.push(() => compare("chunk", chunk));

const workers = Array.from({ length: 8 }, async () => {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    await job();
  }
});
await Promise.all(workers);

// Edge-only checks: site files (Next's stage only links them for rendering), Range, redirects, ETag.
const extra = [];
const file = Object.entries(m.files).find(([p, f]) => !p.startsWith("/_next/") && f.s > 4096);
if (file) {
  const [p, f] = file;
  const whole = await get(o.edge, edgeHost, p);
  extra.push(`file ${p}: ${whole.status} ${whole.body.length}/${f.s} bytes ${whole.headers["content-type"]}`);
  const part = await get(o.edge, edgeHost, p, { range: "bytes=100-199" });
  extra.push(`range: ${part.status} ${part.headers["content-range"]} ${part.body.length} bytes, matches=${part.body.equals(whole.body.subarray(100, 200))}`);
}
const page = routes.find(([, r]) => r.rsc);
if (page) {
  const p = publicPath(page[0]);
  const first = await get(o.edge, edgeHost, p);
  const again = await get(o.edge, edgeHost, p, { "if-none-match": first.headers.etag });
  extra.push(`etag revalidation ${p}: ${again.status}`);
}
const red = m.redirects.find((r) => !m.routes[`/docs-site${r.from}`]);
if (red) {
  const r = await get(o.edge, edgeHost, red.from);
  extra.push(`redirect ${red.from}: ${r.status} → ${r.headers.location}`);
}
const mcp = await new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } } });
  const req = http.request({ host: "127.0.0.1", port: o.edge, path: "/mcp", method: "POST", headers: { host: edgeHost, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => {
    let t = "";
    res.on("data", (c) => (t += c));
    res.on("end", () => resolve(`${res.statusCode} ${t.slice(0, 160)}`));
  });
  req.on("error", reject);
  req.end(body);
});
extra.push(`mcp initialize: ${mcp}`);

console.log(JSON.stringify({ site: m.site.id, ...results, diffs: results.diffs.slice(0, 30), diffCount: results.diffs.length, extra }, null, 2));
