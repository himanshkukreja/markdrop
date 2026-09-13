/**
 * Workspace, domain, member and folder API.
 *
 * Kept out of lib/api.ts: that module is loaded by every public document page,
 * and none of this is reachable without a session.
 */
import { API_BASE } from "@/lib/api";

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

export const updateWorkspace = (
  id: string,
  data: { name?: string; branding?: Branding; settings?: WorkspaceSettings }
) => request<Workspace>(`/api/v1/workspaces/${id}`, { method: "PUT", body: JSON.stringify(data) });

// ── Members ───────────────────────────────────────────────────────────────────

export const listMembers = (id: string) =>
  request<{ members: Member[] }>(`/api/v1/workspaces/${id}/members`).then((r) => r.members);

export const addMember = (id: string, email: string, role: Exclude<Role, "owner">) =>
  request<Member>(`/api/v1/workspaces/${id}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });

export const setMemberRole = (id: string, userId: string, role: Exclude<Role, "owner">) =>
  request<void>(`/api/v1/workspaces/${id}/members/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });

export const removeMember = (id: string, userId: string) =>
  request<void>(`/api/v1/workspaces/${id}/members/${userId}`, { method: "DELETE" });

// ── Domains ───────────────────────────────────────────────────────────────────

export const listDomains = (id: string) =>
  request<{ domains: Domain[] }>(`/api/v1/workspaces/${id}/domains`).then((r) => r.domains);

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

/** Roles that can act, by capability. Mirrors ROLE_RANK on the server — the UI
 *  hides what the API would refuse, rather than inventing its own rules. */
export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const can = (role: Role | undefined, required: Role) =>
  role !== undefined && ROLE_RANK[role] >= ROLE_RANK[required];
