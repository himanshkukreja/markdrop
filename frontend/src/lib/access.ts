/**
 * Per-document access: who can open it, and who has been named on it.
 *
 * The rules live on the server (`services/access.py`). This module carries the
 * shapes and nothing else — `can_manage` and `can_share` come back from the API
 * precisely so the UI never has its own opinion about permissions.
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
    const detail = body?.detail;
    throw new Error(
      typeof detail === "string" ? detail
        : Array.isArray(detail) ? detail[0]?.msg || "That value isn't valid."
        : `Request failed (${res.status})`
    );
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export type AccessLevel = "private" | "link" | "workspace";

export interface Grant {
  email: string;
  role: "viewer" | "editor";
  created_at: string;
  granted_by_email: string | null;
  /** Whether a notification actually left — not merely whether one was asked for. */
  notified: boolean;
}

export interface AccessState {
  level: AccessLevel;
  allow_resharing: boolean;
  is_password_protected: boolean;
  /** The key is in the link's fragment, so a grant alone cannot decrypt it. */
  encrypted: boolean;
  in_workspace: boolean;
  /** Which workspace, so the share box can suggest its members. */
  workspace_id?: string | null;
  your_role: "owner" | "editor" | "viewer";
  owner_name?: string | null;
  owner_email?: string | null;
  can_manage: boolean;
  can_share: boolean;
  grants: Grant[];
  /** The viewer's own address, so a grantee can find their row to leave. */
  your_email?: string | null;
}

export const getAccess = (slug: string) =>
  request<AccessState>(`/api/v1/documents/${encodeURIComponent(slug)}/access`);

export const setAccessLevel = (slug: string, level: AccessLevel) =>
  request<void>(`/api/v1/documents/${encodeURIComponent(slug)}/access/level`, {
    method: "PUT",
    body: JSON.stringify({ level }),
  });

export const setResharing = (slug: string, allow: boolean) =>
  request<void>(`/api/v1/documents/${encodeURIComponent(slug)}/access/resharing`, {
    method: "PUT",
    body: JSON.stringify({ allow }),
  });

export const addPerson = (
  slug: string, email: string, role: "viewer" | "editor", notify: boolean, message?: string
) =>
  request<Grant>(`/api/v1/documents/${encodeURIComponent(slug)}/access/people`, {
    method: "POST",
    body: JSON.stringify({ email, role, notify, message }),
  });

export const removePerson = (slug: string, email: string) =>
  request<void>(
    `/api/v1/documents/${encodeURIComponent(slug)}/access/people/${encodeURIComponent(email)}`,
    { method: "DELETE" }
  );
