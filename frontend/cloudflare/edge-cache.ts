// Edge copies: whole responses kept in the colo's cache (the Workers Cache API), answered before Next is loaded. A
// copy spares the visitor the OpenNext path (R2 read, tag-cache Durable Object lookups, a cold isolate's first render:
// 1-2.5 s on a quiet colo) and is what Vercel's CDN did. Used by cloudflare/worker.ts; no imports, so
// cloudflare/edge-cache.test.mjs runs it under plain Node. Vercel ignores this file.
//
// What is kept, per host + path (+ query) + Accept flavour, and per deployment (a page refers to its build's
// /_next/static files; each deploy starts empty):
//   - the docs site (docs.markdrop.in): every public 200, for the deployment (its content is built in);
//   - prerendered pages that never revalidate (landing, marketing, /login, ...: s-maxage of a day or more) on any host,
//     for the deployment;
//   - ISR pages (documents: revalidate 60) for at most ISR_TTL seconds. With the tag cache's colo window
//     (open-next.config.ts regionalCacheTtlSec) the two add up to <= 60 s from an edit or an access change (the
//     API's revalidate outbox) to every reader. The colo that receives the revalidation drops its copies at once;
//   - every 404 for 60 s (the documents' own revalidate).
// Never kept: a response that sets a cookie or says private / no-store (200s), a request with credentials or the
// signed-in hint cookie (md_si: "/" is the dashboard for them), a client navigation's RSC / prefetch request (the
// answer varies on those headers), the API routes, /_next, anything but GET.

export const DOCS_HOSTS = new Set(["docs.markdrop.in"]);
export const STATIC_TTL = 24 * 3600;
export const ISR_TTL = 15;
export const NOT_FOUND_TTL = 60;
/** The app's own hosts, whose /<slug> document copies a revalidation drops (plus the host it arrived on). */
export const APP_HOSTS = ["www.markdrop.in"];
export const EDGE_HEADER = "x-md-edge";

const RSC_HEADERS = ["rsc", "next-router-prefetch", "next-router-state-tree", "next-router-segment-prefetch", "next-url"];
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_ga|_gl)$/i;

/** Why a request is answered without the edge cache, or null when it may use it. */
export function bypassReason(method: string, headers: Headers, url: URL): string | null {
  if (method !== "GET") return "method";
  if (headers.has("authorization")) return "auth";
  if (/(?:^|;\s*)md_si=/.test(headers.get("cookie") || "")) return "signed-in";
  if (RSC_HEADERS.some((h) => headers.has(h)) || url.searchParams.has("_rsc")) return "rsc";
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/")) return "route";
  return null;
}

/**
 * The cache key: per deployment, host and Accept flavour; marketing query parameters don't split it. `origin` is the
 * address the request arrived on (the key stays in its zone); `url` carries the host Next sees (x-md-host on tests).
 */
export function edgeKey(origin: string, url: URL, accept: string | null, version: string): Request {
  const md = /text\/markdown/i.test(accept || "") ? "md" : "html";
  const params = [...url.searchParams].filter(([k]) => !TRACKING.test(k));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  params.push(["__edge", `${version}|${url.hostname}|${md}`]);
  const k = new URL(url.pathname, origin);
  k.search = new URLSearchParams(params).toString();
  return new Request(k.toString(), { method: "GET" });
}

/** Seconds an answer may be kept at the edge (0 = never). */
export function edgeTtl(status: number, headers: Headers, docs: boolean): number {
  if (headers.has("set-cookie")) return 0;
  if (status === 404) return NOT_FOUND_TTL;
  if (status !== 200) return 0;
  const cc = headers.get("cdn-cache-control") || headers.get("cache-control") || "";
  if (/private|no-store|no-cache/i.test(cc)) return 0;
  if (docs) return STATIC_TTL;
  const m = /s-maxage=(\d+)/i.exec(cc);
  if (!m) return 0;
  const s = Number(m[1]);
  if (s >= STATIC_TTL) return STATIC_TTL;
  return Math.min(s, ISR_TTL);
}

/** The copy to store: the shared lifetime for Cloudflare's cache; Vary kept aside (Cloudflare's cache ignores it). */
export function edgeCopy(res: Response, ttl: number): Response {
  const copy = new Response(res.clone().body, res);
  copy.headers.set("cache-control", `public, s-maxage=${ttl}`);
  // Cloudflare's cache obeys CDN-Cache-Control over Cache-Control
  copy.headers.delete("cdn-cache-control");
  const vary = copy.headers.get("vary");
  copy.headers.delete("vary");
  if (vary) copy.headers.set("x-md-vary", vary);
  return copy;
}

/** A stored copy as the browser gets it: browser cache headers as on the render path, plus the debug header. */
export function fromCopy(hit: Response, docs: boolean): Response {
  const out = new Response(hit.body, hit);
  out.headers.set("cache-control", hit.status === 404 ? "private, no-cache, no-store, max-age=0, must-revalidate" : "public, max-age=0, must-revalidate");
  const vary = out.headers.get("x-md-vary");
  out.headers.delete("x-md-vary");
  if (docs) out.headers.set("vary", "Accept");
  else if (vary) out.headers.set("vary", vary);
  out.headers.set(EDGE_HEADER, "HIT");
  return out;
}

/** The copies a revalidation of document `slug` makes stale (both flavours, the app hosts + the one it arrived on). */
export function purgeKeys(slug: string, host: string, version: string): Request[] {
  const hosts = new Set([...APP_HOSTS, host]);
  const out: Request[] = [];
  for (const h of hosts) {
    const url = new URL(`https://${h}/${slug}`);
    for (const accept of ["text/html", "text/markdown"]) out.push(edgeKey(url.origin, url, accept, version));
  }
  return out;
}
