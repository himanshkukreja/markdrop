#!/usr/bin/env node
/**
 * Self-host server: the same edge handler as the Worker, over a folder store, on Node.
 *
 *   node server/server.mjs start --content /site [--data /data] [--port 8080] [--watch]
 *       build the content folder, publish it to <data>/store, serve it on every hostname;
 *       with --watch, rebuild and flip the pointer when the folder changes (readers keep the old
 *       build until the new one is complete)
 *   node server/server.mjs serve --store <dir> [--site <id>] [--port 8080]
 *       serve an existing store: one site (--site) or many by hostname (hosts/<host>.json)
 *
 * Responses are compressed here (br/gzip) for text types; on Cloudflare the edge does that.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { compressible } from "../builder/mime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export function fsStore(root) {
  const file = (key) => path.join(root, key);
  return {
    async getText(key) {
      try {
        return await fs.promises.readFile(file(key), "utf8");
      } catch {
        return null;
      }
    },
    async getObject(hash, range) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      const f = file(`objects/${hash}`);
      let st;
      try {
        st = await fs.promises.stat(f);
      } catch {
        return null;
      }
      // Small bodies are read whole (faster than a stream); large ones (video) are streamed.
      if (!range && st.size < 1024 * 1024) return { body: await fs.promises.readFile(f), size: st.size };
      const stream = fs.createReadStream(f, range ? { start: range.offset, end: range.offset + range.length - 1 } : {});
      return { body: Readable.toWeb(stream), size: st.size };
    },
  };
}

function toRequest(req, port) {
  const host = req.headers.host || `localhost:${port}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://${host}${req.url}`, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? "half" : undefined });
}

async function send(res, req, response) {
  const headers = Object.fromEntries(response.headers);
  const type = headers["content-type"] || "";
  const ae = String(req.headers["accept-encoding"] || "");
  const enc = response.body && response.status === 200 && compressible(type) ? (/\bbr\b/.test(ae) ? "br" : /\bgzip\b/.test(ae) ? "gzip" : null) : null;
  if (enc) {
    delete headers["content-length"];
    headers["content-encoding"] = enc;
    headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : "Accept-Encoding";
  }
  res.writeHead(response.status, headers);
  if (!response.body || req.method === "HEAD") return res.end();
  let body = Readable.fromWeb(response.body);
  if (enc === "br") body = body.pipe(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }));
  else if (enc === "gzip") body = body.pipe(zlib.createGzip());
  body.pipe(res);
}

export async function listen({ store, site, port = 8080, log = console.error }) {
  const { createHandler } = await import(path.join(ROOT, "edge", "dist", "handler.mjs"));
  const handler = createHandler(store, { fixedSite: site || undefined, pointerTtlMs: 1000 });
  const server = http.createServer(async (req, res) => {
    try {
      const response = await handler.fetch(toRequest(req, port), { waitUntil: (p) => p.catch?.(() => {}) });
      await send(res, req, response);
    } catch (e) {
      log(`error ${req.method} ${req.url}: ${e.stack || e}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal error\n");
    }
  });
  await new Promise((r) => server.listen(port, r));
  log(`[markdrop-docs] serving ${site ? `site "${site}"` : "sites by hostname"} on http://localhost:${port}`);
  return server;
}

function parse(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (k === "watch") opt.watch = true;
    else opt[k] = argv[++i];
  }
  return opt;
}

async function buildAndPublish({ content, data, log }) {
  const { build } = await import("../builder/build.mjs");
  const { publish, FsStore } = await import("../builder/store.mjs");
  const t = Date.now();
  const res = await build({
    contentDir: content,
    outDir: path.join(data, "dist"),
    engineDir: process.env.MARKDROP_DOCS_ENGINE || path.resolve(ROOT, "..", "frontend"),
    // The engine stage + webpack cache. The Docker image warms one at build time (MARKDROP_DOCS_WORK).
    workDir: process.env.MARKDROP_DOCS_WORK || path.join(data, "work"),
    assets: process.env.MARKDROP_DOCS_ASSETS ? process.env.MARKDROP_DOCS_ASSETS.split(",").map((s) => ({ dir: s.split("=")[0], prefix: s.split("=")[1] || "/" })) : [],
    port: Number(process.env.MARKDROP_DOCS_BUILD_PORT || 3591),
    log,
  });
  const pub = await publish({ distDir: path.join(data, "dist"), store: new FsStore(path.join(data, "store")), site: "site" });
  log(`[markdrop-docs] ${res.skipped ? "no change" : "built"} in ${Date.now() - t} ms; uploaded ${pub.uploaded ?? 0} objects`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = parse(rest);
  const port = Number(opt.port || process.env.PORT || 8080);
  const log = (m) => console.error(m);
  if (cmd === "serve") {
    if (!opt.store) throw new Error("serve --store <dir> [--site <id>]");
    await listen({ store: fsStore(path.resolve(opt.store)), site: opt.site, port, log });
  } else if (cmd === "start") {
    const content = path.resolve(opt.content || "/site");
    const data = path.resolve(opt.data || "/data");
    await buildAndPublish({ content, data, log });
    await listen({ store: fsStore(path.join(data, "store")), site: "site", port, log });
    if (opt.watch) {
      let timer = null;
      let running = false;
      let again = false;
      const rebuild = async () => {
        if (running) return void (again = true);
        running = true;
        try {
          await buildAndPublish({ content, data, log });
        } catch (e) {
          log(`[markdrop-docs] build failed, still serving the last good build: ${e.message.split("\n")[0]}`);
        }
        running = false;
        if (again) {
          again = false;
          rebuild();
        }
      };
      fs.watch(content, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(rebuild, 500);
      });
      log(`[markdrop-docs] watching ${content}`);
    }
  } else {
    console.error("commands: start, serve (see the header of server/server.mjs)");
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
