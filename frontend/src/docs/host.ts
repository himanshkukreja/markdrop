/**
 * Which requests belong to the docs site, and where the middleware sends them. Plain module (no
 * runtime imports beyond the host normaliser) so the edge middleware can use it.
 */
import { normalizeHost } from "@/components/tenant/hosts";

export const DOCS_HOST = normalizeHost(process.env.NEXT_PUBLIC_DOCS_HOST || "docs.markdrop.in");
/** Local development: http://docs.localhost:<port> resolves to 127.0.0.1 in every modern browser. */
export const DOCS_DEV_HOST = "docs.localhost";
/** The internal route tree the docs host is rewritten to (404 on every other host). */
export const DOCS_INTERNAL = "/docs-site";

export function isDocsHost(host: string): boolean {
  return host === DOCS_HOST || host === DOCS_DEV_HOST;
}

/** Where markdrop.in/docs/... goes: the docs host (http + the same port when running locally). */
export function docsOrigin(requestHost: string, port: string): string {
  const local = requestHost === "localhost" || requestHost === "127.0.0.1" || DOCS_HOST.endsWith(".localhost");
  if (local) return `http://${DOCS_HOST.endsWith(".localhost") ? DOCS_HOST : DOCS_DEV_HOST}${port ? `:${port}` : ""}`;
  return `https://${DOCS_HOST}`;
}

/**
 * The app's own route handlers (src/app/api/*) that a docs page may call (the consent banner asks
 * /api/geo). Every other /api/… address on the docs host is a docs page: the API reference lives
 * at /api/<group>/<operation>.
 */
const APP_API = ["/api/geo", "/api/revalidate"];

/** Paths answered by their own handlers on every host (public files, framework internals). */
function passThrough(pathname: string): boolean {
  return (
    APP_API.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith("/docs-assets/") ||
    pathname.startsWith("/__next") ||
    pathname.startsWith("/_vercel/") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg" ||
    pathname === "/apple-icon" ||
    pathname.startsWith("/apple-icon")
  );
}

/** Text outputs that end in .md but are not page twins. */
const MD_FILES = new Set(["/skill.md", "/changelog.md"]);

/**
 * True when the client prefers Markdown to HTML (`Accept: text/markdown`, or markdown with a q at
 * least as high as HTML's). Browsers never send text/markdown, so they always get HTML.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let md = -1;
  let html = -1;
  for (const part of accept.split(",")) {
    const [type, ...params] = part.trim().toLowerCase().split(";");
    const qp = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
    const q = qp ? Number(qp.slice(2)) : 1;
    const v = Number.isFinite(q) ? q : 0;
    const t = type.trim();
    if (t === "text/markdown" || t === "text/x-markdown") md = Math.max(md, v);
    else if (t === "text/html" || t === "application/xhtml+xml") html = Math.max(html, v);
  }
  return md > 0 && md >= html;
}

/** The internal path for a docs-host request, or null to let it through untouched. */
export function docsRewritePath(pathname: string, accept: string | null): string | null {
  if (passThrough(pathname)) return null;
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean.endsWith(".md") && !MD_FILES.has(clean)) return `${DOCS_INTERNAL}/md${clean.slice(0, -3)}`;
  if (prefersMarkdown(accept) && !/\.[a-z0-9]+$/i.test(clean)) {
    if (clean === "/") return `${DOCS_INTERNAL}/md/index`;
    if (clean === "/changelog" || clean.startsWith("/changelog/")) return `${DOCS_INTERNAL}/changelog.md`;
    return `${DOCS_INTERNAL}/md${clean}`;
  }
  return clean === "/" ? DOCS_INTERNAL : `${DOCS_INTERNAL}${clean}`;
}
