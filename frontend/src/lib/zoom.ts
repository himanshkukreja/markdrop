/**
 * Zoom's client (backend routers/zoom.py; docs integrations/zoom):
 *
 *   GET    /api/v1/zoom/status?workspace_id=      the Integrations card
 *   POST   /api/v1/zoom/connect/start             {workspace_id, team_id?} → {url}: Zoom's consent screen (one click)
 *   POST   /api/v1/zoom/connect/finish            {code, state? | workspace_id, team_id?}  (the callback page)
 *   PUT    /api/v1/zoom/connection                {workspace_id, account_id, client_id, client_secret?, secret_token?, team_id?}
 *   PUT    /api/v1/zoom/team                      {workspace_id, team_id}
 *   PUT    /api/v1/zoom/media                     {workspace_id, enabled}: Transcribe and keep recordings (admins)
 *   DELETE /api/v1/zoom/connection?workspace_id=&delete_meetings=
 *   GET    /api/v1/zoom/recordings?workspace_id=&days=|from=&to=
 *   POST   /api/v1/zoom/import                    {workspace_id, uuids}
 *   GET    /api/v1/zoom/me                        your setting "When my Zoom meetings are recorded" (+ your Zoom teams)
 *   PUT    /api/v1/zoom/me                        {share: auto | ask | never}
 *   PUT    /api/v1/zoom/members/share             {workspace_id, user_id, share} (admins)
 *   GET    /api/v1/zoom/review?workspace_id=      your meetings waiting for your decision
 *   POST   /api/v1/zoom/review                    {workspace_id, uuid, decision: share | private | skip}
 *
 * Kept out of lib/api.ts (that one loads on public pages).
 */
import { request } from "@/lib/workspaces";

export type ZoomState = "processing" | "imported" | "duplicate" | "no_transcript" | "failed" | "ignored" | "waiting"
  | "held" | "skipped" | "expired";

/** When a host's recorded Zoom meetings come in: share automatically, ask me first, never bring them in. */
export type ZoomShare = "auto" | "ask" | "never";
export const ZOOM_SHARE_LABELS: Record<ZoomShare, string> = { auto: "Share automatically", ask: "Ask me first", never: "Never bring them in" };

export interface ZoomMember { id: string; name: string; share: ZoomShare }

/** Where a meeting's transcript comes from: Zoom's transcript, its closed captions, or Markdrop transcribing the audio. */
export type ZoomSource = "transcript" | "captions" | "transcribe";

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
  /** The server can transcribe meetings and keep recordings (the switch is offered). */
  media_available?: boolean;
  /** Transcribe and keep recordings is on for this workspace. */
  media_on?: boolean;
  team: ZoomTeam | null;
  teams: ZoomTeam[] | null;
  connection: {
    connected_at: string | null; last_event_at: string | null; last_import_at: string | null; last_sync_at: string | null;
    verified: boolean; broken: string | null;
    imported: number; ignored: number; no_transcript: number; failed: number; duplicates: number;
    from_captions?: number; transcribed?: number; held?: number; skipped?: number;
    account_id?: string | null; client_id?: string | null; connected_by?: string | null; approved_by?: string | null;
    missing_scopes?: ZoomScope[]; test_error?: string | null; last_error?: string | null;
  } | null;
  /** Admins: the Zoom team's members and each one's setting. */
  members?: ZoomMember[] | null;
  /** The caller's own meetings waiting for their decision in this workspace. */
  my_review?: number;
  recent: Array<{ uuid: string; topic: string | null; date: string | null; state: ZoomState; reason: string | null;
    slug: string | null; host: string | null; via: "webhook" | "backfill"; at: string | null;
    source?: ZoomSource | null; recording?: string | null }> | null;
}

export interface ZoomRecording {
  uuid: string; topic: string; start_time: string | null; date: string | null; time: string | null; duration_min: number | null;
  host: { id: string; name: string; email: string };
  transcript: boolean; imported: boolean; slug: string | null; state: ZoomState | null;
  captions?: boolean; video?: boolean; source?: ZoomSource | null;
  /** The recording kept in Markdrop: stored, being copied, or not. */
  recording?: "stored" | "copying" | null;
  /** Already here without its recording (the switch is on): importing it again adds the recording. */
  can_add_recording?: boolean;
  /** Held for its host or kept out by the rules: listed without its topic; why. */
  hidden?: boolean;
  reason?: string | null;
}

export interface ZoomHeld {
  uuid: string; workspace_id: string; topic: string; date: string | null; time: string | null; start_time: string | null;
  duration_min: number | null; people: string[]; people_count: number; reason: string; why: string | null;
  held_at: string | null; expires_at: string | null; team: string;
}

export interface ZoomMe { share: ZoomShare; held: number; teams: Array<{ workspace_id: string; workspace: string | null; team: string | null }> }

export interface ZoomResult { uuid: string; status: ZoomState; reason?: string | null; slug?: string | null; url?: string; topic?: string | null;
  recording?: "queued" | null }

const q = (ws: string) => `workspace_id=${encodeURIComponent(ws)}`;
const put = (body: unknown): RequestInit => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const zoomStatus = (ws: string) => request<ZoomStatus>(`/api/v1/zoom/status?${q(ws)}`);
export const zoomConnect = (body: { workspace_id: string; account_id: string; client_id: string; client_secret?: string | null;
  secret_token?: string | null; team_id?: string | null }) => request<ZoomStatus>("/api/v1/zoom/connection", put(body));
export const zoomSetMedia = (ws: string, enabled: boolean) => request<ZoomStatus>("/api/v1/zoom/media", put({ workspace_id: ws, enabled }));
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
  return request<{ from: string; to: string; meetings: ZoomRecording[]; total: number; not_in_zoom: string[]; no_transcript_help: string;
    media_on?: boolean }>(
    `/api/v1/zoom/recordings?${p.toString()}`);
};
export const zoomImport = (ws: string, uuids: string[]) =>
  request<{ results: ZoomResult[]; counts: Record<string, number> }>("/api/v1/zoom/import", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace_id: ws, uuids }) });
export const zoomMe = () => request<ZoomMe>("/api/v1/zoom/me");
export const zoomSetMe = (share: ZoomShare) => request<ZoomMe>("/api/v1/zoom/me", put({ share }));
export const zoomSetMemberShare = (ws: string, user_id: string, share: ZoomShare) =>
  request<{ members: ZoomMember[] }>("/api/v1/zoom/members/share", put({ workspace_id: ws, user_id, share }));
export const zoomReview = (ws?: string | null) =>
  request<{ meetings: ZoomHeld[]; total: number }>(`/api/v1/zoom/review${ws ? `?${q(ws)}` : ""}`);
export const zoomDecide = (ws: string, uuid: string, decision: "share" | "private" | "skip") =>
  request<{ status: string; decision: string }>("/api/v1/zoom/review", post({ workspace_id: ws, uuid, decision }));
