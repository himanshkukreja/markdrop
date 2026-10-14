/**
 * The folder listing behind a tenant folder index (`/h/[host]/<folder path>`) and the tenant root.
 *
 * PROPOSED CONTRACT (the API does not serve this yet; see the S11 report, needs_from_others):
 *
 *   GET /api/v1/host/folder?host=<host>&path=<seg/seg>   (path "" = the site root)
 *   200 {
 *     "folder":  { "name": "Onboarding", "path": ["handbook", "onboarding"] } | null,   // null at the root
 *     "trail":   [ { "name": "Handbook", "path": ["handbook"] } ],                       // ancestors, root first
 *     "folders": [ { "name": "Policies", "path": ["handbook", "policies"], "document_count": 3 } ],
 *     "documents": [ { "slug", "title", "kind", "type_label", "renderer", "mime",
 *                      "original_filename", "folder_path", "created_at", "updated_at" } ]
 *   }
 *   404 when the host is not a verified app host or no such folder exists.
 *
 * Public and anonymous, like `/host`: it must list only what a signed-out reader could open
 * (no private, workspace-only, password-protected or encrypted documents; nothing when the
 * workspace requires sign-in to view), so a title never leaks through an index.
 *
 * Until it exists every call returns null, and the page falls back exactly as before (a folder
 * path is a 404; the root shows the site's name and how to open a document).
 */

import { API_BASE } from "@/lib/api";

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
}

export interface TenantFolderListing {
  folder: TenantFolderRef | null;
  trail: TenantFolderRef[];
  folders: TenantFolderRef[];
  documents: TenantFolderDocument[];
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function ref(v: unknown): TenantFolderRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || !isStrArr(o.path)) return null;
  return { name: o.name, path: o.path, document_count: typeof o.document_count === "number" ? o.document_count : null };
}

/** Server-side only. Null when the listing is unavailable, unknown, or malformed. */
export async function getTenantFolder(host: string, path: string[]): Promise<TenantFolderListing | null> {
  try {
    const q = new URLSearchParams({ host, path: path.join("/") });
    const res = await fetch(`${API_BASE}/api/v1/host/folder?${q}`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown> | null;
    if (!data || !Array.isArray(data.documents)) return null;
    const documents = (data.documents as unknown[]).filter(
      (d): d is TenantFolderDocument =>
        !!d && typeof d === "object" && typeof (d as TenantFolderDocument).slug === "string",
    );
    return {
      folder: ref(data.folder),
      trail: Array.isArray(data.trail) ? (data.trail.map(ref).filter(Boolean) as TenantFolderRef[]) : [],
      folders: Array.isArray(data.folders) ? (data.folders.map(ref).filter(Boolean) as TenantFolderRef[]) : [],
      documents,
    };
  } catch {
    return null;
  }
}
