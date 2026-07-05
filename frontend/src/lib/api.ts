const API_BASE = process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in";

export { API_BASE };

// ── User session token ─────────────────────────────────────────────────────────
const TOKEN_KEY = "markdrop_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Authorization header for the current session, if logged in. */
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

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
  // Present when the creator owns the doc (e.g. logged-in create, or copy) —
  // needed to trigger the Google Docs export by internal id.
  id?: string | null;
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
  is_owned?: boolean;
  is_owner?: boolean;
  // Owner-only fields (present when the requester owns the doc).
  id?: string | null;
  google_doc_url?: string | null;
  google_doc_stale?: boolean;
}

export type ExpiresIn = "never" | "1d" | "7d" | "30d" | "custom";

export async function createDocument(
  title: string,
  content: string,
  options?: { customSlug?: string; expiresIn?: ExpiresIn; customExpiresAt?: string; readPassword?: string }
): Promise<DocumentCreateResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
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
  const headers: Record<string, string> = { ...authHeaders() };
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
      ...authHeaders(),
      ...(editSecret ? { "x-edit-secret": editSecret } : {}),
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

export async function deleteDocument(slug: string, editSecret?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}`, {
    method: "DELETE",
    headers: { ...authHeaders(), ...(editSecret ? { "x-edit-secret": editSecret } : {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to delete" }));
    throw new Error(err.detail);
  }
}

// ── Analytics event beacons (fire-and-forget) ──────────────────────────────────

export async function reportDocument(slug: string, reason?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: reason || null }),
  });
  if (!res.ok && res.status !== 202) throw new Error("Failed to submit report");
}

export function recordEvent(slug: string, type: "view" | "export_pdf" | "copy_url"): void {
  try {
    fetch(`${API_BASE}/api/v1/documents/${slug}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics must never break the UX */
  }
}

// ── Change slug / claim (owner or secret) ──────────────────────────────────────

export async function changeSlug(slug: string, newSlug: string, editSecret?: string): Promise<DocumentResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}/slug`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(editSecret ? { "x-edit-secret": editSecret } : {}),
    },
    body: JSON.stringify({ new_slug: newSlug }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to change URL" }));
    throw new Error(err.detail);
  }
  return res.json();
}

/** Import a copy of a readable document into the logged-in user's account.
 *  The copy has a fresh slug, no password, and no expiry. Requires login. */
export async function copyDocument(slug: string, readPassword?: string): Promise<DocumentCreateResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ read_password: readPassword ?? null }),
  });
  if (res.status === 401) throw new Error("Please log in to save a copy");
  if (res.status === 404) throw new Error("Document not found");
  if (res.status === 403) throw new Error("You don't have access to copy this document");
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to copy document" }));
    throw new Error(typeof err.detail === "string" ? err.detail : "Failed to copy document");
  }
  return res.json();
}

export async function claimDocument(slug: string, editSecret: string): Promise<DocumentResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${slug}/claim`, {
    method: "POST",
    headers: { ...authHeaders(), "x-edit-secret": editSecret },
  });
  if (res.status === 401) throw new Error("Please log in to claim this document");
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to claim" }));
    throw new Error(err.detail);
  }
  return res.json();
}

// ── User authentication ────────────────────────────────────────────────────────

export interface MeUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  providers: string[];
  created_at: string;
}

export function googleLoginUrl(next?: string): string {
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  return `${API_BASE}/api/v1/auth/google/login${q}`;
}

export async function fetchMe(): Promise<MeUser> {
  const res = await fetch(`${API_BASE}/api/v1/auth/me`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("UNAUTHORIZED");
  return res.json();
}

export async function emailRequestLogin(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/auth/email/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Could not send email" }));
    throw new Error(err.detail);
  }
}

export async function emailVerifyOtp(email: string, code: string): Promise<{ token: string; user: MeUser }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/email/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) throw new Error("Invalid or expired code");
  return res.json();
}

// ── API tokens (VS Code extension / sync) ──────────────────────────────────────

export interface ApiTokenItem {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export async function listApiTokens(): Promise<ApiTokenItem[]> {
  const res = await fetch(`${API_BASE}/api/v1/me/tokens`, { headers: { ...authHeaders() }, cache: "no-store" });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to load tokens");
  return (await res.json()).tokens;
}

export async function createApiToken(name: string): Promise<ApiTokenItem & { token: string }> {
  const res = await fetch(`${API_BASE}/api/v1/me/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to create token");
  return res.json();
}

export async function revokeApiToken(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/me/tokens/${id}`, { method: "DELETE", headers: { ...authHeaders() } });
  if (!res.ok && res.status !== 204) throw new Error("Failed to revoke token");
}

export async function updateMyName(name: string): Promise<MeUser> {
  const res = await fetch(`${API_BASE}/api/v1/auth/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error("Failed to update name");
  return res.json();
}

export async function logoutRequest(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/v1/auth/logout`, { method: "POST", headers: { ...authHeaders() } });
  } catch {
    /* ignore */
  }
}

// ── Dashboard: my documents + analytics ────────────────────────────────────────

