/**
 * A docs site's own assets: `/docs-assets/<path>` read from `<content>/public/docs-assets/<path>`.
 *
 * Reached only through next.config.ts's afterFiles rewrite, which fires only on the docs hosts for
 * a file the app's public/ doesn't have (so Markdrop's own media is still served as static files,
 * and a missing one gets the plain 404 below, not the app's 404 page). Paths are confined to that
 * folder (siteFiles.resolveAsset); Range requests are answered so Safari can play clips; hashed
 * names are cached for a year, others for an hour.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CONTENT_DIR } from "@/docs/content";
import { isDocsHost } from "@/docs/host";
import { normalizeHost } from "@/components/tenant/hosts";
import { cacheControlOf, contentTypeOf, etagOf, parseRange, resolveAsset } from "@/docs/siteFiles.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC = path.join(CONTENT_DIR, "public");
/** The app's own public/ is served by Next itself; never read it through here. */
const APP_PUBLIC = path.join(process.cwd(), "public");

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function serve(req: Request, params: Promise<{ path: string[] }>, head: boolean): Promise<Response> {
  if (!isDocsHost(normalizeHost(req.headers.get("host"))) || path.resolve(PUBLIC) === path.resolve(APP_PUBLIC)) return notFound();
  const { path: segments } = await params;
  // Next hands the segments over decoded; a name with a literal %xx may still arrive encoded.
  let decoded: string[] | null = null;
  try {
    decoded = segments.map((s) => decodeURIComponent(s));
  } catch {
    decoded = null;
  }
  const hit = resolveAsset(PUBLIC, segments) ?? (decoded ? resolveAsset(PUBLIC, decoded) : null);
  if (!hit) return notFound();
  const name = path.basename(hit.file);
  const type = contentTypeOf(name);
  const etag = etagOf(hit.size, hit.mtimeMs);
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": cacheControlOf(name),
    etag,
    "last-modified": new Date(hit.mtimeMs).toUTCString(),
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  };
  // An SVG opened on its own runs no script; anything we can't name downloads instead of rendering.
  if (type === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if (type === "application/octet-stream") headers["content-disposition"] = "attachment";

  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const range = parseRange(req.headers.get("range"), hit.size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${hit.size}` } });
  const start = range ? range.start : 0;
  const end = range ? range.end : hit.size - 1;
  const length = hit.size === 0 ? 0 : end - start + 1;
  const status = range ? 206 : 200;
  const out = { ...headers, "content-length": String(length), ...(range ? { "content-range": `bytes ${start}-${end}/${hit.size}` } : {}) };
  if (head || length === 0) return new Response(null, { status, headers: out });
  const stream = Readable.toWeb(fs.createReadStream(hit.file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers: out });
}

export function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return serve(req, params, false);
}

export function HEAD(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return serve(req, params, true);
}
