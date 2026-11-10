/**
 * Zoom's client (backend routers/zoom.py; docs integrations/zoom):
 *
 *   GET    /api/v1/zoom/status?workspace_id=      the Integrations card
 *   POST   /api/v1/zoom/connect/start             {workspace_id, team_id?} → {url}: Zoom's consent screen (one click)
 *   POST   /api/v1/zoom/connect/finish            {code, state? | workspace_id, team_id?}  (the callback page)
 *   PUT    /api/v1/zoom/connection                {workspace_id, account_id, client_id, client_secret?, secret_token?, team_id?}
 *   PUT    /api/v1/zoom/team                      {workspace_id, team_id}
 *   DELETE /api/v1/zoom/connection?workspace_id=&delete_meetings=
 *   GET    /api/v1/zoom/recordings?workspace_id=&days=|from=&to=
 *   POST   /api/v1/zoom/import                    {workspace_id, uuids}
 *
 * Kept out of lib/api.ts (that one loads on public pages).
 */
import { request } from "@/lib/workspaces";

export type ZoomState = "processing" | "imported" | "duplicate" | "no_transcript" | "failed" | "ignored";

export interface ZoomScope { scope: string; why: string; required: boolean }

export interface ZoomTeam { id: string; name: string; visibility: "open" | "private"; slug?: string | null }

export interface ZoomStatus {
  configured: boolean;
  can_manage: boolean;
  connected: boolean;
  can_import: boolean;
  /** Markdrop's Zoom Marketplace app is set up on this server: "Connect Zoom" in one click. */
  app_available?: boolean;
  /** How the workspace is connected: Markdrop's Marketplace app or its own Server-to-Server app. */
  mode?: "oauth" | "s2s" | null;
  /** Admins only: the endpoint to paste into the Zoom app's event subscription. */
  webhook_url: string | null;
  scopes_needed: ZoomScope[] | null;
  events: string[] | null;
  no_transcript_help: string;
  team: ZoomTeam | null;
  teams: ZoomTeam[] | null;
  connection: {
    connected_at: string | null; last_event_at: string | null; last_import_at: string | null; last_sync_at: string | null;
    verified: boolean; broken: string | null;
    imported: number; ignored: number; no_transcript: number; failed: number; duplicates: number;
    account_id?: string | null; client_id?: string | null; connected_by?: string | null; approved_by?: string | null;
    missing_scopes?: ZoomScope[]; test_error?: string | null; last_error?: string | null;
  } | null;
  recent: Array<{ uuid: string; topic: string | null; date: string | null; state: ZoomState; reason: string | null;
    slug: string | null; host: string | null; via: "webhook" | "backfill"; at: string | null }> | null;
}

export interface ZoomRecording {
  uuid: string; topic: string; start_time: string | null; date: string | null; time: string | null; duration_min: number | null;
  host: { id: string; name: string; email: string };
  transcript: boolean; imported: boolean; slug: string | null; state: ZoomState | null;
}

export interface ZoomResult { uuid: string; status: ZoomState; reason?: string | null; slug?: string | null; url?: string; topic?: string | null }

const q = (ws: string) => `workspace_id=${encodeURIComponent(ws)}`;
const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const zoomStatus = (ws: string) => request<ZoomStatus>(`/api/v1/zoom/status?${q(ws)}`);
export const zoomConnect = (body: { workspace_id: string; account_id: string; client_id: string; client_secret?: string | null;
  secret_token?: string | null; team_id?: string | null }) => request<ZoomStatus>("/api/v1/zoom/connection", put(body));
export const zoomSetTeam = (ws: string, team_id: string) => request<ZoomStatus>("/api/v1/zoom/team", put({ workspace_id: ws, team_id }));
export const zoomDisconnect = (ws: string, deleteMeetings = false) =>
  request<ZoomStatus & { deleted_meetings?: number }>(`/api/v1/zoom/connection?${q(ws)}${deleteMeetings ? "&delete_meetings=true" : ""}`, { method: "DELETE" });
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const zoomConnectStart = (ws: string, team_id?: string | null) =>
  request<{ url: string }>("/api/v1/zoom/connect/start", post({ workspace_id: ws, ...(team_id ? { team_id } : {}) }));
export const zoomConnectFinish = (body: { code: string; state?: string | null; workspace_id?: string | null; team_id?: string | null }) =>
  request<ZoomStatus & { workspace_id: string }>("/api/v1/zoom/connect/finish", post(body));
export const zoomRecordings = (ws: string, range: { days?: number; from?: string; to?: string }) => {
  const p = new URLSearchParams({ workspace_id: ws });
  if (range.from || range.to) {
    if (range.from) p.set("from", range.from);
    if (range.to) p.set("to", range.to);
  } else p.set("days", String(range.days ?? 30));
  return request<{ from: string; to: string; meetings: ZoomRecording[]; total: number; not_in_zoom: string[]; no_transcript_help: string }>(
    `/api/v1/zoom/recordings?${p.toString()}`);
};
export const zoomImport = (ws: string, uuids: string[]) =>
  request<{ results: ZoomResult[]; counts: Record<string, number> }>("/api/v1/zoom/import", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace_id: ws, uuids }) });