export interface MyDocListItem {
  id: string;
  slug: string;
  url: string;
  title: string | null;
  content_preview: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  views: number;
  export_pdf_count: number;
  copy_url_count: number;
  is_password_protected: boolean;
  google_doc_url?: string | null;
  google_doc_stale?: boolean;
}

export interface MyDocListResponse {
  documents: MyDocListItem[];
  total: number;
  page: number;
  pages: number;
}

export async function listMyDocuments(page = 1, q?: string): Promise<MyDocListResponse> {
  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (q) params.set("q", q);
  const res = await fetch(`${API_BASE}/api/v1/me/documents?${params}`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to load documents");
  return res.json();
}

export interface Analytics {
  range: string;
  totals: { views: number; unique_visitors: number; export_pdf: number; copy_url: number };
  timeseries: { date: string; views: number }[];
  countries: { country: string; views: number }[];
  referrers: { referrer: string; views: number }[];
}

export async function getAnalytics(slug: string, range: "7d" | "30d" | "all" = "30d"): Promise<Analytics> {
  const res = await fetch(`${API_BASE}/api/v1/me/documents/${slug}/analytics?range=${range}`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

// ── Google Docs integration ─────────────────────────────────────────────────────

export interface GoogleStatus {
  connected: boolean;
  configured: boolean;
}

/** Whether this account has connected Google Docs (and the server supports it). */
export async function getGoogleDocsStatus(): Promise<GoogleStatus> {
  const res = await fetch(`${API_BASE}/api/v1/google/status`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to load Google status");
  return res.json();
}

/** Start the opt-in connect flow: fetch the consent URL, then redirect to it. */
export async function connectGoogleDocs(next = "/dashboard"): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/google/connect?next=${encodeURIComponent(next)}`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Could not start Google connect" }));
    throw new Error(typeof err.detail === "string" ? err.detail : "Could not start Google connect");
  }
  const { auth_url } = await res.json();
  window.location.href = auth_url;
}

export async function disconnectGoogleDocs(): Promise<GoogleStatus> {
  const res = await fetch(`${API_BASE}/api/v1/google/disconnect`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (!res.ok) throw new Error("Failed to disconnect Google");
  return res.json();
}

export interface GoogleExportResult {
  google_doc_id: string;
  google_doc_url: string | null;
  synced_rev: number | null;
  rev: number;
}

/** Create the Google Doc (first call) or refresh it from current content. */
export async function exportToGoogleDocs(docId: string): Promise<GoogleExportResult> {
  const res = await fetch(`${API_BASE}/api/v1/google/documents/${docId}/export`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (res.status === 428) {
    // Reconnect required — carry the server's actionable message (e.g. missing
    // Drive scope) so the UI can show it verbatim and offer a Reconnect button.
    const body = await res.json().catch(() => null);
    const message =
      (body && typeof body.detail === "object" && body.detail?.message) ||
      "Your Google connection needs to be renewed. Please reconnect.";
    const err = new Error(message);
    err.name = "ReconnectRequired";
    throw err;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to export to Google Docs" }));
    throw new Error(typeof err.detail === "string" ? err.detail : "Failed to export to Google Docs");
  }
  return res.json();
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
  owner_id: string | null;
  owner_email: string | null;
  report_count: number;
}

export interface AdminUserListItem {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  providers: string[];
  created_at: string;
  last_login_at: string | null;
  document_count: number;
  vscode_token_count: number;
  vscode_last_synced_at: string | null;
  google_connected: boolean;
  google_export_count: number;
  share_count: number;
}

export interface FeatureUsage {
  total_users: number;
  vscode_users_with_token: number;
  vscode_users_synced: number;
  vscode_tokens_total: number;
  google_connected_users: number;
  google_exported_docs: number;
  share_events_total: number;
  share_users_identified: number;
  share_events_anonymous: number;
}

export interface AdminShareEventItem {
  id: string;
  ts: string;
  room_id: string;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  user_id: string | null;
  user_email: string | null;
}

export interface AdminShareEventListResponse {
  events: AdminShareEventItem[];
  total: number;
  page: number;
  pages: number;
}

export interface AdminUserListResponse {
  users: AdminUserListItem[];
  total: number;
  page: number;
  pages: number;
}

export async function adminListUsers(token: string, page = 1, q?: string): Promise<AdminUserListResponse> {
  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (q) params.set("q", q);
  const res = await fetch(`${API_BASE}/api/v1/admin/users?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to list users");
  return res.json();
}

export interface AdminDocListResponse {
  documents: AdminDocListItem[];
  total: number;
  page: number;
  pages: number;
}

export async function adminFeatureUsage(token: string): Promise<FeatureUsage> {
  const res = await fetch(`${API_BASE}/api/v1/admin/feature-usage`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to load feature usage");
  return res.json();
}

export async function adminListShareEvents(
  token: string,
  page = 1,
  identified = false
): Promise<AdminShareEventListResponse> {
  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (identified) params.set("identified", "1");
  const res = await fetch(`${API_BASE}/api/v1/admin/share-events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to load share events");
  return res.json();
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
  q?: string,
  reported = false
): Promise<AdminDocListResponse> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (q) params.set("q", q);
  if (reported) params.set("reported", "1");
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
