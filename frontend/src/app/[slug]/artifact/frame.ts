import type { ArtifactRenderer } from "@/lib/api";

/**
 * Renderers whose `artifact_url` is the raw file (`/r/<key>`): the user's own HTML, a zipped
 * site's entry page, an image. They are written for white, so they sit on white "paper" with
 * `color-scheme: light` in both themes (REVAMP_PLAN 5.4). Everything else is a Worker viewer
 * page (`/v/<renderer>/<key>`) that follows `?theme=`.
 */
export function isPaper(renderer: ArtifactRenderer): boolean {
  return renderer === "html" || renderer === "bundle" || renderer === "image";
}

/**
 * The iframe `src`: the API's URL plus `theme=<resolved app theme>` for Worker viewer pages.
 *
 * Built with the URL API, never by concatenation: a private artifact's URL already carries a
 * signed `?t=`, and `…?t=abc?theme=dark` would break its HMAC (403). Raw `/r/` files get no
 * theme (the Worker never forwards it there, and it would only add a cache variant). A Worker
 * that predates R34 ignores the parameter, so this is harmless before it ships.
 */
export function themedFrameSrc(artifactUrl: string, theme: "dark" | "light"): string {
  try {
    const u = new URL(artifactUrl);
    if (!u.pathname.startsWith("/v/")) return artifactUrl;
    u.searchParams.set("theme", theme);
    return u.toString();
  } catch {
    return artifactUrl;
  }
}

/** "Oct 12", or "Oct 12, 2025" outside the current year. Client only (reader's zone). */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** The path segments before the slug in a public URL ("https://docs.acme.com/a/b/slug" → "/a/b/"). */
export function basePathOf(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    parts.pop();
    return "/" + parts.map((p) => p + "/").join("");
  } catch {
    return "/";
  }
}

/** "docs.acme.com/a/b/" for the Link field's prefix: the actual host, never a hard-coded one. */
export function linkPrefixOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + basePathOf(url);
  } catch {
    return "markdrop.in/";
  }
}
