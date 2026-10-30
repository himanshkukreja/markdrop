/**
 * The docs edge: one fetch handler that serves every published site from the object store.
 * Runs as the Cloudflare Worker (edge/worker.mjs, store = R2) and inside the self-host server
 * (server/server.mjs, store = a folder). Bundled by builder/bundle.mjs.
 *
 * Per request: hostname → site (hosts/<host>.json, cached) → pointer (sites/<site>/current.json,
 * cached a few seconds) → manifest (immutable, cached by hash) → one object read. Routing reuses
 * the frontend's own middleware logic (src/docs/host.ts: docsRewritePath, Accept negotiation), so
 * an address means the same thing here as on docs.markdrop.in:
 *
 *   /_next/static/*                      framework chunks (immutable)
 *   pass-through paths (/docs-assets/…)  the site's files (Range supported, for video)
 *   everything else                      the engine's route: HTML, or its RSC payload for the
 *                                        client router (`RSC: 1`), or the Markdown twin
 *                                        (`.md` / `Accept: text/markdown`), text outputs, OG cards
 *   /mcp                                 the docs MCP server (the engine's route, run here)
 *   /api/geo                             the consent banner's country check (the app's route)
 *   no match                             redirects.json, else the engine's 404 page
 */
import { docsRewritePath, DOCS_INTERNAL } from "@/docs/host";
import { normalizeHost } from "@/components/tenant/hosts";
import { GET as geoGET } from "@/app/api/geo/route";
import { createMcpEngine } from "./dist/mcp-engine.mjs";

const RSC_VARY = "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Accept";
const MCP_ROUTE = `${DOCS_INTERNAL}/mcp`;

const CACHE = {
  immutable: "public, max-age=31536000, immutable",
  page: "public, max-age=0, must-revalidate",
  file: "public, max-age=3600",
  notFound: "public, max-age=60",
};

/** A tiny LRU (Map keeps insertion order). */
class Lru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

function text(body, status, extra = {}) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra } });
}

/** `bytes=a-b` → {offset, length} within size, or null (whole body), or false (unsatisfiable). */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return false;
  return { offset: start, length: end - start + 1 };
}

/**
 * store: { getText(key) → string|null, getObject(hash, range?) → {body, size}|null }
 * options.fixedSite: serve this site on every hostname (self-host); otherwise hosts/<host>.json.
 * options.pointerTtlMs: how long an isolate trusts the pointer it read (publish → live delay).
 * options.onServe(info): observer for request accounting (tests, logs).
 */
