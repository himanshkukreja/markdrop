/**
 * The folder listing behind a tenant folder index (`/h/[host]/<folder path>`) and the tenant root.
 *
 * CONTRACT (implemented by the API; workspaces-v2 spec P1):
 *
 *   GET /api/v1/host/folder?host=<host>&path=<seg/seg>   (path "" = the site root)
 *   Public; optional auth (a session, or a tenant token of that workspace sent from its domain).
 *   200 {
 *     "folder":  { "name": "Onboarding", "path": ["handbook", "onboarding"] } | null,   // null at the root
 *     "trail":   [ { "name": "Handbook", "path": ["handbook"] } ],                       // ancestors, root first
 *     "folders": [ { "name": "Policies", "path": ["handbook", "policies"], "document_count": 3 } ],
 *     "documents": [ { "slug", "title", "kind", "type_label", "renderer", "mime",
 *                      "original_filename", "folder_path", "created_at", "updated_at",
 *                      "poster_url"?, "size_bytes"? } ]
 *   }
 *   404 when the host is not a live app host, no such folder exists, or the folder holds nothing
 *   the caller can read (and isn't explicitly shared) — structure is never revealed.
 *
 * Lists only what THIS caller could open: anonymous server renders get the public view; a signed-in
 * reader's browser asks again with its token (`fetchTenantFolderAsReader`) and may see more.
 * Links are always built from `folder_path` + `slug` on this host, never from a URL in the payload.
 */

import { API_BASE, getToken } from "@/lib/api";

export interface TenantFolderRef {
  name: string;
  path: string[];
  document_count?: number | null;
}

export interface TenantFolderDocument {
  slug: string;
  title: string | null;
  kind?: "markdown" | "artifact" | string | null;
  type_label?: string | null;
  renderer?: string | null;
  mime?: string | null;
  original_filename?: string | null;
  folder_path?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  poster_url?: string | null;
  size_bytes?: number | null;
}

export interface TenantFolderListing {
  folder: TenantFolderRef | null;
  trail: TenantFolderRef[];
  folders: TenantFolderRef[];
  documents: TenantFolderDocument[];
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const SLUG_RE = /^[A-Za-z0-9_-]+$/;

function ref(v: unknown): TenantFolderRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || !isStrArr(o.path)) return null;
  return { name: o.name, path: o.path, document_count: typeof o.document_count === "number" ? o.document_count : null };
}

/** Validate a `/host/folder` body. Null when malformed. Client- and server-safe. */
export function parseFolderListing(data: unknown): TenantFolderListing | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.documents)) return null;
  const documents = (o.documents as unknown[]).filter(
    (d): d is TenantFolderDocument =>
      !!d && typeof d === "object" && typeof (d as TenantFolderDocument).slug === "string"
      && SLUG_RE.test((d as TenantFolderDocument).slug),
  );
  return {
    folder: ref(o.folder),
    trail: Array.isArray(o.trail) ? (o.trail.map(ref).filter(Boolean) as TenantFolderRef[]) : [],
    folders: Array.isArray(o.folders) ? (o.folders.map(ref).filter(Boolean) as TenantFolderRef[]) : [],
    documents,
  };
}

/**
 * Browser only: the listing as the signed-in reader sees it (their token on this domain is a
 * tenant token). Null when signed out, refused, or unavailable — callers keep what they had.
 */
export async function fetchTenantFolderAsReader(host: string, path: string[]): Promise<TenantFolderListing | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const q = new URLSearchParams({ host, path: path.join("/") });
    const res = await fetch(`${API_BASE}/api/v1/host/folder?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return parseFolderListing(await res.json().catch(() => null));
  } catch {
    return null;
  }
}
