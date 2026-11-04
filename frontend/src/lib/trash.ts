/**
 * Trash: every delete in the app moves the item to a 30-day trash (backend services/trash.py,
 * routers/trash.py). This is the client for it: list, restore, delete forever, the delete dialog's
 * preview and the trashed-link notice on the 404 page.
 *
 * Kept out of lib/api.ts (loaded by every public document page); the only imports are the API
 * base and the session token, so the 404 page can load it after mount without pulling in more.
 */
import { API_BASE, getToken } from "@/lib/api";

/** What a trash item is: a document's kind, or a folder (deleted with everything in it). */
export type TrashKind = "file" | "page" | "document" | "folder";

export interface TrashItem {
  /** What restore and delete-forever take: a document's slug, or a folder's id. */
  key: string;
  /** A folder's id (null on a document). */
  id: string | null;
  slug: string | null;
  /** Null when encrypted, or when `hidden` (an admin who can't read it). */
  title: string | null;
  kind: TrashKind;
  type_label: string | null;
  encrypted: boolean;
  /** "https://markdrop.in/<slug>" (null on a folder). */
  url: string | null;
  /** A workspace admin may restore it but can't read it: show "A private item". */
  hidden: boolean;
  where: {
    workspace: { id: string; name: string | null; exists: boolean } | null;
    folder: { id: string; name: string | null; path: string; exists: boolean; in_trash: boolean } | null;
    parent: { slug: string | null; title: string | null; exists: boolean } | null;
  };
  /** Sub-pages deleted with it (restored with it). */
  sub_pages: number;
  /** A folder: what went with it. */
  contents: { items: number; folders: number } | null;
  /** It went to the trash with a folder (or, on the link notice, with a parent page). */
  deleted_with?: { folder?: string | null; slug?: string | null; title?: string | null; key: string | null } | null;
  deleted_at: string;
  deleted_by: { id: string; name: string | null; is_you: boolean } | null;
  via: "web" | "mcp" | "api" | "edit secret" | string | null;
  restore_until: string | null;
  days_left: number;
  is_mine: boolean;
  can: { restore: boolean; delete_forever: boolean };
}

export interface TrashList {
  items: TrashItem[];
  days: number;
}

export interface RestoreResult {
  restored: true;
  key: string;
  slug: string | null;
  kind: TrashKind;
  title: string | null;
  url: string | null;
  items: Array<{ slug: string | null; title: string | null; kind: TrashKind }>;
  folders: number;
  /** Where it ended up when its old place is gone, in a sentence. */
  notes: string[];
}

export interface DeletePreview {
  slug: string;
  title: string | null;
  kind: "file" | "page" | "document";
  type_label: string | null;
  url: string;
  /** Direct sub-pages. */
  children: number;
  /** Every page below it. */
  descendants: number;
  days: number;
}

/** The days an item stays in the trash (the API says so on every list; this is the fallback). */
export const TRASH_DAYS = 30;

/** A refusal with its HTTP status (0 = the network). `message` is the server's `detail`. */
export class TrashApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TrashApiError";
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit & { secret?: string | null } = {}): Promise<T> {
  const { secret, ...rest } = init;
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...rest,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(secret ? { "x-edit-secret": secret } : {}),
        ...((rest.headers as Record<string, string>) ?? {}),
      },
    });
  } catch {
    throw new TrashApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown; error?: unknown } | null;
    const d = body?.detail;
    const message = typeof d === "string" ? d
      : d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string" ? (d as { message: string }).message
        : typeof body?.error === "string" ? body.error
          : res.status === 410 ? "It can't be restored any more."
            : `Request failed (${res.status})`;
    throw new TrashApiError(message, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const enc = encodeURIComponent;

/** What the signed-in person may restore, newest first (optionally one workspace's). */
export function listTrash(workspace?: string | null): Promise<TrashList> {
  const q = workspace ? `?workspace=${enc(workspace)}` : "";
  return call<TrashList>(`/api/v1/trash${q}`).then((r) => ({ items: r?.items ?? [], days: r?.days ?? TRASH_DAYS }));
}

/** Put it back where it was (a page with the sub-pages deleted with it, a folder with everything in it). */
export function restoreFromTrash(key: string, editSecret?: string | null): Promise<RestoreResult> {
  return call<RestoreResult>(`/api/v1/trash/${enc(key)}/restore`, { method: "POST", secret: editSecret });
}

/** Delete forever. Can't be undone. */
export function deleteForever(key: string, editSecret?: string | null): Promise<{ deleted: true; items: RestoreResult["items"] }> {
  return call(`/api/v1/trash/${enc(key)}`, { method: "DELETE", secret: editSecret });
}

/** The trash notice for a link: the item when the caller could edit it, else null (a 404 never says more). */
export async function trashLookup(slug: string, editSecret?: string | null): Promise<TrashItem | null> {
  try {
    return await call<TrashItem>(`/api/v1/trash/lookup/${enc(slug)}`, { secret: editSecret });
  } catch (e) {
    if (e instanceof TrashApiError && (e.status === 404 || e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

/** What deleting `slug` would take, for the delete dialog. 403/404 when the caller can't delete it. */
export function deletePreview(slug: string, editSecret?: string | null): Promise<DeletePreview> {
  return call<DeletePreview>(`/api/v1/documents/${enc(slug)}/delete-preview`, { secret: editSecret });
}

/** `DELETE /documents/{slug}`: to the trash. A page with sub-pages needs `children`. */
export function moveToTrash(slug: string, opts: { children?: "delete" | "lift"; secret?: string | null } = {}): Promise<void> {
  const q = opts.children ? `?children=${opts.children}` : "";
  return call<void>(`/api/v1/documents/${enc(slug)}${q}`, { method: "DELETE", secret: opts.secret });
}

/**
 * Drop the cached render of `/slug` (a deleted link must 404 at once, a restored one must come
 * back). Resolves when the purge answered, or after 1.5 s, so a navigation that follows sees it.
 */
export function purgeCached(slug: string | null | undefined): Promise<void> {
  if (!slug || typeof window === "undefined") return Promise.resolve();
  const req = fetch("/api/revalidate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  }).then(() => undefined, () => undefined);
  return Promise.race([req, new Promise<void>((r) => setTimeout(r, 1500))]);
}

/** "29 days left", "Last day". */
export function daysLeftLabel(days: number): string {
  if (days <= 1) return "Last day";
  return `${days} days left`;
}

/** An edit secret this tab kept for `slug` (an anonymous document's publisher), if any. */
export function storedSecret(slug: string): string | null {
  try {
    return sessionStorage.getItem(`secret:${slug}`);
  } catch {
    return null;
  }
}