export function createHandler(store, options = {}) {
  const pointerTtl = options.pointerTtlMs ?? 5000;
  const hostTtl = options.hostTtlMs ?? 60_000;
  const hosts = new Map();
  const pointers = new Map();
  const manifests = new Lru(16);
  const engines = new Lru(8);
  /* The Worker ctx of each request, for the store's waitUntil (cache writes). */
  const ctxOf = new WeakMap();

  async function siteFor(host) {
    if (options.fixedSite) return options.fixedSite;
    const hit = hosts.get(host);
    if (hit && Date.now() - hit.at < hostTtl) return hit.site;
    const raw = await store.getText(`hosts/${host}.json`);
    const site = raw ? JSON.parse(raw).site : null;
    hosts.set(host, { site, at: Date.now() });
    return site;
  }

  async function manifestFor(site) {
    let ptr = pointers.get(site);
    if (!ptr || Date.now() - ptr.at > pointerTtl) {
      const raw = await store.getText(`sites/${site}/current.json`);
      ptr = { hash: raw ? JSON.parse(raw).manifest : null, at: Date.now() };
      pointers.set(site, ptr);
    }
    if (!ptr.hash) return null;
    let m = manifests.get(ptr.hash);
    if (!m) {
      const raw = await store.getText(`manifests/${ptr.hash}.json`);
      if (!raw) return null;
      m = JSON.parse(raw);
      m.hash = ptr.hash;
      m.redirectMap = new Map(m.redirects.map((r) => [r.from, r]));
      manifests.set(ptr.hash, m);
    }
    return m;
  }

  /** Serve one object with its type and headers; ETag is the object hash. */
  async function serve(req, entry, { type, cache, status = 200, headers = {}, range = false, kind }) {
    const etag = `"${entry.o}"`;
    const h = new Headers({ "content-type": type, "cache-control": cache, etag, ...headers, ...(entry.h || {}) });
    if (range) h.set("accept-ranges", "bytes");
    options.onServe?.({ kind, status, size: entry.s });
    if (status === 200 && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: h });
    let r = null;
    if (range && req.headers.has("range")) {
      r = parseRange(req.headers.get("range"), entry.s);
      if (r === false) {
        h.set("content-range", `bytes */${entry.s}`);
        return new Response(null, { status: 416, headers: h });
      }
    }
    if (req.method === "HEAD") {
      h.set("content-length", String(r ? r.length : entry.s));
      return new Response(null, { status: r ? 206 : status, headers: h });
    }
    const obj = await store.getObject(entry.o, r || undefined, ctxOf.get(req));
    if (!obj) return text("Object missing\n", 502);
    if (r) {
      h.set("content-range", `bytes ${r.offset}-${r.offset + r.length - 1}/${entry.s}`);
      h.set("content-length", String(r.length));
      return new Response(obj.body, { status: 206, headers: h });
    }
    h.set("content-length", String(entry.s));
    return new Response(obj.body, { status, headers: h });
  }

  function notFound(req, m) {
    if (!m.notFound) return text("Not found\n", 404);
    return serve(req, m.notFound, { type: m.notFound.t, cache: CACHE.notFound, status: 404, kind: "404" });
  }

  async function mcp(req, site, m, ctx) {
    let engine = engines.get(m.hash);
    if (!engine) {
      const obj = await store.getObject(m.mcp.o, undefined, ctx);
      if (!obj) return text("MCP data missing\n", 502);
      const snap = JSON.parse(await new Response(obj.body).text());
      const hooks = { after: (task) => void Promise.resolve().then(task).catch(() => {}) };
      engine = { route: createMcpEngine(snap.files, hooks).route, hooks };
      engines.set(m.hash, engine);
    }
    if (ctx?.waitUntil) engine.hooks.after = (task) => ctx.waitUntil(Promise.resolve().then(task).catch(() => {}));
    options.onServe?.({ kind: "mcp", status: 200, size: 0 });
    const fn = engine.route[req.method];
    if (typeof fn !== "function") return text("Method not allowed\n", 405, { allow: "POST, GET, DELETE, OPTIONS" });
    return fn(req);
  }

  return {
    async fetch(req, ctx) {
      ctxOf.set(req, ctx);
      const url = new URL(req.url);
      // The URL carries the hostname the client asked for (on Workers it is the Host header).
      const host = normalizeHost(url.host);
      const site = await siteFor(host);
      if (!site) return text("No docs site at this address.\n", 404);
      const m = await manifestFor(site);
      if (!m) return text("This site has not been published yet.\n", 404);

      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return notFound(req, m);
      }
      if (pathname === "/api/geo") {
        // The app's own route, with Cloudflare's country in the header it reads on Vercel.
        const headers = new Headers(req.headers);
        const country = req.cf?.country || req.headers.get("cf-ipcountry");
        if (country) headers.set("x-vercel-ip-country", country);
        return geoGET(new Request(req.url, { headers }));
      }

      const internal = pathname.startsWith("/_next/") ? null : docsRewritePath(pathname, req.headers.get("accept"));
      if (internal === MCP_ROUTE) return mcp(req, site, m, ctx);
      if (req.method !== "GET" && req.method !== "HEAD") return text("Method not allowed\n", 405, { allow: "GET, HEAD" });

      if (internal === null) {
        const f = m.files[pathname];
        if (f) {
          const immutable = !!f.immutable;
          return serve(req, f, { type: f.t, cache: immutable ? CACHE.immutable : CACHE.file, range: !immutable, kind: immutable ? "chunk" : "file" });
        }
      } else {
        const r = m.routes[internal];
        if (r) {
          const isPage = !!r.rsc;
          if (isPage && req.headers.get("rsc") === "1") {
            const v = (req.headers.get("next-router-prefetch") === "1" && r.prefetch) || r.rsc;
            return serve(req, v, { type: "text/x-component", cache: CACHE.page, headers: { vary: RSC_VARY }, kind: "rsc" });
          }
          // Text outputs keep the cache policy the engine gave them; pages revalidate by ETag.
          const cache = r.h?.["cache-control"] || CACHE.page;
          return serve(req, r, { type: r.t, cache, headers: { vary: isPage ? RSC_VARY : "Accept" }, kind: isPage ? "page" : r.t.startsWith("image/") ? "og" : "text" });
        }
      }

      const redirect = m.redirectMap.get(pathname) || m.redirectMap.get(pathname.replace(/\/+$/, "") || "/");
      if (redirect) {
        options.onServe?.({ kind: "redirect", status: redirect.status, size: 0 });
        return new Response(null, { status: redirect.status, headers: { location: redirect.to + url.search, "cache-control": CACHE.file } });
      }
      return notFound(req, m);
    },
  };
}
