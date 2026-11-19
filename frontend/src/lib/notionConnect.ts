/**
 * Connect Notion (backend routers/notion_connect.py). Prefix /api/v1/notion:
 *
 *   GET    /status                         {configured, connections, syncs, sync_minutes}
 *   POST   /connect/start {back?}          → {url} (Notion's consent screen; the person picks the pages to share)
 *   POST   /connect/finish {code, state}   → {connection, back}
 *   DELETE /connections/{id}               disconnect (Notion revokes the token; imported pages stay)
 *   GET    /connections/{id}/pages         the pages and databases shared with Markdrop (the picker), each under
 *                                          its real parent; database rows load with the next one
 *   GET    /connections/{id}/databases/{db}/rows?cursor=   a database's rows, 50 at a time
 *   POST   /import                         {connection_id?, pages, exclude, destination, keep_in_sync} → {import} (an
 *                                          ordinary Notion import job: poll it with getNotionImport)
 *   PATCH  /syncs/{id} {keep_in_sync}      Keep in sync on / off
 *   POST   /syncs/{id}/run                 Sync now → {import, sync}
 *   DELETE /syncs/{id}                     stop following it (its pages stay)
 */
import { request } from "@/lib/workspaces";
import type { NotionDestinationIn, NotionImport, NotionImportCounts } from "@/lib/notionImport";

export interface NotionConnection {
  id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_icon: string | null;
  owner_name: string | null;
  owner_email: string | null;
  connected_at: string | null;
  /** Notion stopped accepting the token: reconnect. */
  broken: boolean;
}

export interface NotionSharedItem {
  /** 32-hex Notion id. */
  id: string;
  /** "row": a database row (from notionDatabaseRows, never in the listing itself). */
  kind: "page" | "database" | "row";
  title: string;
  icon: string | null;
  /** What it sits in, when that's shared too (null: top level). */
  parent_id: string | null;
  /** "row": it's a sub-page of a database row (shown when its database is opened). */
  parent_kind?: "page" | "database" | "row" | null;
  /** Databases: how many rows Notion's search returned for it. */
  row_count?: number;
  url: string | null;
  last_edited: string | null;
}

export interface NotionSharedListing {
  items: NotionSharedItem[];
  /** The database of each row that has sub-pages in `items`. */
  row_parents?: Record<string, string>;
  truncated: boolean;
}

export interface NotionSync {
  id: string;
  connection_id: string;
  root_id: string;
  root_kind: "page" | "database";
  title: string;
  keep_in_sync: boolean;
  /** "connection": reconnect Notion; "access": you can't add to where it goes any more. */
  paused: "connection" | "access" | null;
  destination: {
    kind: "team" | "personal";
    workspace_id: string | null; workspace_name: string | null;
    team_id: string | null; team_name: string | null;
    folder_id: string | null; folder_name: string | null;
  };
  /** Where it is in Markdrop. */
  url: string | null;
  state: "syncing" | "done" | "failed" | "never";
  last_synced_at: string | null;
  next_at: string | null;
  last_error: string | null;
  last_job_id: string | null;
  counts: Partial<NotionImportCounts>;
  /** Pages edited in Markdrop since they were synced: kept as they are, no longer synced. */
  edited_in_markdrop: { title: string; slug: string; url: string }[];
  /** How many pages were left out in the picker (never brought in by a sync). */
  left_out?: number;
}

export interface NotionStatus {
  configured: boolean;
  connections: NotionConnection[];
  syncs: NotionSync[];
  sync_minutes: number;
}

const P = "/api/v1/notion";

export const notionStatus = () => request<NotionStatus>(`${P}/status`);

/** Off to Notion's consent screen; it comes back to /integrations/notion/callback, then to `back`. */
export async function connectNotion(back?: string): Promise<void> {
  const { url } = await request<{ url: string }>(`${P}/connect/start`, { method: "POST", body: JSON.stringify({ back: back ?? null }) });
  window.location.href = url;
}

export const finishNotion = (code: string, state: string) =>
  request<{ connection: NotionConnection; back: string | null }>(`${P}/connect/finish`, { method: "POST", body: JSON.stringify({ code, state }) });

export const disconnectNotion = (id: string) =>
  request<{ disconnected: boolean; revoked: boolean; syncs_stopped: number }>(`${P}/connections/${encodeURIComponent(id)}`, { method: "DELETE" });

export const notionSharedPages = (id: string) =>
  request<NotionSharedListing>(`${P}/connections/${encodeURIComponent(id)}/pages`);

export const notionDatabaseRows = (id: string, database: string, cursor?: string | null) =>
  request<{ items: NotionSharedItem[]; next_cursor: string | null }>(
    `${P}/connections/${encodeURIComponent(id)}/databases/${encodeURIComponent(database)}/rows${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);

export const importFromNotion = (body: { connection_id: string; pages: { id: string; kind: "page" | "database"; title?: string }[]; exclude?: string[]; destination: NotionDestinationIn; keep_in_sync: boolean }) =>
  request<{ import: NotionImport }>(`${P}/import`, { method: "POST", body: JSON.stringify(body) });

export const setKeepInSync = (id: string, keep: boolean) =>
  request<NotionSync>(`${P}/syncs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ keep_in_sync: keep }) });

export const syncNotionNow = (id: string) =>
  request<{ import: NotionImport; sync: NotionSync }>(`${P}/syncs/${encodeURIComponent(id)}/run`, { method: "POST" });

export const removeNotionSync = (id: string) =>
  request<void>(`${P}/syncs/${encodeURIComponent(id)}`, { method: "DELETE" });

/** The `back` a connect started with, read from the state without trusting it (the server checks it). */
export function readNotionState(state: string): { back: string | null } {
  try {
    const body = state.split(".")[0] || "";
    const json = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    const back = typeof json.b === "string" && json.b.startsWith("/") && !json.b.startsWith("//") ? json.b : null;
    return { back };
  } catch {
    return { back: null };
  }
}
