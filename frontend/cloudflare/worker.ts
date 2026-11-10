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
// @ts-ignore built by `opennextjs-cloudflare build` (missing until then)
import { default as handler } from "../.open-next/worker.js";

type Env = { STAGING_HOST_OVERRIDE?: string; [k: string]: unknown };
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
    const res: Response = await handler.fetch(new Request(url.toString(), { method: request.method, headers, body: request.body, redirect: "manual", cf: (request as { cf?: unknown }).cf } as RequestInit), env, ctx);
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
