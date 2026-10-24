/**
 * OAuth consent and connected-apps API (the MCP server's authorization side).
 *
 * Kept out of lib/api.ts for the same reason as lib/workspaces.ts: api.ts loads on every public
 * document page, and none of this is reachable without a session. Shapes follow the MCP spec
 * (backend routers for /api/v1/oauth/requests/* and /api/v1/me/connections).
 *
 * Errors are `ApiError`s: `status` 0 is a network failure, 404 an expired or unknown request,
 * 401 a session the API no longer accepts.
 */
import { API_BASE, ApiError, getToken } from "@/lib/api";
import { MCP_SCOPES, type McpScope } from "@/lib/mcp";

export interface OAuthScope {
  name: McpScope | string;
  title: string;
  description: string;
}

export interface OAuthRequestInfo {
  client: {
    name: string;
    uri: string | null;
    logo_uri: string | null;
    /** Where Approve or Cancel sends the browser, e.g. "claude.ai". */
    redirect_host: string;
    /** "cimd": a Client ID Metadata Document at an https URL; "registration": self-registered (RFC 7591). */
    verified_by: "cimd" | "registration";
  };
  scopes: OAuthScope[];
  account: { email: string; name: string | null };
  resource: string;
}

export interface OAuthConnection {
  client_id: string;
  name: string;
  logo_uri: string | null;
  uri: string | null;
  scopes: string[];
  connected_at: string;
  last_used_at: string | null;
}

/** Plain words for each scope, for lists that only carry the scope names (connected apps). */
const SHORT: Record<McpScope, string> = { "documents:read": "Read", "documents:write": "Publish and edit" };
export const SCOPE_LABELS: Record<string, { short: string; title: string; description: string; icon: string }> =
  Object.fromEntries(MCP_SCOPES.map((s) => [s.name, { ...s, short: SHORT[s.name] }]));

export function scopeIcon(name: string): string {
  return SCOPE_LABELS[name]?.icon ?? "key";
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function call<T>(path: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...authHeaders(), ...(init?.headers || {}) },
    });
  } catch {
    throw new ApiError("NETWORK_ERROR", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown; error_description?: unknown } | null;
    const message =
      typeof body?.detail === "string" ? body.detail
        : typeof body?.error_description === "string" ? body.error_description
          : fallback;
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** GET /api/v1/oauth/requests/{id}: the pending authorization request, for the consent screen. */
export function getOAuthRequest(id: string): Promise<OAuthRequestInfo> {
  return call(`/api/v1/oauth/requests/${encodeURIComponent(id)}`, undefined, "Couldn't load this request");
}

/** POST /api/v1/oauth/requests/{id}/decision: returns where to send the browser next. */
export function decideOAuthRequest(id: string, approve: boolean): Promise<{ redirect_url: string }> {
  return call(
    `/api/v1/oauth/requests/${encodeURIComponent(id)}/decision`,
    { method: "POST", body: JSON.stringify({ approve }) },
    "Couldn't send your answer",
  );
}

/** GET /api/v1/me/connections: apps holding tokens for this account. */
export async function listConnections(): Promise<OAuthConnection[]> {
  const r = await call<OAuthConnection[] | { connections: OAuthConnection[] }>("/api/v1/me/connections", undefined, "Couldn't load your connected apps");
  return Array.isArray(r) ? r : r?.connections ?? [];
}

/** DELETE /api/v1/me/connections/{client_id}: revokes every token and grant for that app. */
export function disconnectApp(clientId: string): Promise<void> {
  return call(`/api/v1/me/connections/${encodeURIComponent(clientId)}`, { method: "DELETE" }, "Couldn't disconnect the app");
}

/** The host of an http(s) URL, without "www."; null when it isn't one. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * A client logo is shown only from https (or from a loopback host while developing locally).
 * Anything else — data:, javascript:, http on the public site — falls back to the neutral glyph.
 */
export function safeLogoUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.toString();
    const local = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    if (local && u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return u.toString();
    return null;
  } catch {
    return null;
  }
}
