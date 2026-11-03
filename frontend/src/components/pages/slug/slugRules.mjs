/**
 * A page's link (its slug), as the API's rules have it (backend utils/slug.py, services/document
 * new_slug_problem): 3-50 letters, digits, - or _, not one of Markdrop's own top-level routes. The
 * API is the judge (taken, folder clash, someone's deleted link); this is what the dialog can say
 * before asking it. No imports: node --test runs it as is.
 */

export const SLUG_RE = /^[A-Za-z0-9_-]{3,50}$/;

/** Markdrop's own routes (utils/slug.py RESERVED_SLUGS): never a document's link. */
export const RESERVED = new Set([
  "admin", "share", "auth", "api", "login", "logout", "signup", "dashboard", "me", "new", "health",
  "settings", "account", "about", "terms", "privacy", "_next", "static", "artifacts", "artifact",
  "upload", "builder", "h", "enterprise", "invite", "extension", "dev-preview", "dev-kit-frames",
  "dev-kit-publish", "dev-reading", "fonts", "email", "mcp", "oauth", "f", "w", "mdp", "shared",
  "recent", "requests", "guides", "docs-studio", "d",
]);

/** What's wrong with `value` as a link, in a sentence; null when the API should be asked. */
export function slugProblem(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return "Type a link.";
  if (/[^A-Za-z0-9_-]/.test(v)) return "Use only letters, numbers, hyphens (-) or underscores (_).";
  if (v.length < 3) return "Use at least 3 characters.";
  if (v.length > 50) return "Use at most 50 characters.";
  if (RESERVED.has(v.toLowerCase())) return "That link is one of Markdrop's own pages. Choose another.";
  return null;
}

/** What someone typed or pasted, as a link candidate: spaces become hyphens, a pasted URL its last part. */
export function cleanSlugInput(raw) {
  let v = typeof raw === "string" ? raw : "";
  if (/^https?:\/\//i.test(v.trim()) || v.includes("/")) {
    const parts = v.trim().replace(/[?#].*$/, "").split("/").filter(Boolean);
    v = parts.length ? parts[parts.length - 1] : "";
  }
  return v.replace(/\s+/g, "-").slice(0, 60);
}

/** A link made from a page's title ("Q3 PRD: Search" → "q3-prd-search"); "" when nothing usable is left. */
export function slugFromTitle(title) {
  const s = (typeof title === "string" ? title : "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "")
    .slice(0, 50).replace(/-$/, "");
  return s.length >= 3 ? s : "";
}

/**
 * Split a full link into what comes before the slug and the slug itself, for the input's prefix:
 * "https://docs.acme.com/product-hub/templates/prd" → { base: "docs.acme.com/product-hub/templates/", slug: "prd" }.
 */
export function splitLink(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const slug = segs.length ? decodeURIComponent(segs[segs.length - 1]) : "";
    const before = segs.slice(0, -1).map((s) => decodeURIComponent(s));
    return { host: u.host, folders: before, base: `${u.host}/${before.map((s) => `${s}/`).join("")}`, slug };
  } catch {
    return { host: "", folders: [], base: "", slug: "" };
  }
}

/** The input's prefix: the whole base when it fits, else the host, an ellipsis and the last folder. */
export function shortBase(base, max = 30) {
  if (typeof base !== "string" || base.length <= max) return base || "";
  const [host, ...rest] = base.replace(/\/$/, "").split("/");
  const last = rest.length ? rest[rest.length - 1] : "";
  const short = last ? `${host}/…/${last}/` : `${host}/`;
  return short.length <= max + 12 ? short : `…/${last}/`;
}
