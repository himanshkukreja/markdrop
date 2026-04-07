const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";

export interface DocumentCreateResponse {
  slug: string;
  url: string;
  title: string | null;
  content: string;
  edit_secret: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  views: number;
  is_password_protected: boolean;
}

export interface DocumentResponse {
  slug: string;
  url: string;
  title: string | null;
  content: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  views: number;
  is_password_protected: boolean;
}

export type ExpiresIn = "never" | "1d" | "7d" | "30d" | "custom";

export async function createDocument(
  title: string,
  content: string,
  options?: { customSlug?: string; expiresIn?: ExpiresIn; customExpiresAt?: string; readPassword?: string }
): Promise<DocumentCreateResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: title.trim() || null,
      content,
      custom_slug: options?.customSlug?.trim() || null,
      expires_in: options?.expiresIn ?? "never",
      custom_expires_at: options?.customExpiresAt ?? null,
      read_password: options?.readPassword ?? null,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to create document" }));
    throw new Error(err.detail);
  }
  return res.json();
}

export async function getDocument(slug: string, readPassword?: string, editSecret?: string): Promise<DocumentResponse> {
  const headers: Record<string, string> = {};
  if (readPassword) headers["x-read-password"] = readPassword;
  if (editSecret) headers["x-edit-secret"] = editSecret;
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}`, {
    cache: "no-store",
    headers,
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error("Document not found");
    if (res.status === 401) throw new Error("PASSWORD_REQUIRED");
    if (res.status === 403) throw new Error("WRONG_PASSWORD");
    throw new Error("Failed to fetch document");
  }
  return res.json();
}

export async function updateDocument(
  slug: string,
  title: string,
  content: string,
  editSecret: string,
  options?: {
    readPassword?: string;
    removePassword?: boolean;
    expiresIn?: ExpiresIn;
    customExpiresAt?: string;
  }
): Promise<DocumentResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-edit-secret": editSecret,
    },
    body: JSON.stringify({
      title: title.trim() || null,
      content,
      read_password: options?.readPassword ?? null,
      remove_password: options?.removePassword ?? false,
      expires_in: options?.expiresIn ?? null,
      custom_expires_at: options?.expiresIn === "custom" ? (options?.customExpiresAt ?? null) : null,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to update" }));
    throw new Error(err.detail);
  }
  return res.json();
}

export async function deleteDocument(slug: string, editSecret: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}`, {
    method: "DELETE",
    headers: { "x-edit-secret": editSecret },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to delete" }));
    throw new Error(err.detail);
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

const ADMIN_TOKEN_KEY = "markdrop_admin_token";

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

export interface AdminDocListItem {
  slug: string;
  title: string | null;
  content_preview: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  views: number;
  is_password_protected: boolean;
  content_length: number;
}

export interface AdminDocListResponse {
  documents: AdminDocListItem[];
  total: number;
  page: number;
  pages: number;
}

export async function adminLogin(username: string, password: string): Promise<{ token: string; expires_at: string }> {
  const res = await fetch(`${API_BASE}/api/v1/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error("Invalid credentials");
  return res.json();
}

export async function adminListDocuments(
  token: string,
  page = 1,
  limit = 20,
  q?: string
): Promise<AdminDocListResponse> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (q) params.set("q", q);
  const res = await fetch(`${API_BASE}/api/v1/admin/documents?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to list documents");
  return res.json();
}

export async function adminGetDocument(token: string, slug: string): Promise<DocumentResponse> {
  const res = await fetch(`${API_BASE}/api/v1/admin/documents/${slug}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Document not found");
  return res.json();
}

export async function adminUpdateDocument(
  token: string,
  slug: string,
  title: string,
  content: string
): Promise<DocumentResponse> {
  const res = await fetch(`${API_BASE}/api/v1/admin/documents/${slug}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title: title.trim() || null, content }),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to update");
  return res.json();
}

export async function adminDeleteDocument(token: string, slug: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/admin/documents/${slug}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to delete");
}
