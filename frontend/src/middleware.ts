import { NextRequest, NextResponse } from "next/server";
import { TENANT_HOST_HEADER, isPrimaryHost, normalizeHost } from "@/components/tenant/hosts";
import { DOCS_INTERNAL, docsOrigin, docsRewritePath, isDocsHost } from "@/docs/host";

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
const ICON_PATHS = new Set(["/favicon.ico", "/icon.svg", "/apple-icon"]);
const MARKDROP_ONLY_PATHS = new Set(["/manifest.webmanifest", "/sitemap.xml"]);

function notFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
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

  if (isPrimaryHost(host)) {
    // The tenant renderer is internal: reachable only through the rewrite below.
    // (`/h` alone is left to /[slug]: it is not the tenant renderer.)
    if (pathname.startsWith("/h/")) return notFound();
    // So is the docs tree; /docs on the app moves to the docs host for good.
    if (pathname === DOCS_INTERNAL || pathname.startsWith(`${DOCS_INTERNAL}/`)) return notFound();
    if (pathname === "/docs" || pathname.startsWith("/docs/")) {
      const rest = pathname.slice("/docs".length) || "/";
      return NextResponse.redirect(`${docsOrigin(host, request.nextUrl.port)}${rest}${request.nextUrl.search}`, 308);
    }
    return NextResponse.next();
  }

  // Our own route handlers (geo, revalidate) answer on every host.
  if (pathname.startsWith("/api/")) return NextResponse.next();

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
