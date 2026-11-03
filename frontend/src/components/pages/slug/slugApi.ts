/**
 * A page's link: `GET /documents/{slug}/slug-check` (may it move to this slug, and the links it
 * would then have) and `PATCH /documents/{slug}/slug` (lib/api changeSlug: the rename itself; the
 * old slug keeps redirecting). Both for whoever may rename it (its owner, or the edit secret).
 */
import { API_BASE, changeSlug, getToken } from "@/lib/api";

export type SlugCheckCode = null | "same" | "invalid" | "reserved" | "taken" | "folder";

export interface SlugCheck {
  /** The slug asked about. */
  slug: string;
  /** The page's slug now. */
  current: string;
  available: boolean;
  code: SlugCheckCode;
  /** Why not, in the API's words. */
  detail: string | null;
  /** The link it would have: its workspace's domain (folders, parent pages) when filed, else markdrop.in. */
  url: string;
  markdrop_url: string;
  workspace_url: string | null;
  /** Its old slugs, which already redirect to it. */
  redirects_from: string[];
}

export class SlugApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SlugApiError";
    this.status = status;
  }
}

export async function checkSlug(slug: string, newSlug: string, opts: { secret?: string | null; signal?: AbortSignal } = {}): Promise<SlugCheck> {
  const t = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/documents/${encodeURIComponent(slug)}/slug-check?new_slug=${encodeURIComponent(newSlug)}`, {
      cache: "no-store",
      signal: opts.signal,
      headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(opts.secret ? { "x-edit-secret": opts.secret } : {}) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new SlugApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new SlugApiError(typeof body?.detail === "string" ? body.detail : `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as SlugCheck;
}

/** Rename, then purge the cached renders of both links (the old one becomes a redirect). */
export async function renameSlug(slug: string, newSlug: string, secret?: string | null): Promise<string> {
  const doc = await changeSlug(slug, newSlug, secret || undefined);
  const now = doc.slug || newSlug;
  for (const s of [slug, now]) {
    fetch("/api/revalidate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: s }) }).catch(() => {});
  }
  return now;
}
