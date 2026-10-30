#!/usr/bin/env node
/**
 * The REAL artifact Worker (worker/src/index.js), served by Node on http://127.0.0.1:8787 for the
 * docs media stack. Its ARTIFACTS binding is backed by the sandbox API's fake R2:
 *
 *   head(key) → GET {API}/__sandbox/head/<key>   (size, type, etag, public / ae / live metadata)
 *   get(key)  → GET {API}/__fakes3/<key>          (with a Range header for ranged gets)
 *
 * ARTIFACT_SIGNING_KEY must equal the API's MARKDROP_ARTIFACT_SIGNING_KEY (stack.sh reads it
 * from stack/.env). The Worker only allows CORS from markdrop.in and localhost:3000, so this
 * harness adds the local app origins on top — nothing else about a response is changed.
 *
 * Env: DOCS_MEDIA_API (default http://127.0.0.1:8180), DOCS_MEDIA_WORKER_PORT (default 8787),
 *      ARTIFACT_SIGNING_KEY.
 */
import http from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(here, "../../../../worker/src/index.js");
const { default: worker } = await import(pathToFileURL(workerPath).href);

const API = (process.env.DOCS_MEDIA_API || "http://127.0.0.1:8180").replace(/\/$/, "");
const PORT = Number(process.env.DOCS_MEDIA_WORKER_PORT || 8787);
const KEY = process.env.ARTIFACT_SIGNING_KEY;
if (!KEY) {
  console.error("worker_dev: ARTIFACT_SIGNING_KEY is required (the API's MARKDROP_ARTIFACT_SIGNING_KEY)");
  process.exit(1);
}
const LOCAL_ORIGINS = new Set([
  "http://localhost:3400",
  "http://127.0.0.1:3400",
  "http://docs.localhost:3400",
  "http://docs.acme.test:3400",
  "http://docs.acme.com:3400",
]);

const enc = (key) => key.split("/").map(encodeURIComponent).join("/");

function r2Object(meta) {
  const custom = {};
  if (meta.public) custom.public = "1";
  if (meta.ae != null) custom.ae = String(meta.ae);
  if (meta.live) custom.live = "1";
  return {
    key: meta.key,
    size: meta.size,
    etag: meta.etag,
    httpEtag: `"${meta.etag}"`,
    httpMetadata: { contentType: meta.content_type },
    customMetadata: custom,
    writeHttpMetadata(headers) {
      headers.set("content-type", meta.content_type);
    },
  };
}

const ARTIFACTS = {
  async head(key) {
    const res = await fetch(`${API}/__sandbox/head/${enc(key)}`);
    if (res.status !== 200) return null;
    return r2Object(await res.json());
  },
  async get(key, opts = {}) {
    const head = await this.head(key);
    if (!head) return null;
    const headers = {};
    if (opts.range && typeof opts.range.offset === "number") {
      const end = opts.range.length != null ? opts.range.offset + opts.range.length - 1 : "";
      headers.range = `bytes=${opts.range.offset}-${end}`;
    }
    const res = await fetch(`${API}/__fakes3/${enc(key)}`, { headers });
    if (!res.ok) return null;
    return { ...head, body: res.body };
  },
};

const env = { ARTIFACTS, ARTIFACT_SIGNING_KEY: KEY };

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://127.0.0.1:${PORT}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v != null) headers.set(k, v);
    }
    const request = new Request(url, { method: req.method, headers });
    const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
    const out = {};
    response.headers.forEach((v, k) => {
      out[k] = v;
    });
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGINS.has(origin) && !out["access-control-allow-origin"]) {
      out["access-control-allow-origin"] = origin;
      out["vary"] = "Origin";
    }
    res.writeHead(response.status, out);
    if (response.body && req.method !== "HEAD") Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (err) {
    console.error("worker_dev:", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("worker harness error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[docs-media] artifact Worker on http://127.0.0.1:${PORT} (R2 → ${API})`);
});
