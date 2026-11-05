/**
 * Typed page properties and folder databases (backend routers/page_db.py):
 *
 *   GET   /workspaces/{ws}/folders/{folder}/database     schema, views, readable rows (viewer+)
 *   PUT   /workspaces/{ws}/folders/{folder}/properties   the schema (members, admins)
 *   PUT   /workspaces/{ws}/folders/{folder}/views        saved views (members, admins)
 *   GET   /documents/{slug}/properties                   a page's panel, for this reader
 *   PATCH /documents/{slug}/properties                   set values (the page's own save path)
 */
import { API_BASE, getToken } from "@/lib/api";
import type { DbRow, Person, PropDef, PropValue, SavedView } from "./model.mjs";

export class PropsApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit & { secret?: string | null }): Promise<T> {
  const { secret, ...rest } = init ?? {};
  const t = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...rest,
      headers: {
        ...(typeof rest.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
        ...(secret ? { "x-edit-secret": secret } : {}),
      },
    });
  } catch {
    throw new PropsApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const d = body?.detail;
    const msg = typeof d === "string" ? d : d && typeof d === "object" && typeof (d as { detail?: unknown }).detail === "string" ? String((d as { detail: string }).detail) : `Request failed (${res.status})`;
    throw new PropsApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export interface LinkInfo {
  state: "ok" | "locked" | "missing";
  title?: string;
  slug?: string;
  url?: string;
  kind?: string;
  icon?: string | null;
  icon_url?: string | null;
}

/** A page's panel (GET /documents/{slug} carries it as `page_properties`). */
export interface PagePropertiesInfo {
  folder: { id: string; name: string } | null;
  mode: "row" | "template" | null;
  properties: PropDef[];
  rev: number;
  values: Record<string, PropValue>;
  people: Record<string, Person>;
  people_hidden: boolean;
  links: Record<string, LinkInfo>;
  can_edit_schema: boolean;
}

export interface FolderDatabase {
  folder: { id: string; name: string };
  properties: PropDef[];
  views: SavedView[];
  rev: number;
  rows: DbRow[];
  truncated: boolean;
  people: Record<string, Person>;
  links: Record<string, LinkInfo>;
  can_edit_schema: boolean;
  role: string | null;
}

/** `rows: false`: the schema and saved views alone (the folder's List view needs no rows). */
export function getFolderDatabase(workspaceId: string, folderId: string, opts?: { rows?: boolean }) {
  return call<FolderDatabase>(`/api/v1/workspaces/${enc(workspaceId)}/folders/${enc(folderId)}/database${opts?.rows === false ? "?rows=false" : ""}`);
}

export function putFolderProperties(workspaceId: string, folderId: string, properties: PropDef[], baseRev?: number | null, views?: SavedView[]) {
  return call<{ folder_id: string; properties: PropDef[]; views: SavedView[]; rev: number }>(
    `/api/v1/workspaces/${enc(workspaceId)}/folders/${enc(folderId)}/properties`,
    { method: "PUT", body: JSON.stringify({ properties, ...(views ? { views } : {}), ...(typeof baseRev === "number" ? { base_rev: baseRev } : {}) }) },
  );
}

/** `baseRev`: the folder's properties rev these views were read at (409 when someone saved since). */
export function putFolderViews(workspaceId: string, folderId: string, views: SavedView[], baseRev?: number | null) {
  return call<{ folder_id: string; properties: PropDef[]; views: SavedView[]; rev: number }>(
    `/api/v1/workspaces/${enc(workspaceId)}/folders/${enc(folderId)}/views`,
    { method: "PUT", body: JSON.stringify({ views, ...(typeof baseRev === "number" ? { base_rev: baseRev } : {}) }) },
  );
}

/**
 * The views list after replaying the change `from` → `to` (views added, removed or changed, by id)
 * onto `fresh`: someone else's view changes made meanwhile stay (fix/collab-audit).
 */
export function replayViews(from: SavedView[], to: SavedView[], fresh: SavedView[]): SavedView[] {
  const before = new Map(from.map((v) => [v.id, JSON.stringify(v)]));
  const after = new Map(to.map((v) => [v.id, v]));
  let out = fresh.filter((v) => !before.has(v.id) || after.has(v.id));
  out = out.map((v) => {
    const mine = after.get(v.id);
    return mine && before.get(v.id) !== JSON.stringify(mine) ? mine : v;
  });
  for (const v of to) if (!before.has(v.id) && !out.some((x) => x.id === v.id)) out.push(v);
  return out;
}

export function getPageProperties(slug: string, secret?: string | null) {
  return call<{ page_properties: PagePropertiesInfo | null }>(`/api/v1/documents/${enc(slug)}/properties`, { secret });
}

export function patchPageProperties(slug: string, values: Record<string, PropValue | null>, baseRev?: number | null, secret?: string | null) {
  return call<{ slug: string; rev: number; values: Record<string, PropValue>; page_properties: PagePropertiesInfo | null }>(
    `/api/v1/documents/${enc(slug)}/properties`,
    { method: "PATCH", secret, body: JSON.stringify({ values, ...(typeof baseRev === "number" ? { base_rev: baseRev } : {}) }) },
  );
}

/** Workspace members to pick (GET /workspaces/{ws}/members/search: members only, ≤20). */
export function searchMembers(workspaceId: string, q: string) {
  return call<Array<{ id: string; name: string; avatar_url?: string | null }>>(`/api/v1/workspaces/${enc(workspaceId)}/members/search?q=${enc(q)}`);
}

/** Pages to link (the workspace's items the caller can read, by title). */
export async function searchPages(workspaceId: string, q: string): Promise<Array<{ slug: string; title: string; icon?: string | null }>> {
  const p = new URLSearchParams({ folder: "all", limit: "12", kind: "markdown" });
  if (q.trim()) p.set("q", q.trim());
  const r = await call<{ items: Array<{ slug: string; title: string | null; icon?: string | null; encrypted?: boolean }> }>(`/api/v1/workspaces/${enc(workspaceId)}/items?${p}`);
  return r.items.filter((i) => !i.encrypted && i.slug).map((i) => ({ slug: i.slug, title: i.title || i.slug, icon: i.icon ?? null }));
}
