/**
 * Workspace, domain, member and folder API.
 *
 * Kept out of lib/api.ts: that module is loaded by every public document page,
 * and none of this is reachable without a session.
 */
import { API_BASE, type MyDocListItem, type MyDocListResponse } from "@/lib/api";

const TOKEN_KEY = "markdrop_token";

function authHeaders(): Record<string, string> {
  const t = typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** An API refusal that keeps its HTTP status, so screens can tell "not built yet" (404/405/501)
 *  from "not allowed" (403) from an outage (0 / 5xx). `message` is the server's `detail`. */
export class WsApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WsApiError";
    this.status = status;
  }
}

/** The status of a failed call (0 for a network error or anything that isn't a WsApiError). */
export const errorStatus = (e: unknown): number => (e instanceof WsApiError ? e.status : 0);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers || {}) },
    });
  } catch {
    throw new WsApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    // FastAPI validation errors arrive as a list of objects; surfacing "[object
    // Object]" to a user is worse than saying nothing useful at all.
    const detail = body?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail[0]?.msg || "That value isn't valid."
          : `Request failed (${res.status})`;
    throw new WsApiError(message, res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Role = "owner" | "admin" | "member" | "viewer";
export type DomainKind = "app" | "cdn";
export type ViewerChrome = "full" | "minimal" | "none";

export interface Branding {
  site_name: string | null;
  favicon_url: string | null;
  logo_url: string | null;
  accent_color: string | null;
  /** D38: the well a customer logo sits on; absent/null = follow the theme. */
  logo_well?: "light" | "dark" | "checker" | null;
  hide_markdrop_branding: boolean;
}

export interface WorkspaceSettings {
  viewer_chrome: ViewerChrome;
  require_auth_to_view: boolean;
  /** v2: members (not only admins) may share folders. Absent on older backends (= true). */
  members_can_share_folders?: boolean;
}

/** v2 `GET /workspaces` item domain summary. */
export interface WorkspaceDomainSummary {
  host: string;
  verified: boolean;
  primary: boolean;
  live: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  branding: Branding;
  settings: WorkspaceSettings;
  role: Role;
  /** So the settings header is correct without fetching three collections. */
  /** The workspace's own document host, when it has a verified one. */
  primary_host: string | null;
  member_count: number;
  pending_invite_count: number;
  domain_count: number;
  /** v2: the workspace's domains in brief (absent on older backends). */
  domains?: WorkspaceDomainSummary[];
  /** v2: who can open a document published into this workspace, unless the author says otherwise. */
  default_access?: "private" | "link" | "workspace";
}

export interface Member {
  user_id: string;
  role: Role;
  email: string | null;
  name: string | null;
  created_at: string;
}

export interface Domain {
  id: string;
  host: string;
  kind: DomainKind;
  /** "lapsed" (v2, S3): verified once, then failed re-checks for 72 h; no longer serving. */
  status: "pending" | "verified" | "failed" | "lapsed";
  created_at: string;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  attached: boolean;
  is_primary: boolean;
  dns_record_name: string;
  dns_record_type: string;
  dns_record_value: string;
  dns_target_name: string;
  dns_target_type: string;
  dns_target_value: string;
  warning: string | null;
  /** v2 (S3), optional until the backend sends them: which of the two records the last check saw. */
  txt_ok?: boolean | null;
  routing_ok?: boolean | null;
  /** v2 (S3): consecutive failed re-checks. */
  failures?: number | null;
  /** v2: verified, attached and not lapsed — the domain is serving. */
  live?: boolean;
  /** v2 (T4): false when we can't tell whether the host is an apex; then every option is shown. */
  apex_certain?: boolean;
  dns_routing_options?: Array<{ type: string; name: string; value: string }>;
  /** Pending claims only: when the unverified claim is dropped. */
  expires_at?: string | null;
}

export interface Folder {
  id: string;
  workspace_id: string;
  name: string;
  parent_id: string | null;
  /** URL segment, and the full path from the root. A document filed here is
   *  addressed at `/<path...>/<slug>` on the workspace's own domain. */
  slug: string;
  path: string[];
  created_at: string;
  updated_at: string;
}

// ── Workspaces ────────────────────────────────────────────────────────────────

export const listWorkspaces = () =>
  request<{ workspaces: Workspace[] }>("/api/v1/workspaces").then((r) => r.workspaces);

export const createWorkspace = (name: string) =>
  request<Workspace>("/api/v1/workspaces", { method: "POST", body: JSON.stringify({ name }) });

export const getWorkspace = (id: string) => request<Workspace>(`/api/v1/workspaces/${id}`);

/** Delete a workspace. Owner only, and the exact name must be typed back.
 *  Shared documents are released to their owners, never deleted. */
export const deleteWorkspace = (id: string, confirmName: string) =>
  request<{ documents_released: number; domains_removed: number; members_removed: number }>(
    `/api/v1/workspaces/${id}`,
    { method: "DELETE", body: JSON.stringify({ confirm_name: confirmName }) }
  );

export const updateWorkspace = (
  id: string,
  data: { name?: string; branding?: Branding; settings?: WorkspaceSettings }
) => request<Workspace>(`/api/v1/workspaces/${id}`, { method: "PUT", body: JSON.stringify(data) });

// ── Members ───────────────────────────────────────────────────────────────────

export const listMembers = (id: string) =>
  request<{ members: Member[] }>(`/api/v1/workspaces/${id}/members`).then((r) => r.members);

export const setMemberRole = (id: string, userId: string, role: Exclude<Role, "owner">) =>
  request<void>(`/api/v1/workspaces/${id}/members/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });

export const removeMember = (id: string, userId: string) =>
  request<void>(`/api/v1/workspaces/${id}/members/${userId}`, { method: "DELETE" });

// ── Invitations ───────────────────────────────────────────────────────────────
//
// There is no "add member" call. Joining a workspace is the invitee's decision,
// so it always goes through an invitation they have to accept.

export type InviteStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: InviteStatus;
  created_at: string;
  expires_at: string;
  invited_by_name: string | null;
  responded_at: string | null;
}

export interface InvitePreview {
  workspace_name: string;
  role: Role;
  email: string;
  invited_by_name: string | null;
  status: InviteStatus;
  expires_at: string;
  signed_in_as: string | null;
  email_matches: boolean;
  already_member: boolean;
  /** D27: optional workspace branding for the invite card (absent on older backends). */
  logo_url?: string | null;
  accent_color?: string | null;
  logo_well?: "light" | "dark" | "checker" | null;
}

export const listInvitations = (id: string) =>
  request<{ invitations: Invitation[] }>(`/api/v1/workspaces/${id}/invitations`).then(
    (r) => r.invitations
  );

export const inviteMember = (id: string, email: string, role: Exclude<Role, "owner">) =>
  request<Invitation>(`/api/v1/workspaces/${id}/invitations`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });

export const revokeInvitation = (id: string, inviteId: string) =>
  request<void>(`/api/v1/workspaces/${id}/invitations/${inviteId}`, { method: "DELETE" });

export const previewInvite = (token: string) =>
  request<InvitePreview>(`/api/v1/invites/${encodeURIComponent(token)}`);

export const acceptInvite = (token: string) =>
  request<{ workspace_id: string; workspace_name: string; role: Role }>(
    `/api/v1/invites/${encodeURIComponent(token)}/accept`,
    { method: "POST" }
  );

export const declineInvite = (token: string) =>
  request<void>(`/api/v1/invites/${encodeURIComponent(token)}/decline`, { method: "POST" });

// ── Branding assets ───────────────────────────────────────────────────────────

/** Upload a favicon or logo. The server re-encodes it to PNG and returns the
 *  hosted URL; it is not saved onto the workspace until the form is submitted. */
export async function uploadBrandingAsset(
  id: string,
  kind: "favicon" | "logo",
  file: File
): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`${API_BASE}/api/v1/workspaces/${id}/branding/${kind}`, {
    method: "POST",
    // No Content-Type: the browser has to set the multipart boundary itself.
    headers: authHeaders(),
    body,
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(typeof b?.detail === "string" ? b.detail : "Upload failed");
  }
  return (await res.json()).url as string;
}

// ── Domains ───────────────────────────────────────────────────────────────────

export const listDomains = (id: string) =>
  request<{ domains: Domain[] }>(`/api/v1/workspaces/${id}/domains`).then((r) => r.domains);

export interface DnsProviderHint {
  detected: boolean;
  provider_id: string | null;
  provider_name: string | null;
  panel_url: string | null;
  host_field: string | null;
  record_host: string | null;
  target_host: string | null;
  note: string | null;
  nameservers: string[];
}

/** Who runs this domain's DNS, so the setup steps can use their wording.
 *  Costs a live DNS lookup, so it is fetched only while the steps are shown. */
export const dnsProviderHint = (id: string, domainId: string) =>
  request<DnsProviderHint>(`/api/v1/workspaces/${id}/domains/${domainId}/provider`);

export const addDomain = (id: string, host: string, kind: DomainKind) =>
  request<Domain>(`/api/v1/workspaces/${id}/domains`, {
    method: "POST",
    body: JSON.stringify({ host, kind }),
  });

export const verifyDomain = (id: string, domainId: string) =>
  request<Domain>(`/api/v1/workspaces/${id}/domains/${domainId}/verify`, { method: "POST" });

export const attachDomain = (id: string, domainId: string) =>
  request<Domain>(`/api/v1/workspaces/${id}/domains/${domainId}/attach`, { method: "POST" });

/** Take a verified domain off the air, keeping its verification so it can be
 *  re-attached without another round of DNS. */
export const detachDomain = (id: string, domainId: string) =>
  request<Domain>(`/api/v1/workspaces/${id}/domains/${domainId}/detach`, { method: "POST" });

export const removeDomain = (id: string, domainId: string) =>
  request<void>(`/api/v1/workspaces/${id}/domains/${domainId}`, { method: "DELETE" });

// ── Folders ───────────────────────────────────────────────────────────────────

export const listFolders = (id: string) =>
  request<{ folders: Folder[] }>(`/api/v1/workspaces/${id}/folders`).then((r) => r.folders);

export const createFolder = (id: string, name: string, parentId?: string | null) =>
  request<Folder>(`/api/v1/workspaces/${id}/folders`, {
    method: "POST",
    body: JSON.stringify({ name, parent_id: parentId ?? null }),
  });

/** Choose the domain this workspace is addressed by: the host on preview cards
 *  and in the links the library hands out. */
export const setPrimaryDomain = (id: string, domainId: string) =>
  request<void>(`/api/v1/workspaces/${id}/domains/${domainId}/primary`, { method: "PUT" });

export const renameFolder = (id: string, folderId: string, name: string) =>
  request<Folder>(`/api/v1/workspaces/${id}/folders/${folderId}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });

/** Delete a folder. Nothing in it is deleted. `unfile` (the original behaviour): documents directly
 *  inside go to the workspace root, subfolders move up one level. `move_up`: everything moves up
 *  into the parent folder. Omitted = the server's default (unfile). */
export const deleteFolder = (id: string, folderId: string, mode?: "unfile" | "move_up") =>
  request<{ unfiled_documents: number }>(
    `/api/v1/workspaces/${id}/folders/${folderId}${mode ? `?mode=${mode}` : ""}`,
    { method: "DELETE" }
  );

// ── Shared library ────────────────────────────────────────────────────────────
//
// A document is private until its owner shares it here. Nothing in this API can
// surface a document that was never shared: the listing matches on workspace_id,
// which a private document does not have.

export const listLibrary = (
  id: string,
  opts: { page?: number; limit?: number; q?: string; kind?: string; folderId?: string | null; unfiled?: boolean } = {}
) => {
  const p = new URLSearchParams();
  p.set("page", String(opts.page ?? 1));
  p.set("limit", String(opts.limit ?? 20));
  if (opts.q) p.set("q", opts.q);
  if (opts.kind) p.set("kind", opts.kind);
  if (opts.folderId) p.set("folder_id", opts.folderId);
  if (opts.unfiled) p.set("unfiled", "true");
  return request<MyDocListResponse>(`/api/v1/workspaces/${id}/documents?${p}`);
};

export const libraryCounts = (id: string) =>
  request<Record<string, number>>(`/api/v1/workspaces/${id}/documents/counts`);

/**
 * Drop the cached render of a document whose folder just moved.
 *
 * Filing changes the document's canonical URL, and the cached copy still names
 * the old one — so the new address redirects back to the old address until the
 * entry expires a minute later. That minute is the whole of the "I moved it but
 * the link doesn't work yet" complaint, and it is entirely avoidable: we know
 * the moment it moved.
 *
 * Best-effort. A failure costs a minute of staleness, never correctness, so it
 * must not fail the move that prompted it.
 */
export function purgeDocument(slug: string | null | undefined): void {
  if (!slug) return;
  fetch("/api/revalidate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  }).catch(() => {});
}

/** Share a document you own. Everyone in the workspace can then read it, and
 *  members and admins can edit it — the UI must say so before calling this. */
export const shareToWorkspace = async (
  id: string, documentId: string, folderId?: string | null, slug?: string | null
) => {
  const doc = await request<MyDocListItem>(`/api/v1/workspaces/${id}/documents`, {
    method: "POST",
    body: JSON.stringify({ document_id: documentId, folder_id: folderId ?? null }),
  });
  purgeDocument(slug ?? doc?.slug);
  return doc;
};

/** Unshare. The document itself is untouched and returns to its owner. */
export const unshareFromWorkspace = async (id: string, documentId: string, slug?: string | null) => {
  await request<void>(`/api/v1/workspaces/${id}/documents/${documentId}`, { method: "DELETE" });
  purgeDocument(slug);
};

export const fileDocument = async (
  id: string, documentId: string, folderId: string | null, slug?: string | null
) => {
  await request<void>(`/api/v1/workspaces/${id}/documents/${documentId}/folder`, {
    method: "PUT",
    body: JSON.stringify({ folder_id: folderId }),
  });
  purgeDocument(slug);
};

/** Roles that can act, by capability. Mirrors ROLE_RANK on the server — the UI
 *  hides what the API would refuse, rather than inventing its own rules. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const can = (role: Role | undefined, required: Role) =>
  role !== undefined && ROLE_RANK[role] >= ROLE_RANK[required];

// ── v2: tree, items, batch moves, folder sharing ──────────────────────────────
//
// Contracts from specs/workspaces-v2-spec.md ("New / changed API contracts"). Every listing is
// already filtered by the server to what the caller can open (A1, D2): the UI never filters for
// privacy itself, it only hides controls the `can` flags say would be refused.

/** One folder in `GET /workspaces/{id}/tree`. */
export interface TreeFolder {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  /** Slugs from the root, joined: "guides/q3". */
  path: string;
  depth: number;
  /** Items filed directly here that the caller can open. */
  item_count: number;
  /** Items in this folder and every folder under it that the caller can open. */
  total_count: number;
  share: { id: string; level: FolderShareLevel } | null;
}

export interface WorkspaceTree {
  workspace: { id: string; name: string; role: Role; primary_host: string | null };
  folders: TreeFolder[];
  /** Items at the workspace root (in no folder). */
  unfiled_count: number;
}

export const getWorkspaceTree = (id: string) =>
  request<WorkspaceTree>(`/api/v1/workspaces/${encodeURIComponent(id)}/tree`);

export type ItemAccess = "private" | "link" | "workspace";

/** One row of `GET /workspaces/{id}/items`. */
export interface WorkspaceItem {
  id?: string | null;
  slug: string;
  title: string | null;
  kind: "markdown" | "artifact";
  mime?: string | null;
  /** Canonical: the custom-domain URL when the workspace has a live primary domain. */
  url: string;
  markdrop_url: string;
  access: ItemAccess;
  has_password: boolean;
  folder: { id: string; name: string; path: string } | null;
  owner: { name: string | null; is_you: boolean };
  size_bytes?: number | null;
  updated_at: string;
  created_at?: string | null;
  views?: number | null;
  can: { edit: boolean; move: boolean; unshare: boolean; delete: boolean; share: boolean };
  /** Optional extras some backends send; used for nicer tiles when present. */
  renderer?: string | null;
  original_filename?: string | null;
  encrypted?: boolean;
}

/**
 * A row an admin may see but not read: someone's private document filed in the workspace. Only
 * who owns it and an opaque handle (to remove it from the workspace) come back.
 */
export interface RedactedItem {
  redacted: true;
  id_token: string;
  owner: { name: string | null; is_you?: boolean };
  folder?: { id: string; name: string; path: string } | null;
  updated_at?: string | null;
  can: Partial<WorkspaceItem["can"]>;
}

export interface ItemsPage {
  items: WorkspaceItem[];
  /** Admin-only placeholders for private documents they can't open (see RedactedItem). */
  redacted: RedactedItem[];
  next_cursor: string | null;
}

/** `folder`: a folder id, "root" (filed at the top), "unfiled" or "all". */
export const listWorkspaceItems = async (
  id: string,
  opts: { folder: string; q?: string; kind?: string; cursor?: string | null; limit?: number }
): Promise<ItemsPage> => {
  const p = new URLSearchParams({ folder: opts.folder });
  if (opts.q) p.set("q", opts.q);
  if (opts.kind) p.set("kind", opts.kind);
  if (opts.cursor) p.set("cursor", opts.cursor);
  p.set("limit", String(opts.limit ?? 50));
  const r = await request<{ items: Array<WorkspaceItem | RedactedItem>; next_cursor: string | null }>(
    `/api/v1/workspaces/${encodeURIComponent(id)}/items?${p}`
  );
  const rows = r.items ?? [];
  const isRedacted = (x: WorkspaceItem | RedactedItem): x is RedactedItem => (x as RedactedItem).redacted === true || !(x as WorkspaceItem).slug;
  return {
    items: rows.filter((x): x is WorkspaceItem => !isRedacted(x)),
    redacted: rows.filter(isRedacted).filter((x) => !!x.id_token),
    next_cursor: r.next_cursor ?? null,
  };
};

/** Rename and/or move a folder (move = `parent_id`; null = the top level). Admins only. */
export const updateFolder = (
  id: string,
  folderId: string,
  data: { name?: string; slug?: string; parent_id?: string | null }
) =>
  request<unknown>(`/api/v1/workspaces/${encodeURIComponent(id)}/folders/${encodeURIComponent(folderId)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });

function purgeAll(slugs: string[]) {
  for (const s of slugs) purgeDocument(s);
}

/** Batch move (drag and drop, "Move to…"). `folderId` null = the workspace root. */
export const moveItems = async (id: string, slugs: string[], folderId: string | null) => {
  const r = await request<{ items?: WorkspaceItem[] }>(`/api/v1/workspaces/${encodeURIComponent(id)}/items/move`, {
    method: "POST",
    body: JSON.stringify({ slugs, folder_id: folderId }),
  });
  purgeAll(slugs);
  return r;
};

/** File documents you own into the workspace (D1: the same document, not a copy). Access changes
 *  only when `access` is given. */
export const addItems = async (id: string, slugs: string[], folderId: string | null, access?: ItemAccess) => {
  const r = await request<{ items?: WorkspaceItem[] }>(`/api/v1/workspaces/${encodeURIComponent(id)}/items/add`, {
    method: "POST",
    body: JSON.stringify({ slugs, folder_id: folderId, ...(access ? { access } : {}) }),
  });
  purgeAll(slugs);
  return r;
};

/** `slug` is null for a row removed by its redacted handle (the caller never learns it). */
export interface RemovedItem { slug: string | null; access_after: ItemAccess }

/** Take documents out of the workspace (unshare). A `workspace`-level document becomes private;
 *  `access_after` says what each one is now. */
export const removeItems = async (id: string, slugs: string[], handles: string[] = []): Promise<RemovedItem[]> => {
  const r = await request<{ items?: RemovedItem[] } | RemovedItem[] | null>(
    `/api/v1/workspaces/${encodeURIComponent(id)}/items/remove`,
    { method: "POST", body: JSON.stringify(handles.length ? { slugs, handles } : { slugs }) }
  );
  purgeAll(slugs);
  return Array.isArray(r) ? r : r?.items ?? [];
};

/**
 * Put a document you own into a workspace folder with a given access, preferring the v2
 * `items/add` call and falling back to the v1 share + level calls on a backend without it
 * (404/405), so publishing keeps working while the two deploy in either order.
 */
export async function fileIntoWorkspace(
  id: string,
  doc: { slug: string; id?: string | null },
  folderId: string | null,
  access?: ItemAccess
): Promise<void> {
  try {
    await addItems(id, [doc.slug], folderId, access);
    return;
  } catch (e) {
    // Only a backend without the route falls back: FastAPI's own 404 says exactly "Not Found";
    // items/add's 404s ("There's no document … of yours", "Folder not found") are real answers.
    const s = errorStatus(e);
    const missingRoute = s === 405 || (s === 404 && e instanceof Error && e.message === "Not Found");
    if (!missingRoute || !doc.id) throw e;
  }
  await shareToWorkspace(id, doc.id!, folderId, doc.slug);
  if (access) await setLevel(doc.slug, access);
}

async function setLevel(slug: string, level: ItemAccess) {
  await request<void>(`/api/v1/documents/${encodeURIComponent(slug)}/access/level`, {
    method: "PUT",
    body: JSON.stringify({ level }),
  });
  purgeDocument(slug);
}

// ── Folder sharing (D2: a folder link shows only what each viewer can already open) ──────────

export type FolderShareLevel = "link" | "workspace";

export interface FolderShare {
  share_id: string;
  url: string;
  level: FolderShareLevel;
  /** Items in the folder's subtree a signed-out visitor couldn't open (for level=link). */
  hidden_count: number;
  hidden: Array<{ slug: string; title: string | null; access: ItemAccess; has_password?: boolean; is_yours?: boolean }>;
  /** Optional: how many items the subtree holds in all (for "N of M"). */
  total_count?: number;
}

export const shareFolder = (id: string, folderId: string, level: FolderShareLevel) =>
  request<FolderShare>(`/api/v1/workspaces/${encodeURIComponent(id)}/folders/${encodeURIComponent(folderId)}/share`, {
    method: "PUT",
    body: JSON.stringify({ level }),
  });

/** The folder's current share, or null when it isn't shared (`GET …/share`, viewer+). Read-only:
 *  opening the dialog must not re-share (a PUT rewrites the share and purges caches). */
export const getFolderShare = async (id: string, folderId: string): Promise<FolderShare | null> => {
  try {
    return await request<FolderShare>(
      `/api/v1/workspaces/${encodeURIComponent(id)}/folders/${encodeURIComponent(folderId)}/share`
    );
  } catch (e) {
    if (errorStatus(e) === 404) return null;
    throw e;
  }
};

export const unshareFolder = (id: string, folderId: string) =>
  request<void>(`/api/v1/workspaces/${encodeURIComponent(id)}/folders/${encodeURIComponent(folderId)}/share`, {
    method: "DELETE",
  });

/** Make documents you own open to anyone with the link (the folder dialog's "Open up the K you
 *  own"): `POST /documents/access/level` in chunks of 200 → `{results:[{slug, ok}]}`. Falls back to
 *  one call per document on a backend without the batch route. Returns the slugs that failed. */
export const openUpToLink = async (slugs: string[]): Promise<string[]> => {
  const failed: string[] = [];
  for (let i = 0; i < slugs.length; i += 200) {
    const chunk = slugs.slice(i, i + 200);
    try {
      const r = await request<{ results: Array<{ slug: string; ok: boolean }> }>("/api/v1/documents/access/level", {
        method: "POST",
        body: JSON.stringify({ slugs: chunk, level: "link" }),
      });
      const done = new Set<string>();
      for (const row of r.results ?? []) {
        done.add(row.slug);
        if (row.ok) purgeDocument(row.slug);
        else failed.push(row.slug);
      }
      for (const s of chunk) if (!done.has(s)) failed.push(s);
    } catch (e) {
      const s = errorStatus(e);
      if (s !== 404 && s !== 405) { failed.push(...chunk); continue; }
      for (const slug of chunk) {
        try {
          await setLevel(slug, "link");
        } catch {
          failed.push(slug);
        }
      }
    }
  }
  return failed;
};

/**
 * `GET /folders/shared/{share_id}?path=` (public). Server renders call it anonymously; the
 * browser calls it again with the session (`token`) so members see what they can open. Returns
 * the status rather than throwing, because 401 (sign in) and 404 are pages, not errors; a 5xx or
 * network failure throws.
 */
export async function fetchSharedFolder(
  shareId: string,
  path: string,
  token?: string | null,
  /** Server renders only: the signed `X-Markdrop-Internal` header (components/tenant/server.ts). */
  extraHeaders?: Record<string, string>,
): Promise<{ status: 200; data: SharedFolderPage } | { status: 401 | 403 | 404; data: null }> {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`${API_BASE}/api/v1/folders/shared/${encodeURIComponent(shareId)}${q}`, {
    cache: "no-store",
    headers: { ...(extraHeaders ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.ok) return { status: 200, data: (await res.json()) as SharedFolderPage };
  if (res.status === 401 || res.status === 403 || res.status === 404) return { status: res.status, data: null };
  throw new WsApiError(`Folder request failed (${res.status})`, res.status);
}

/** The public folder page's data (`GET /folders/shared/{share_id}`). */
export interface SharedFolderPage {
  workspace: { name: string; branding?: Partial<Branding> | null };
  folder: { name: string; path: string; breadcrumbs: Array<{ name: string; path: string }> };
  subfolders: Array<{ name: string; path: string; count: number }>;
  items: Array<{
    slug: string; title: string | null; kind: "markdown" | "artifact" | string; mime?: string | null;
    url: string; size_bytes?: number | null; updated_at?: string | null; poster_url?: string | null;
  }>;
}
