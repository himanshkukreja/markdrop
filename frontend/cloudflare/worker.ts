// Cloudflare Worker entry (wrangler.jsonc "main"): the OpenNext worker built by `opennextjs-cloudflare build`, plus
// what Vercel's platform did around the Next app. Vercel ignores this file.
//  1. Browser cache headers like Vercel's CDN: Vercel consumes s-maxage / stale-while-revalidate and sends browsers
//     "public, max-age=0, must-revalidate"; a Worker's response reaches the browser as is, and browsers honour
//     stale-while-revalidate in their own cache (stale documents from disk; the "two tabs" e2e caught it).
//  2. markdrop.in -> www.markdrop.in (a Vercel domain setting).
//  3. The PostHog proxy (/mdp, next.config.ts rewrites on Vercel) with the visitor's IP for geolocation and the
//     upstream body passed through untouched (proxying a gzipped body through Next double-encoded it).
//  4. The visitor's country for /api/geo (Vercel's x-vercel-ip-country), from Cloudflare.
//  5. A User-Agent on server-side fetches (Workers send none; some hosts refuse those).
//  6. Test deploys (workers.dev, next.markdrop.in) are never indexed, and on them (STAGING_HOST_OVERRIDE=1) the
//     x-md-host header picks the host Next sees, so the docs and workspace-domain paths can be tried on one URL.
//  7. Edge copies in the colo's cache (Vercel's CDN kept these): docs-site pages for the deployment's lifetime (their
//     content is built in), and every 404 for 60 s (the documents' own revalidate). A copy answers without loading
//     Next, which also spares the visitor a cold isolate's first render.
//  8. Workspace custom domains (content.acme.com) arrive through their own route `<host>/*` (Cloudflare for SaaS,
//     backend services/cf_saas.py) with the customer's host in the URL and Host header; nothing here changes it
//     (x-md-host is honoured on test hosts only), so the middleware rewrites it to the tenant renderer exactly as on
//     Vercel, and edge copies are kept per host. The zone's fallback origin is never fetched.
// @ts-ignore built by `opennextjs-cloudflare build` (missing until then)
import { default as handler } from "../.open-next/worker.js";

type Env = { STAGING_HOST_OVERRIDE?: string; CF_VERSION_METADATA?: { id: string }; [k: string]: unknown };
type Ctx = { waitUntil(p: Promise<unknown>): void; passThroughOnException?(): void };

const UA = "Markdrop-Web/1.0 (+https://markdrop.in)";
const nativeFetch = globalThis.fetch;
globalThis.fetch = function fetchWithUserAgent(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.has("user-agent")) return nativeFetch(input, init);
  headers.set("user-agent", UA);
  return nativeFetch(input, { ...init, headers });
} as typeof fetch;

const APEX = "markdrop.in";
const POSTHOG: [string, string][] = [
  ["/mdp/static/", "https://us-assets.i.posthog.com/static/"],
  ["/mdp/array/", "https://us-assets.i.posthog.com/array/"],
  ["/mdp/", "https://us.i.posthog.com/"],
];
const isTestHost = (h: string) => h.endsWith(".workers.dev") || h === "next.markdrop.in";
/** The docs site's hosts (src/docs/host.ts): every page there is the same for every reader until the next deploy. */
const DOCS_HOSTS = new Set(["docs.markdrop.in"]);
const DOCS_TTL = 24 * 3600;
const NOT_FOUND_TTL = 60;
const BROWSER_CC = "public, max-age=0, must-revalidate";

/**
 * A request whose answer is the same for every visitor of this host + path: GET, no credentials header, not a client
 * navigation's RSC / prefetch request (those answers vary on these headers), not the API routes or the proxy.
 * (The server never reads cookies: sessions live in the browser.)
 */
function edgeCacheable(request: Request, url: URL): boolean {
  if (request.method !== "GET" || request.headers.has("authorization") || request.headers.has("rsc")) return false;
  if (request.headers.has("next-router-prefetch") || request.headers.has("next-router-state-tree") || url.searchParams.has("_rsc")) return false;
  return !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/_next/");
}

function edgeKey(request: Request, url: URL, version: string): Request {
  const md = /text\/markdown/i.test(request.headers.get("accept") || "") ? "md" : "html";
  // per deployment (a copy refers to that build's /_next/static files) and per host (the x-md-host test header)
  const k = new URL(request.url);
  k.search = `${url.search ? `${url.search}&` : "?"}__edge=${encodeURIComponent(`${version}|${url.hostname}|${md}`)}`;
  return new Request(k.toString(), { method: "GET" });
}

