import { NextRequest, NextResponse } from "next/server";
import { TENANT_HOST_HEADER, isPrimaryHost, normalizeHost } from "@/components/tenant/hosts";
import { DOCS_INTERNAL, docsOrigin, docsRewritePath, isDocsHost } from "@/docs/host";
import { STUDIO_ROBOTS, isStudioHost, studioRouting, type StudioRouting } from "@/lib/studioHost";
import { SIGNED_IN_COOKIE, homeRedirect } from "@/lib/homeRedirect";

/**
 * Route requests that arrived on a customer's own domain to the tenant renderer.
 *
 * Deliberately does **no** network call. Resolving the host here would put an
 * API round trip in front of every single request, including all of markdrop.in.
 * It only decides "is this one of ours, or someone else's?" — a string compare —
 * and rewrites to /h/<host>/… so the tenant page can do the lookup with Next's
 * data cache behind it.
 *
 * Rewriting rather than reading headers() in /[slug] is the other half of that:
 * headers() would opt the shared document route into dynamic rendering for
 * everyone, undoing the prerendering that keeps markdrop.in fast.
 *
 * `/h/*` is internal. The host it renders for always comes from the request's
 * own Host header, never from the path:
 *
 *   - on a customer host, EVERY path is rewritten to `/h/<that host><path>`,
 *     including a path that itself starts with `/h/` (middleware runs once per
 *     request; there is no "already rewritten" case). `docs.acme.com/h/evil.com/x`
 *     renders docs.acme.com's `/h/evil.com/x`, which is a 404 or a redirect to a
 *     document of docs.acme.com — never evil.com's;
 *   - on our own hosts `/h/*` is a 404;
 *   - and the tenant layout re-checks the param against the Host header and the
 *     header set here, so a path that slipped past the matcher still can't
 *     render another tenant.
 */

const TENANT_ROBOTS = "User-agent: *\nAllow: /\n";

/** Markdrop's own icons and app metadata, which must not appear on a customer's domain. */
const ICON_PATHS = new Set(["/favicon.ico", "/icon.svg", "/apple-icon", "/apple-icon.png"]);
/** Markdrop's app files (manifests, service worker, offline page: lib/pwa.ts), never a customer's. */
const MARKDROP_ONLY_PATHS = new Set(["/manifest.webmanifest", "/studio.webmanifest", "/sw.js", "/offline.html", "/sitemap.xml"]);

function notFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Markdrop Guides' studio host (guides.markdrop.in) and the studio's old /guides/* addresses
 * (lib/studioHost studioRouting): rewrites onto the /guides route tree, redirects, robots.txt.
 * Null to carry on. Everything on the studio host is an app screen: never indexed.
 */
