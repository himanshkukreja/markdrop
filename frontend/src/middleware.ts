import { NextRequest, NextResponse } from "next/server";

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
 */

/** Hosts that are *us*. Everything else is a customer domain. */
const PRIMARY_HOSTS = new Set(
  (process.env.NEXT_PUBLIC_PRIMARY_HOSTS || "markdrop.in,www.markdrop.in,localhost")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

function isPrimaryHost(host: string): boolean {
  if (PRIMARY_HOSTS.has(host)) return true;
  // Vercel preview deployments get a generated hostname per build; treating
  // them as customer domains would make every preview 404.
  if (host.endsWith(".vercel.app")) return true;
  if (host === "127.0.0.1" || host.startsWith("localhost:")) return true;
  return false;
}

export function middleware(request: NextRequest) {
  const host = (request.headers.get("host") || "").toLowerCase().split(":")[0];
  if (!host || isPrimaryHost(host)) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  // Already rewritten (Next re-enters middleware on internal navigation).
  if (pathname.startsWith("/h/")) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = `/h/${host}${pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // Static assets and API routes must pass through untouched — rewriting them
  // would break every chunk request on a custom domain.
  matcher: ["/((?!_next/static|_next/image|api/|favicon.ico|.*\\..*).*)"],
};