/** The copy kept at the edge, or null: docs pages (200) for a day, 404s for a minute; never one that sets a cookie. */
function edgeCopy(res: Response, docs: boolean): Response | null {
  if (res.headers.has("set-cookie")) return null;
  let ttl = 0;
  if (res.status === 404) ttl = NOT_FOUND_TTL;
  else if (docs && res.status === 200 && !/private|no-store/i.test(res.headers.get("cache-control") || "")) ttl = DOCS_TTL;
  if (!ttl) return null;
  const copy = new Response(res.clone().body, res);
  copy.headers.set("cache-control", `public, s-maxage=${ttl}`);
  // Cloudflare's cache obeys CDN-Cache-Control over Cache-Control
  copy.headers.delete("cdn-cache-control");
  copy.headers.delete("vary");
  return copy;
}

function posthog(request: Request, url: URL): Promise<Response> | null {
  for (const [prefix, upstream] of POSTHOG) {
    if (!url.pathname.startsWith(prefix)) continue;
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("host");
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) headers.set("x-forwarded-for", ip);
    const target = `${upstream}${url.pathname.slice(prefix.length)}${url.search}`;
    // returned as is: the runtime keeps the upstream encoding (no decode + re-encode)
    return nativeFetch(target, { method: request.method, headers, body: request.body, redirect: "manual" });
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx) {
    let url = new URL(request.url);
    if (url.hostname === APEX) return Response.redirect(`https://www.${APEX}${url.pathname}${url.search}`, 307);
    if (url.pathname.startsWith("/mdp/")) return (await posthog(request, url)) ?? new Response("Not found", { status: 404 });

    const headers = new Headers(request.headers);
    // only Cloudflare's own country, never a client-sent copy
    headers.delete("x-vercel-ip-country");
    const country = (request as Request & { cf?: { country?: string } }).cf?.country;
    if (country) headers.set("cf-ipcountry", country);
    else headers.delete("cf-ipcountry");
    const testHost = isTestHost(url.hostname);
    const override = headers.get("x-md-host");
    headers.delete("x-md-host");
    if (testHost && env.STAGING_HOST_OVERRIDE === "1" && override && /^[a-z0-9.-]+$/i.test(override)) {
      url = new URL(url.toString());
      url.hostname = override.toLowerCase();
      headers.set("host", url.host);
    }
    const docs = DOCS_HOSTS.has(url.hostname);
    const cache = edgeCacheable(request, url) ? (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default : undefined;
    const key = cache ? edgeKey(request, url, env.CF_VERSION_METADATA?.id ?? "dev") : null;
    if (cache && key) {
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) {
        const out = new Response(hit.body, hit);
        out.headers.set("cache-control", hit.status === 404 ? "private, no-cache, no-store, max-age=0, must-revalidate" : BROWSER_CC);
        if (docs) out.headers.set("vary", "Accept");
        out.headers.set("x-edge-cache", "HIT");
        if (testHost) out.headers.set("x-robots-tag", "noindex, nofollow");
        return out;
      }
    }
    const res: Response = await handler.fetch(new Request(url.toString(), { method: request.method, headers, body: request.body, redirect: "manual", cf: (request as { cf?: unknown }).cf } as RequestInit), env, ctx);
    if (cache && key) {
      const copy = edgeCopy(res, docs);
      if (copy) ctx.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return finish(res, testHost);
  },
};

/** Browser cache headers like Vercel's CDN; never a shared copy of a response that sets a cookie; noindex on tests. */
function finish(res: Response, testHost: boolean): Response {
  const cc = res.headers.get("cache-control") || "";
  const shared = /s-maxage|stale-while-revalidate/i.test(cc);
  const cookie = res.headers.has("set-cookie") && /public|s-maxage/i.test(cc);
  if (!shared && !cookie && !testHost) return res;
  const out = new Response(res.body, res);
  if (cookie) out.headers.set("cache-control", "private, no-cache, no-store, max-age=0, must-revalidate");
  else if (shared) {
    out.headers.set("cache-control", "public, max-age=0, must-revalidate");
    // Cloudflare's cache obeys CDN-Cache-Control: the shared-cache lifetime stays with it
    out.headers.set("cdn-cache-control", cc);
  }
  if (testHost) out.headers.set("x-robots-tag", "noindex, nofollow");
  return out;
}

// @ts-ignore built by `opennextjs-cloudflare build` (missing until then)
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../.open-next/worker.js";
