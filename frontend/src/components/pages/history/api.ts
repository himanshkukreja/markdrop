/**
 * Version history of a page (backend routers/page_history.py): list, read one, restore one.
 * Editors only; the API answers 403 / 404 / 401 for anyone else.
 */
import { API_BASE, getToken, type DocumentResponse } from "@/lib/api";
import { PagesApiError } from "@/lib/pages";
import type { AssetUrl } from "@/lib/pages";

export type AuthorKind = "user" | "mcp" | "restore" | "system" | "signoff";

export interface VersionAuthor {
  kind: AuthorKind;
  id: string | null;
  name: string | null;
  /** An AI app's name, for `mcp`. */
  client: string | null;
  /** What to show: a name, "<app> via MCP", or "Earlier version". */
  label: string;
  picture: string | null;
}

export interface VersionSummary {
  n: number;
  ts: string | null;
  author: VersionAuthor;
  title: string | null;
  icon: string | null;
  bytes: number;
  restored_from: number | null;
  /** The newest version, and it matches the page now. */
  current: boolean;
  /** A sign-off given, changed, cleared or removed (`author.label` says which): the page as it was then. */
  event?: { type: "signoff"; action: "signed" | "changed" | "cleared" | "removed"; block?: string; label?: string; option?: string | null; was?: string | null; text?: string };
}

export interface VersionList {
  versions: VersionSummary[];
  next_cursor: number | null;
  available: boolean;
  reason: "encrypted" | "file" | null;
}

export interface VersionDetail extends VersionSummary {
  markdown: string;
  assets: Record<string, AssetUrl>;
  current_doc: { title: string | null; markdown: string; rev: number };
}

export interface RestoreResult {
  document: DocumentResponse;
  version: number | null;
  restored_from: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const t = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      ...init,
      headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    });
  } catch {
    throw new PagesApiError("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const detail = body?.detail;
    const info = detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : body ?? {};
    throw new PagesApiError(typeof detail === "string" ? detail : `Request failed (${res.status})`, res.status, info);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export function listVersions(slug: string, cursor?: number | null): Promise<VersionList> {
  return call<VersionList>(`/api/v1/documents/${enc(slug)}/versions${cursor ? `?cursor=${cursor}` : ""}`);
}

export function getVersion(slug: string, n: number): Promise<VersionDetail> {
  return call<VersionDetail>(`/api/v1/documents/${enc(slug)}/versions/${n}`);
}

export function restoreVersion(slug: string, n: number): Promise<RestoreResult> {
  return call<RestoreResult>(`/api/v1/documents/${enc(slug)}/versions/${n}/restore`, { method: "POST" });
}