function applyStudio(request: NextRequest, r: StudioRouting, studioHost: boolean): NextResponse | null {
  let res: NextResponse | null = null;
  if (r.kind === "robots") {
    res = new NextResponse(STUDIO_ROBOTS, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  } else if (r.kind === "not-found") {
    res = notFound();
  } else if (r.kind === "redirect") {
    // A relative location is on the host the visitor asked (its Host header: when self-hosted,
    // request.nextUrl names the server's own address instead).
    const here = `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`;
    res = NextResponse.redirect(new URL(r.location, here), r.temporary ? 307 : 308);
  } else if (r.kind === "rewrite") {
    const url = request.nextUrl.clone();
    url.pathname = r.path;
    res = NextResponse.rewrite(url);
  } else if (studioHost) {
    res = NextResponse.next();
  }
  if (res && studioHost) res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

export function middleware(request: NextRequest) {
  const host = normalizeHost(request.headers.get("host"));
  const { pathname } = request.nextUrl;

  // The docs site (docs.markdrop.in, docs.localhost in dev) is neither a tenant nor the app: every
  // path is rewritten to the internal /docs-site tree, and Accept: text/markdown picks the
  // Markdown twin of a page (so the response varies on Accept).
  if (isDocsHost(host)) {
    const target = docsRewritePath(pathname, request.headers.get("accept"));
    if (target === null) return NextResponse.next();
    const url = request.nextUrl.clone();
    url.pathname = target;
    const res = NextResponse.rewrite(url);
    res.headers.set("Vary", "Accept");
    return res;
  }

  // The studio host: every path is a studio screen (rewritten onto /guides/…), a public file, or
  // the rest of Markdrop (redirected to the app's host). Never a tenant, never the docs tree.
  if (isStudioHost(host)) {
    if (pathname.startsWith("/h/") || pathname === DOCS_INTERNAL || pathname.startsWith(`${DOCS_INTERNAL}/`)) return notFound();
    // The studio installs as its own app, "Markdrop Guides" (lib/pwaManifest.ts).
    if (pathname === "/manifest.webmanifest") {
      const url = request.nextUrl.clone();
      url.pathname = "/studio.webmanifest";
      return NextResponse.rewrite(url);
    }
    const r = studioRouting(host, pathname, request.nextUrl.search, request.nextUrl.port);
    return applyStudio(request, r, true) ?? NextResponse.next();
  }

  if (isPrimaryHost(host)) {
    // Signed in (the md_si hint, lib/homeRedirect): "/" is the dashboard, before any HTML. Only "/"
    // on the app host, never with ?home=1. no-store: this answer is per browser, while the
    // prerendered "/" everyone else gets stays as it is.
    const home = homeRedirect({
      host,
      method: request.method,
      pathname,
      search: request.nextUrl.search,
      cookie: request.cookies.get(SIGNED_IN_COOKIE)?.value,
      fetchMode: request.headers.get("sec-fetch-mode"),
      accept: request.headers.get("accept"),
    });
    if (home) {
      const here = `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`;
      const res = NextResponse.redirect(new URL(home, here), 307);
      res.headers.set("Cache-Control", "private, no-store");
      return res;
    }
    // The tenant renderer is internal: reachable only through the rewrite below.
    // (`/h` alone is left to /[slug]: it is not the tenant renderer.)
    if (pathname.startsWith("/h/")) return notFound();
    // So is the docs tree; /docs on the app moves to the docs host for good.
    if (pathname === DOCS_INTERNAL || pathname.startsWith(`${DOCS_INTERNAL}/`)) return notFound();
    if (pathname === "/docs" || pathname.startsWith("/docs/")) {
      const rest = pathname.slice("/docs".length) || "/";
      return NextResponse.redirect(`${docsOrigin(host, request.nextUrl.port)}${rest}${request.nextUrl.search}`, 308);
    }
    // markdrop.in/guides is the landing page; the studio's screens moved to the studio host.
    return applyStudio(request, studioRouting(host, pathname, request.nextUrl.search), false) ?? NextResponse.next();
  }

  // Our own route handlers (geo, revalidate) answer on every host.
  if (pathname.startsWith("/api/")) return NextResponse.next();
  // Cloudflare for SaaS checks hostname ownership here before the host moves to Cloudflare
  // (app/api/hostname-challenge): answered from the API, never by the tenant renderer.
  if (pathname.startsWith("/.well-known/cf-custom-hostname-challenge/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/api/hostname-challenge";
    url.search = `?path=${encodeURIComponent(pathname)}`;
    return NextResponse.rewrite(url);
  }
  // So do the built-in page covers: a page on a workspace's domain shows them too.
  if (pathname.startsWith("/page-covers/")) return NextResponse.next();

  if (pathname === "/robots.txt") {
    return new NextResponse(TENANT_ROBOTS, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }
  if (MARKDROP_ONLY_PATHS.has(pathname)) return notFound();

  const headers = new Headers(request.headers);
  headers.set(TENANT_HOST_HEADER, host);

  const url = request.nextUrl.clone();
  // The tenant's own favicon (or a 404), never Markdrop's: the root layout's icon
  // links are file-based and can't be overridden per page, so their URLs are
  // answered here instead.
  url.pathname = ICON_PATHS.has(pathname) ? `/h/${host}/tenant-icon.ico` : `/h/${host}${pathname}`;
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  // Static assets and the analytics proxy (/mdp, next.config.ts) pass through untouched —
  // rewriting them would break every chunk request on a custom domain. Dotted paths are NOT
  // skipped any more: on a customer host robots.txt, the manifest and the icons must be
  // answered for the tenant, and on ours `/h/<host>/…` (whose host has dots) must be refused.
  matcher: ["/((?!_next/|mdp/).*)"],
};
