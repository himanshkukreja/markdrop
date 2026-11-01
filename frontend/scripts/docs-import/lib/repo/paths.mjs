/**
 * Repo paths for the GitHub import (pure, posix): repo-relative paths without a leading or
 * trailing slash ("" = the repo root), page addresses the API accepts, and asset names the runner
 * uploads (docs-platform/runner/lib.mjs importFileAllowed).
 */

/** "a/./b//c/" → "a/b/c"; null when it climbs out of the root, is absolute, or has a NUL/backslash. */
export function normRepoPath(p) {
  const s = String(p ?? "");
  if (s.includes("\0") || s.includes("\\") || s.startsWith("/")) return null;
  const out = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return null;
    out.push(seg);
  }
  return out.join("/");
}

/** The folder of a repo path ("a/b.md" → "a", "b.md" → ""). */
export const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
/** The last segment. */
export const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);
/** Without its extension. */
export const stemOf = (name) => name.replace(/\.[^./]+$/, "");
/** The lower-case extension, without the dot. */
export const extOf = (name) => (/\.([^./]+)$/.exec(name)?.[1] ?? "").toLowerCase();

/**
 * Resolves `rel` (a link in the file `from`; "/x" starts at `root`) to a repo path. Never escapes the
 * repo: a path that climbs above the root is null.
 */
export function resolveRepo(from, rel, root = "") {
  let r = String(rel ?? "");
  try {
    r = decodeURI(r);
  } catch {
    /* keep it as written */
  }
  if (r.includes("\0") || r.includes("\\")) return null;
  const base = r.startsWith("/") ? root : dirOf(from);
  const parts = base ? base.split("/") : [];
  for (const seg of r.replace(/^\/+/, "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** Whether `p` is `dir` or inside it ("" holds everything). */
export const within = (p, dir) => !dir || p === dir || p.startsWith(dir + "/");
/** `p` relative to `dir` (p must be within dir). */
export const relTo = (p, dir) => (!dir ? p : p === dir ? "" : p.slice(dir.length + 1));
/** Joins repo path parts, skipping empty ones. */
export const joinRepo = (...parts) => normRepoPath(parts.filter(Boolean).join("/")) ?? "";

/** "getting_started-guide" → "Getting started guide". */
export function humanize(name) {
  const s = String(name ?? "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** Docusaurus-style number prefixes: "01-intro" → "intro", "2. Setup" → "Setup". */
export const stripNumberPrefix = (s) => String(s).replace(/^\d+\s*[-_.]+\s*(?=\S)/, "");
/** The number prefix of a name, or null. */
export const numberPrefix = (s) => {
  const m = /^(\d+)\s*[-_.]/.exec(String(s));
  return m ? Number(m[1]) : null;
};

/** One page-address segment: lowercase letters, digits and single hyphens ("page" when nothing is left). */
export function pathSegment(s) {
  const t = String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return t.slice(0, 60).replace(/-+$/, "") || "page";
}

/**
 * First segments the guide answers itself (backend docs_site_pages / editor pagePath.ts
 * RESERVED_FIRST), with the word an imported page uses instead.
 */
export const RESERVED_FIRST = new Map([
  ["docs-assets", "assets"], ["mcp", "mcp-docs"], ["md", "md-docs"], ["og", "og-docs"], ["changelog", "release-notes"],
  ["api-reference-json", "api-json"], ["public", "public-docs"], ["api-reference", "api-ref"], ["node-modules", "modules"], ["video-scenes", "scenes"],
]);

/**
 * Segments → a page address the API accepts: "/" or up to 6 segments of [a-z0-9-], 200 chars at most,
 * never starting with a reserved word. Deeper addresses fold their extra segments into the last.
 */
export function pagePath(segments) {
  let segs = segments.filter((s) => s !== "" && s != null).map(pathSegment);
  if (!segs.length) return "/";
  if (segs.length > 6) segs = [...segs.slice(0, 5), segs.slice(5).join("-").slice(0, 60).replace(/-+$/, "")];
  if (RESERVED_FIRST.has(segs[0])) segs[0] = RESERVED_FIRST.get(segs[0]);
  segs = segs.map((s, i) => (i > 0 && s === "video-scenes" ? "scenes" : s));
  let p = "/" + segs.join("/");
  if (p.length > 200) p = p.slice(0, 200).replace(/[-/]+$/, "");
  return p;
}

/** A unique page address: `/x`, then `/x-2`, `/x-3`… */
export function uniquePath(p, used) {
  if (!used.has(p)) {
    used.add(p);
    return p;
  }
  for (let n = 2; ; n++) {
    const q = p === "/" ? `/home-${n}` : `${p}-${n}`;
    if (!used.has(q)) {
      used.add(q);
      return q;
    }
  }
}

/** The runner's rule for an uploaded file's path segments. */
export const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,199}$/;

/** One asset path segment that SAFE_SEGMENT accepts. */
export function assetSegment(s) {
  const t = String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9_]+/, "")
    .replace(/-+/g, "-")
    .slice(0, 120);
  return t || "file";
}

/**
 * `<id>/<repo path, each segment made safe>` with the extension `ext` (by the file's bytes), at most 8
 * segments in all (the runner's limit): deeper folders fold into one. `taken` keeps names unique.
 */
export function assetRel(repoPath, ext, { id = "import", taken = new Set(), suffix = "" } = {}) {
  const segs = repoPath.split("/").filter(Boolean);
  const name = segs.pop() ?? "file";
  let dirs = segs.map(assetSegment);
  if (dirs.length > 6) dirs = [...dirs.slice(0, 5), dirs.slice(5).join("-").slice(0, 120)];
  const stem = assetSegment(stemOf(name)).replace(/\.+$/, "").slice(0, 100) || "file";
  const make = (n) => [id, ...dirs, `${stem}${n > 1 ? `-${n}` : ""}${suffix}.${ext}`].join("/");
  let rel = make(1);
  for (let n = 2; taken.has(rel); n++) rel = make(n);
  taken.add(rel);
  return rel;
}

/** Folders the folder picker never suggests from (anything under them), at any depth. */
export const IGNORED_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".next", "site-packages"]);

/**
 * Whether a repo file may be read at all: nothing under node_modules, no hidden segment except
 * GitBook's `.gitbook/assets/…` and a `.gitbook.yaml` file.
 */
export function repoPathAllowed(p) {
  const segs = p.split("/");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === "node_modules") return false;
    if (s.startsWith(".")) {
      if (i === segs.length - 1 && (s === ".gitbook.yaml" || s === ".mintignore")) continue;
      if (s === ".gitbook" && segs[i + 1] === "assets" && i + 2 < segs.length) continue;
      return false;
    }
  }
  return true;
}
