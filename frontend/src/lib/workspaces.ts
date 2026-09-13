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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers || {}) },
  });
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
    throw new Error(message);
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
  hide_markdrop_branding: boolean;
}

export interface WorkspaceSettings {
  viewer_chrome: ViewerChrome;
  require_auth_to_view: boolean;
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
  member_count: number;
  pending_invite_count: number;
  domain_count: number;
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
  status: "pending" | "verified" | "failed";
  created_at: string;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  attached: boolean;
  dns_record_name: string;
  dns_record_type: string;
  dns_record_value: string;
  dns_target_name: string;
  dns_target_type: string;
  dns_target_value: string;
  warning: string | null;
}

export interface Folder {
  id: string;
  workspace_id: string;
  name: string;
  parent_id: string | null;
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

export const renameFolder = (id: string, folderId: string, name: string) =>
  request<Folder>(`/api/v1/workspaces/${id}/folders/${folderId}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });

export const deleteFolder = (id: string, folderId: string) =>
  request<{ unfiled_documents: number }>(`/api/v1/workspaces/${id}/folders/${folderId}`, {
    method: "DELETE",
  });

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

/** Share a document you own. Everyone in the workspace can then read it, and
 *  members and admins can edit it — the UI must say so before calling this. */
export const shareToWorkspace = (id: string, documentId: string, folderId?: string | null) =>
  request<MyDocListItem>(`/api/v1/workspaces/${id}/documents`, {
    method: "POST",
    body: JSON.stringify({ document_id: documentId, folder_id: folderId ?? null }),
  });

/** Unshare. The document itself is untouched and returns to its owner. */
export const unshareFromWorkspace = (id: string, documentId: string) =>
  request<void>(`/api/v1/workspaces/${id}/documents/${documentId}`, { method: "DELETE" });

export const fileDocument = (id: string, documentId: string, folderId: string | null) =>
  request<void>(`/api/v1/workspaces/${id}/documents/${documentId}/folder`, {
    method: "PUT",
    body: JSON.stringify({ folder_id: folderId }),
  });

/** Roles that can act, by capability. Mirrors ROLE_RANK on the server — the UI
 *  hides what the API would refuse, rather than inventing its own rules. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const can = (role: Role | undefined, required: Role) =>
  role !== undefined && ROLE_RANK[role] >= ROLE_RANK[required];
