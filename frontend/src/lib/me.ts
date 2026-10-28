/**
 * The signed-in person's cross-workspace lists (simpler UI): Shared with me, Recent, quick search
 * (⌘K) and access requests. Every list is already filtered by the server through its access rules
 * (`can()` / `readable_filter`); the UI never filters for privacy itself.
 *
 * Kept out of lib/api.ts for the same reason lib/workspaces.ts is: none of it is reachable without a
 * session, and lib/api.ts loads on every public document page.
 */
import { request, type ItemAccess, type WorkspaceItem } from "@/lib/workspaces";

/** A row of Shared with me / Recent: shaped like a workspace item, plus how the caller got it. */
export interface PersonalItem extends Omit<WorkspaceItem, "can" | "folder"> {
  can?: Partial<WorkspaceItem["can"]>;
  folder?: WorkspaceItem["folder"];
  /** The workspace it is filed in, when it is. */
  workspace?: { id: string; name: string } | null;
  /** Shared with me: what the email grant gives. */
  role?: "viewer" | "editor" | null;
  /** Shared with me: when it was shared. */
  granted_at?: string | null;
  /** Shared with me: granted in the last 7 days and not opened yet. */
  new?: boolean;
  /** Shared with me: the caller has opened it. */
  opened?: boolean;
  /** Recent: when the caller last opened it. */
  viewed_at?: string | null;
}

export interface SharedPage {
  items: PersonalItem[];
  next_cursor: string | null;
  /** Granted in the last 7 days and not yet opened. */
  new_count: number;
}

/** `GET /me/shared` — documents shared with the caller by email (not their own), newest grant first. */
export async function listSharedWithMe(cursor?: string | null): Promise<SharedPage> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const r = await request<Partial<SharedPage>>(`/api/v1/me/shared${q}`);
  return { items: r.items ?? [], next_cursor: r.next_cursor ?? null, new_count: r.new_count ?? 0 };
}

/** `GET /me/recent` — the last 30 things the caller opened, re-checked at read time. */
export async function listRecent(): Promise<PersonalItem[]> {
  const r = await request<{ items?: PersonalItem[] }>("/api/v1/me/recent");
  return r.items ?? [];
}

// ── Quick search (⌘K) ─────────────────────────────────────────────────────────

export interface QuickFile {
  slug: string;
  title: string | null;
  kind: "markdown" | "artifact" | string;
  mime?: string | null;
  url?: string | null;
  access?: ItemAccess;
  workspace?: { id: string; name: string } | null;
  folder?: { id: string; name: string; path?: string } | null;
  /** "mine" | "workspace" | "shared": where it was found. */
  source?: string | null;
  encrypted?: boolean;
}

export interface QuickResults {
  files: QuickFile[];
  folders: Array<{ id: string; name: string; path?: string; workspace: { id: string; name: string } }>;
  workspaces: Array<{ id: string; name: string; role?: string }>;
}

/** `GET /search/quick?q=&limit=` — titles only, at least 2 characters, readable rows only. */
export async function quickSearch(q: string, limit = 8, signal?: AbortSignal): Promise<QuickResults> {
  const p = new URLSearchParams({ q, limit: String(limit) });
  const r = await request<Partial<QuickResults>>(`/api/v1/search/quick?${p}`, { signal });
  return { files: r.files ?? [], folders: r.folders ?? [], workspaces: r.workspaces ?? [] };
}

// ── Access requests ───────────────────────────────────────────────────────────

export type RequestStatus = "pending" | "approved" | "declined";
export type RequestDecision = "view" | "edit" | "decline";

/** One request, as its owner sees it (`/me/access-requests`, `/access-requests/{id}`). */
export interface AccessRequest {
  id: string;
  status: RequestStatus;
  message: string | null;
  created_at: string;
  decided_at: string | null;
  role_granted: "viewer" | "editor" | null;
  requester: { email: string; name: string | null };
  document: { slug: string; title: string | null; kind: string; encrypted: boolean; access: ItemAccess; url: string };
}

/** The caller's own standing on a document they were refused (`…/access-requests/mine`). Asked only
 *  once the page has reached "denied": the read itself never says, so it isn't an existence oracle. */
export interface MyRequestState {
  can_request_access: boolean;
  request_pending: boolean;
  request: { id: string; status: RequestStatus; created_at: string; decided_at: string | null } | null;
}

export const myAccessRequest = (slug: string) =>
  request<MyRequestState>(`/api/v1/documents/${encodeURIComponent(slug)}/access-requests/mine`);

/** `POST /documents/{slug}/access-requests` — signed in, and only when the read was denied.
 *  409: already pending (or now readable); 403: a password gate; 404: like a missing document. */
export const requestAccess = (slug: string, message?: string) =>
  request<{ id: string; status: RequestStatus }>(`/api/v1/documents/${encodeURIComponent(slug)}/access-requests`, {
    method: "POST",
    body: JSON.stringify(message?.trim() ? { message: message.trim().slice(0, 500) } : {}),
  });

/** `GET /me/access-requests?status=` — requests on documents the caller owns. */
export async function listAccessRequests(status: RequestStatus | "all" = "pending"): Promise<{ requests: AccessRequest[]; pending_count: number }> {
  const r = await request<{ requests?: AccessRequest[]; pending_count?: number }>(`/api/v1/me/access-requests?status=${status}`);
  return { requests: r.requests ?? [], pending_count: r.pending_count ?? 0 };
}

/** `GET /access-requests/{id}` — the document's owner only (404 otherwise). */
export const getAccessRequest = (id: string) => request<AccessRequest>(`/api/v1/access-requests/${encodeURIComponent(id)}`);

/** `POST /access-requests/{id}/decision` — owner only. The same decision twice is a no-op; a
 *  different second decision is 409. */
export const decideAccessRequest = (id: string, decision: RequestDecision) =>
  request<{ id: string; status: RequestStatus; role_granted: "viewer" | "editor" | null; decided_at: string | null }>(
    `/api/v1/access-requests/${encodeURIComponent(id)}/decision`,
    { method: "POST", body: JSON.stringify({ decision }) },
  );

export const requestTitle = (r: AccessRequest) => (r.document.encrypted ? r.document.slug : r.document.title || r.document.slug);
export const requesterName = (r: AccessRequest) => r.requester.name || r.requester.email;
