import { API_BASE } from "@/lib/api";

/**
 * Which workspace, if any, owns the host a request arrived on.
 *
 * Only ever returns a *verified* domain — the API refuses to resolve anything
 * else, so an unverified host can't influence what gets served.
 */
export interface HostResolution {
  host: string;
  workspace_id: string;
  /** What this host is allowed to serve. A declared behaviour, not a naming
   *  convention: `cdn.acme.com` may well be an "app" host. */
  kind: "app" | "cdn";
  site_name: string | null;
  favicon_url: string | null;
  logo_url: string | null;
  accent_color: string | null;
  hide_markdrop_branding: boolean;
  viewer_chrome: "full" | "minimal" | "none";
  require_auth_to_view: boolean;
}

/**
 * Resolve a host, server-side only.
 *
 * Cached through Next's data cache rather than looked up per request: this sits
 * in front of every request on a custom domain and the answer changes roughly
 * never. A miss costs one API call per host per minute, not per visitor.
 */
export async function resolveHost(host: string): Promise<HostResolution | null> {
  if (!host) return null;
  try {
    const res = await fetch(
      `${API_BASE}/api/v1/host?host=${encodeURIComponent(host)}`,
      { next: { revalidate: 60 } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // The endpoint answers `null` for an unknown or unverified host, which is
    // a 200 with a null body rather than an error.
    return data && data.workspace_id ? (data as HostResolution) : null;
  } catch {
    // An unreachable API must not take the page down with it; the caller
    // renders unbranded rather than failing.
    return null;
  }
}

/**
 * Resolve a host that is allowed to serve *documents*.
 *
 * Exists because the kind check has to hold in two places that run
 * independently — `generateMetadata` and the page component — and a guard
 * applied in only one of them leaks. It did: a cdn-kind host rendered a 404 in
 * the page while metadata had already fetched the document and embedded its
 * title and a body preview in the flight payload.
 *
 * Returning null for the wrong kind makes the safe path the only path, in the
 * same way `chrome_for` refuses to be called without its domain condition.
 */
export async function resolveAppHost(host: string): Promise<HostResolution | null> {
  const resolved = await resolveHost(host);
  if (!resolved || resolved.kind !== "app") return null;
  return resolved;
}
