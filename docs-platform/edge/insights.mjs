/**
 * Insights for Markdrop Guides: the edge counts a page view server side (backend
 * services/guide_insights.py). No script runs in the reader's browser for it, nothing is stored
 * there, and an ad blocker has nothing to drop. One POST to the API per page view, after the
 * response is sent (ctx.waitUntil), to `<api>/api/v1/docs/insights/<site>/hit`:
 *
 *   headers  Authorization: Bearer <edge key>  HMAC-SHA256(DOCS_ACCESS_SECRET, label), hex: the
 *                                              API derives the same from the secret it shares
 *            X-Docs-Reader-Ip                  the reader's address, for the API's daily-rotating
 *                                              visitor hash and its rate limit; never stored
 *   body     {path, host, ref, ua, country, dnt}
 *
 * Only for a site whose manifest says so (`site.insights`, from site.json: Insights on when it was
 * built; the API also drops views at once when it's turned off since), only for a page's HTML
 * (not its RSC payload, a prefetch, a HEAD, a Markdown twin, a file or a 404), and only with the
 * secret set. Client-side navigations after the first page are counted by the engine
 * (src/docs/client/Insights.tsx), which the edge never sees.
 */
export const EDGE_KEY_LABEL = "markdrop-docs-insights/v1";

const enc = new TextEncoder();
const keys = new Map();

/** The edge key for `secret` (cached per isolate). */
export function edgeKey(secret) {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle
      .importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then((key) => crypto.subtle.sign("HMAC", key, enc.encode(EDGE_KEY_LABEL)))
      .then((mac) => [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    keys.set(secret, k);
  }
  return k;
}

/** A page view worth counting: a browser loading the page itself (not prefetching or prerendering it). */
export function isPageView(req) {
  if (req.method !== "GET") return false;
  const purpose = `${req.headers.get("sec-purpose") || ""} ${req.headers.get("purpose") || ""} ${req.headers.get("x-purpose") || ""}`.toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("preview") || purpose.includes("prerender")) return false;
  if (req.headers.get("next-router-prefetch") === "1" || req.headers.get("rsc") === "1") return false;
  const dest = req.headers.get("sec-fetch-dest");
  return !dest || dest === "document";
}

/** What the API is told about one view (the referrer whole: the API keeps only its host). */
export function viewBody(req, url) {
  return {
    path: url.pathname.slice(0, 400),
    host: url.host.toLowerCase(),
    ref: (req.headers.get("referer") || "").slice(0, 1000) || null,
    ua: (req.headers.get("user-agent") || "").slice(0, 512),
    country: req.cf?.country || req.headers.get("cf-ipcountry") || null,
    dnt: req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1",
  };
}

/**
 * Send one view (never throws, never delays the response). `fetchFn` is the Worker's fetch (a test
 * passes its own).
 */
export function sendView({ req, url, site, apiOrigin, secret, ctx, fetchFn = fetch }) {
  const task = (async () => {
    const key = await edgeKey(secret);
    await fetchFn(`${apiOrigin}/api/v1/docs/insights/${encodeURIComponent(site)}/hit`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-docs-reader-ip": req.headers.get("cf-connecting-ip") || "",
      },
      body: JSON.stringify(viewBody(req, url)),
      signal: AbortSignal.timeout(3000),
    });
  })().catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(task);
  return task;
}
