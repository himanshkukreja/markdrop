/**
 * Server-side data for pages on a workspace's own domain. SERVER ONLY (node:crypto, the shared
 * secret): imported by `app/h/[host]/**` server components and route handlers, never by a client
 * component.
 *
 * Two things the generic `lib/api` helpers can't do for tenant pages:
 *
 *  - **Sign the request** (`X-Markdrop-Internal`). Every reader of every custom domain reaches the
 *    API from the same few Vercel egress addresses, so per-IP limits counted them as one visitor
 *    and a busy domain got 429s. A request signed with the secret shared with the API
 *    (`MARKDROP_INTERNAL_SECRET`, or `INTERNAL_API_SECRET`) is exempt. The signature covers a
 *    10-minute window, not a timestamp, because headers are part of Next's fetch-cache key.
 *  - **Tell "not there" from "couldn't ask".** A 429 or 5xx used to become a 404 ("Nothing at this
 *    address") for a document that exists. Here they throw `TenantUnavailable`, which the route's
 *    error boundary renders as a retryable error page.
 */

import { createHmac } from "crypto";
import { unstable_cache } from "next/cache";
import { API_BASE, documentTag, type DocumentResponse } from "@/lib/api";
import type { HostResolution } from "@/lib/hostResolution";
import type { TenantFolderListing } from "./folderIndex";
import { parseFolderListing } from "./folderIndex";

const WINDOW_SECONDS = 600;
/** Pages may be cached for this long; the API's answers are re-fetched at most this often. */
const REVALIDATE = 60;

/**
 * Cache tags the API's revalidate outbox purges (`app/api/revalidate/route.ts`):
 * `host:<host>` when a domain is verified / lapses / is removed or its branding changes,
 * `wsl:<workspaceId>` when anything a folder listing shows changes.
 */
export const hostTag = (host: string) => `host:${host}`;
export const listingTag = (workspaceId: string) => `wsl:${workspaceId}`;

/** A transient failure talking to the API (network, 429, 5xx). Never a 404. */
export class TenantUnavailable extends Error {
  status: number;
  constructor(status: number) {
    super(`The site couldn't be loaded right now (${status || "network"}).`);
    this.name = "TenantUnavailable";
    this.status = status;
  }
}

function secret(): string {
  return process.env.MARKDROP_INTERNAL_SECRET || process.env.INTERNAL_API_SECRET || "";
}

/** `X-Markdrop-Internal` for this 10-minute window, or nothing when no secret is configured. */
export function internalHeaders(now: number = Date.now()): Record<string, string> {
  const s = secret();
  if (!s) return {};
  const bucket = Math.floor(now / 1000 / WINDOW_SECONDS);
  const mac = createHmac("sha256", s).update(`markdrop-internal.v1.${bucket}`).digest("hex");
  return { "x-markdrop-internal": `v1.${bucket}.${mac}` };
}

function transient(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

async function apiFetch(path: string, init: RequestInit) {
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...internalHeaders() },
    });
  } catch {
    throw new TenantUnavailable(0);
  }
}

/** What a cached API answer keeps: enough to tell ok / moved / gate / missing apart. */
interface Answer {
  status: number;
  gate: string | null;
  moved: boolean;
  body: unknown;
}

/**
 * One API answer, cached for `REVALIDATE` seconds under `tags` — whatever its status (B-N3).
 *
 * Not the fetch cache: Next only stores 200 responses there, so once a document narrowed (its
 * API answer turned into a 401 gate or a 404) the old 200 stayed in the cache and kept being
 * served stale-while-revalidate on these force-dynamic pages — indefinitely if the purge for it
 * was missed. Caching the *result* instead lets a gate or a 404 replace the 200 within one
 * revalidation window even when every purge fails. A transient failure (network, 429, 5xx) throws
 * and is never cached: the previous answer keeps being served until the API answers again.
 */
function cachedAnswer(
  key: string[],
  path: string,
  headers: Record<string, string>,
  tags: string[],
  isTransient: (status: number) => boolean = transient,
): Promise<Answer> {
  const load = async (): Promise<Answer> => {
    // no-store: inside unstable_cache the fetch cache is bypassed anyway; said explicitly.
    const res = await apiFetch(path, { headers, cache: "no-store" });
    if (isTransient(res.status)) throw new TenantUnavailable(res.status);
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (res.ok && body === null) throw new TenantUnavailable(res.status);
    return {
      status: res.status,
      gate: res.headers.get("x-markdrop-gate"),
      moved: res.headers.has("x-markdrop-moved"),
      body,
    };
  };
  return unstable_cache(load, ["tenant-api-v1", ...key], { revalidate: REVALIDATE, tags })();
}

