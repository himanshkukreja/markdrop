/**
 * A docs site's own files, outside the pages: its assets (`<content>/public/docs-assets/…`) and its
 * redirects (`<content>/redirects.json`). Plain ESM with no imports beyond node: so next.config.ts,
 * the route handler (app/docs-site/docs-assets), docs:check and the tests share one copy.
 *
 * Assets. The app's own public/ folder is served first (Markdrop's docs keep their media there);
 * a file it doesn't have is looked up in the site's `<content>/public/docs-assets/` (next.config.ts
 * rewrites the miss to the route handler, which calls `resolveAsset`). Hashed names (`x.3f9a1c2e.webp`)
 * are cached for a year; others for an hour.
 *
 * Redirects. `redirects.json` is a flat map, `{ "/old/path": "/new/path" }`. A page key also
 * answers its trailing-slash and `.md` addresses (`/old/path/` → `/new/path`, `/old/path.md` →
 * `/new/path.md`); a key written as `/x.md` maps that address alone. Targets are docs paths (an
 * optional #anchor) or https URLs. Served as 308s on the docs hosts before any page is resolved.
 */
import fs from "node:fs";
import path from "node:path";

/* ── assets ──────────────────────────────────────────────────────────────── */

export const ASSET_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  vtt: "text/vtt; charset=utf-8",
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  woff2: "font/woff2",
  woff: "font/woff",
};

export function contentTypeOf(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name))?.[1]?.toLowerCase();
  return (ext && ASSET_TYPES[ext]) || "application/octet-stream";
}

/** A name carrying a content hash (`logo.3f9a1c2e.png`, `clip-5d41402abc4b2a76.mp4`): it never changes. */
export function isHashedName(name) {
  return /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i.test(String(name));
}

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT = "public, max-age=3600, stale-while-revalidate=86400";

export function cacheControlOf(name) {
  return isHashedName(name) ? IMMUTABLE : SHORT;
}

/**
 * The file a `/docs-assets/<segments…>` request names under `publicDir` (the site's public folder),
 * or null: no `..`, `.`, empty or hidden segments, no slashes, backslashes or NUL inside a segment,
 * and, after symlinks, still inside `<publicDir>/docs-assets`. Only regular files.
 */
export function resolveAsset(publicDir, segments) {
  if (!publicDir || !Array.isArray(segments) || !segments.length || segments.length > 32) return null;
  for (const s of segments) {
    if (typeof s !== "string" || !s || s.length > 255 || s.startsWith(".") || /[/\\\0]/.test(s)) return null;
  }
  const root = path.resolve(publicDir, "docs-assets");
  const file = path.resolve(root, ...segments);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    if (!real.startsWith(realRoot + path.sep)) return null;
    const st = fs.statSync(real);
    return st.isFile() ? { file: real, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * `Range: bytes=…` → { start, end } (inclusive), "unsatisfiable", or null (no range, or one we
 * answer with the whole file: several ranges, a malformed header).
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) {
    const n = Number(m[2]);
    if (!n) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** A weak validator from size and modification time. */
export function etagOf(size, mtimeMs) {
  return `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

/* ── redirects ───────────────────────────────────────────────────────────── */

const isExternal = (t) => /^https:\/\//i.test(t);

/** "/a/b/" → "/a/b" (the root stays "/"). */
function trimSlash(p) {
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

/**
 * The redirects of a parsed redirects.json: [{ from, to }] with the trailing-slash and .md
 * variants added, explicit keys winning over generated ones. Plus every problem with the file's
 * shape (docs:check also checks that the targets exist).
 */
export function expandRedirects(map) {
  const problems = [];
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { redirects: [], problems: ['must be an object like { "/old/path": "/new/path" }'] };
  }
  const explicit = new Map();
  const generated = new Map();
  for (const [rawFrom, rawTo] of Object.entries(map)) {
    if (typeof rawFrom !== "string" || !rawFrom.startsWith("/") || rawFrom.startsWith("//")) {
      problems.push(`"${rawFrom}": the key must be a path starting with /`);
      continue;
    }
    if (/[?#\s]/.test(rawFrom)) {
      problems.push(`"${rawFrom}": the key must be a plain path (no query, #anchor or spaces)`);
      continue;
    }
    if (typeof rawTo !== "string" || !rawTo || !((rawTo.startsWith("/") && !rawTo.startsWith("//")) || isExternal(rawTo))) {
      problems.push(`"${rawFrom}": the target must be a docs path like /a/b or an https URL`);
      continue;
    }
    const from = trimSlash(rawFrom);
    if (from === "/") {
      problems.push(`"${rawFrom}": the home page can't be redirected`);
      continue;
    }
    const to = rawTo;
    if (trimSlash(to.split("#")[0]) === from) {
      problems.push(`"${rawFrom}": redirects to itself`);
      continue;
    }
    explicit.set(from, to);
    if (from.endsWith(".md")) continue;
    generated.set(`${from}/`, to);
    if (!isExternal(to)) {
      const p = trimSlash(to.split("#")[0]);
      generated.set(`${from}.md`, p === "/" ? "/index.md" : p.endsWith(".md") ? p : `${p}.md`);
    }
  }
  const out = new Map(generated);
  for (const [k, v] of explicit) out.set(k, v);
  return { redirects: [...out].map(([from, to]) => ({ from, to })), problems };
}

/** redirects.json of a content folder: { redirects, problems, missing }. */
export function readRedirects(contentDir) {
  const file = path.join(contentDir, "redirects.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { redirects: [], problems: [], missing: true };
  }
  try {
    return { ...expandRedirects(JSON.parse(raw)), missing: false };
  } catch (e) {
    return { redirects: [], problems: [`invalid JSON: ${e.message}`], missing: false };
  }
}

/** path-to-regexp treats these as syntax in a `source`; escape them so a path matches literally. */
export function escapeSource(p) {
  return p.replace(/[\\:()*+?{}]/g, (c) => `\\${c}`);
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A `has: [{ type: "host", value }]` pattern matching exactly these hosts. */
export function hostPattern(hosts) {
  const list = [...new Set(hosts)].filter(Boolean);
  return list.length === 1 ? escapeRegex(list[0]) : `(?:${list.map(escapeRegex).join("|")})`;
}

/**
 * Next.js `redirects()` entries for a content folder, limited to the docs hosts. 308 (permanent,
 * method kept). Empty without a redirects.json.
 */
export function nextRedirects(contentDir, hosts) {
  if (!hosts.some(Boolean)) return [];
  const { redirects } = readRedirects(contentDir);
  const has = [{ type: "host", value: hostPattern(hosts) }];
  return redirects.map(({ from, to }) => ({ source: escapeSource(from), destination: to, permanent: true, has }));
}

/** The docs hosts, as src/docs/host.ts computes them (next.config.ts can't import that module). */
export function docsHostsFromEnv(env = process.env) {
  const norm = (h) => {
    let s = String(h || "").trim().toLowerCase();
    if (s.startsWith("[")) return "";
    s = s.split(":")[0];
    while (s.endsWith(".")) s = s.slice(0, -1);
    return s;
  };
  return [norm(env.NEXT_PUBLIC_DOCS_HOST || "docs.markdrop.in"), "docs.localhost", ...String(env.NEXT_PUBLIC_DOCS_HOSTS || "").split(",").map(norm)].filter(Boolean);
}

/** True when a content folder ships its own assets (`<content>/public/docs-assets/`). */
export function hasSiteAssets(contentDir) {
  try {
    return fs.statSync(path.join(contentDir, "public", "docs-assets")).isDirectory();
  } catch {
    return false;
  }
}