/**
 * Which workspace serves this host, for documents. Null for an unknown, unverified, lapsed or
 * cdn-kind host (the page is a 404). Throws `TenantUnavailable` when the API can't be asked.
 */
export async function resolveTenantHost(host: string): Promise<HostResolution | null> {
  if (!host) return null;
  // Cached whatever the answer: a host that stops resolving (lapsed, removed) must stop serving
  // within a revalidation window even if its purge is missed (B-N3).
  const res = await cachedAnswer(["host", host], `/api/v1/host?host=${encodeURIComponent(host)}`, {}, [hostTag(host)]);
  if (res.status < 200 || res.status >= 300) return null;
  const data = res.body as HostResolution | null;
  if (!data || !data.workspace_id || data.kind !== "app") return null;
  return data;
}

/** The same, never throwing: for metadata and chrome, which must not take the page down. */
export async function resolveTenantHostQuietly(host: string): Promise<HostResolution | null> {
  try {
    return await resolveTenantHost(host);
  } catch {
    return null;
  }
}

interface MovedBody {
  moved: boolean;
  slug: string;
  folder_path: unknown[];
}

export type TenantDocResult =
  | { status: "ok"; doc: DocumentResponse }
  /** The slug was renamed: the document now answers at `/<folder_path…>/<slug>`. */
  | { status: "moved"; slug: string; folder_path: string[] }
  | { status: "password" }
  | { status: "signin" }
  | { status: "missing" };

/**
 * One document as an anonymous reader of this workspace's domain sees it (scoped to the
 * workspace, so a host only ever resolves its own documents). Cached for a minute under the
 * document's tag, so a refile or an access change purges it with the markdrop.in render.
 */
export async function fetchTenantDocument(slug: string, workspaceId: string): Promise<TenantDocResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug)) return { status: "missing" };
  const res = await cachedAnswer(
    ["doc", slug, workspaceId],
    `/api/v1/documents/${slug}`,
    { "x-markdrop-workspace": workspaceId },
    [documentTag(slug)],
  );
  if (res.status >= 200 && res.status < 300) {
    const body = res.body as (DocumentResponse & Partial<MovedBody>) | null;
    // A renamed slug answers with where the document lives now (only to callers who may read it).
    if (body && (body.moved === true || res.moved)
        && typeof body.slug === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.slug)) {
      const folders = Array.isArray(body.folder_path)
        ? body.folder_path.filter((s): s is string => typeof s === "string" && s.length > 0)
        : [];
      return { status: "moved", slug: body.slug, folder_path: folders };
    }
    if (!body) throw new TenantUnavailable(res.status);
    return { status: "ok", doc: body as DocumentResponse };
  }
  if (res.status === 404) return { status: "missing" };
  if (res.status === 401) {
    return res.gate === "signin" ? { status: "signin" } : { status: "password" };
  }
  if (res.status === 403) return { status: "password" };
  return { status: "missing" };
}

/** The workspace requires sign-in to view anything (`/host/folder` answered 401 + signin gate). */
export const FOLDER_SIGNIN = "signin" as const;

/**
 * A folder of this host's workspace as an anonymous reader may see it (`GET /api/v1/host/folder`,
 * contract in `folderIndex.ts`). Null when there is nothing to show (404: no such folder, or none
 * of it is readable); `FOLDER_SIGNIN` when the workspace requires sign-in to view. Throws
 * `TenantUnavailable` on a transient failure.
 */
export async function fetchTenantFolder(
  host: string,
  path: string[],
  workspaceId: string,
): Promise<TenantFolderListing | typeof FOLDER_SIGNIN | null> {
  const q = new URLSearchParams({ host, path: path.join("/") });
  // Anonymous view only (no credentials on a server render), so it may be shared; purged with
  // the workspace's listings and with the host — and, like documents, a 404 or a sign-in gate
  // replaces a cached listing on its own within a revalidation window (B-N3).
  const res = await cachedAnswer(
    ["folder", host, path.join("/"), workspaceId],
    `/api/v1/host/folder?${q}`,
    {},
    [listingTag(workspaceId), hostTag(host)],
    (status) => transient(status) && status !== 501,
  );
  if (res.status < 200 || res.status >= 300) {
    if (res.status === 401 && res.gate === "signin") return FOLDER_SIGNIN;
    return null;
  }
  return parseFolderListing(res.body);
}

/** The folder listing, or null on any failure: for metadata only. */
export async function fetchTenantFolderQuietly(
  host: string,
  path: string[],
  workspaceId: string,
): Promise<TenantFolderListing | null> {
  try {
    const r = await fetchTenantFolder(host, path, workspaceId);
    return r === FOLDER_SIGNIN ? null : r;
  } catch {
    return null;
  }
}
