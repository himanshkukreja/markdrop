/**
 * Meetings' client (backend routers/meetings.py; .work/meetings/SPEC.md):
 *
 *   GET    /api/v1/meetings/status?workspace=     AI on?, Google Picker ready?, the Meetings folder
 *   POST   /api/v1/meetings/preview               what a paste / files would import (no writes)
 *   POST   /api/v1/meetings/import                → {meetings}
 *   POST   /api/v1/meetings/google/token          the Picker's short-lived token (drive.file)
 *   GET    /api/v1/meetings?workspace=&cursor=&limit=30&sort=&q=&series=   a page of the meetings the caller can open
 *   GET    /api/v1/meetings/{id}                  one
 *   PATCH  /api/v1/meetings/{id}                  {restricted?, type?}
 *   DELETE /api/v1/meetings/{id}
 *   POST   /api/v1/meetings/{id}/regenerate
 *   POST   /api/v1/meetings/{id}/ask      (SSE)   Ask this meeting
 *   POST   /api/v1/meetings/ask           (SSE)   Ask across meetings
 *   GET    /api/v1/meetings/connection?workspace=  Connect Google Meet: mine, and others sending here
 *   POST   /api/v1/meetings/connection    {workspace, restricted} → the script (with its token), once
 *   DELETE /api/v1/meetings/connection    Disconnect (the script's token stops working)
 *   PUT    /api/v1/meetings/connection/check-now  {url | null}: the script's web app (Check now on / off)
 *   POST   /api/v1/meetings/check-now     {workspace} → the connected scripts run now → {message, …}
 *   (POST  /api/v1/meetings/inbox is the script's; services/meetings_inbox.py)
 *
 * Signed-in members only; every meeting is decided on its page by the server. Kept out of lib/api.ts
 * (that one loads on public pages).
 */
import { API_BASE, getToken } from "@/lib/api";
import { request } from "@/lib/workspaces";
import { SseParser } from "@/lib/pages-ai/sse";

export const MEETING_TYPES = ["Standup", "Planning", "Review", "1:1", "Interview", "Customer", "Other"] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export interface MeetingAi {
  state: "pending" | "done" | "skipped" | "failed";
  reason?: string | null;
  message?: string | null;
  calls?: number;
  chunks?: number | null;
  at?: string | null;
}

export interface MeetingSource { kind: "transcript" | "notes" | "both"; origin: string; name: string | null; url: string | null; format?: string | null }

export interface Meeting {
  id: string;
  workspace_id: string;
  title: string | null;
  page_title: string | null;
  slug: string;
  transcript_slug: string | null;
  date: string | null;
  time: string | null;
  duration_s: number | null;
  type: MeetingType | string | null;
  /** Who joined: a Meet transcript's Attendees list and the speakers (else the speakers). */
  attendees: Array<{ name: string; user_id: string | null }>;
  /** The calendar invite (Gemini notes' "Invited"), joined or not: shown as "Invited: N", never as attendees. */
  invited?: Array<{ name: string; user_id: string | null }>;
  /** Where the attendees came from: "attendees" | "speakers" | "notes" (Gemini notes only: the people they name) | "invited" (nobody known to have joined) | "none". */
  attendees_from?: string | null;
  restricted: boolean;
  action_items: number;
  segments: number;
  has_notes: boolean;
  has_transcript: boolean;
  sources: MeetingSource[];
  ai: MeetingAi;
  created_at: string | null;
  created_by: string | null;
  can_manage: boolean;
  can_delete: boolean;
  /** The workspace's Slack meetings channel (GET /meetings/{id} only), for "Post to Slack". */
  slack_channel?: string | null;
  can_regenerate: boolean;
  approx_times?: boolean;
  /** How it came in: the website, the Google Meet script, or an AI tool (MCP). */
  source?: "manual" | "auto" | "mcp";
  /** On import: a new meeting, the missing half added to one already here, or nothing new. */
  status?: "imported" | "attached" | "duplicate";
  /** A meeting held more than a day before it was imported: not posted to Slack on its own. */
  history?: boolean;
  /** Who ran the call (the Google Doc's owner, or named in the text); null: unknown. */
  organizer?: { name: string | null; user_id: string | null; from: "drive" | "content" | null } | null;
  /** Who brought it into Markdrop. */
  imported_by?: { user_id: string; name: string | null } | null;
  /** Restricted on import because it was a 1:1 or a two-person call. */
  auto_restricted?: boolean;
  /** The recurring meeting it belongs to ("Daily Standup"), or null. */
  series?: string | null;
  /** For the list's cards: a line of the AI summary (plain text), counts, and the page's gallery cover id. */
  summary?: string | null;
  decisions?: number;
  open_questions?: number;
  cover?: string | null;
}

/** A "Connect Google Meet" connection (never its token). */
export interface MeetConnection {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  restricted: boolean;
  created_at: string | null;
  connected_by: { id: string; name: string | null };
  mine: boolean;
  last_received_at: string | null;
  last_imported_at: string | null;
  received: number;
  imported: number;
  attached: number;
  duplicates: number;
  ignored: number;
  /** v4: meetings that took newer content from a Doc sent again; Docs Google hadn't filled in yet. */
  updated?: number;
  not_ready?: number;
  last_error: string | null;
  prefix: string | null;
  /** The script also sends meetings shared with this person (organized by someone else). */
  include_shared?: boolean | null;
  /** The script's last run, as it reported it (v2+; v1 never reports: null). */
  script?: MeetScriptRun | null;
  script_version?: number;
  latest_script_version?: number;
  /** The installed script is older than the one Markdrop hands out now: get the new one. */
  needs_update?: boolean;
  /** "Check for new meetings": the script's web app is set (never its address), and the last check. */
  check_now?: { ready: boolean; last_at: string | null; last: Partial<CheckNowConn> | null };
}

export type MeetSkipReason = "already_sent" | "too_old" | "not_yours" | "title" | "writing" | "not_ready";

export interface MeetScriptRun {
  version: number | null;
  mode: string | null;            // run | setup | backfill | check
  started_at: string | null;
  ran_at: string | null;
  include_shared: boolean | null;
  found: number;
  sent: number;
  results: Partial<Record<"imported" | "attached" | "duplicate" | "ignored" | "updated" | "not_ready", number>>;
  skipped: Partial<Record<MeetSkipReason, number>>;
  errors: { title: string; error: string }[];
  search: string | null;
  /** v3: Docs left for the next run (a run sends for about 4½ minutes). */
  remaining?: number;
  /** v3: "off": the Drive API is off in the script's project, so shared drives aren't searched (optional). */
  shared_drives?: "on" | "off" | null;
  /** Google Cloud's page that turns the Drive API on for that project (when shared_drives is "off"). */
  drive_api_url?: string | null;
}

export function getMeetConnection(workspace: string) {
  return request<{ connection: MeetConnection | null; others: MeetConnection[]; endpoint: string }>(
    `/api/v1/meetings/connection?workspace=${encodeURIComponent(workspace)}`);
}

export const BACKFILL_DAYS = [0, 7, 30, 90] as const;

/** `backfill_days`: past meetings the script's setup brings in once (quietly); `tz`: the browser's zone. */
export function connectGoogleMeet(body: { workspace: string; restricted?: boolean; backfill_days?: (typeof BACKFILL_DAYS)[number]; tz?: string; include_shared?: boolean }) {
  return request<{ token: string; script: string; manifest: string; endpoint: string; connection: MeetConnection }>(
    `/api/v1/meetings/connection`, { method: "POST", body: JSON.stringify(body) });
}

export function disconnectGoogleMeet() {
  return request<{ disconnected: boolean }>(`/api/v1/meetings/connection`, { method: "DELETE" });
}

/** One connected script's answer to "Check for new meetings". */
export interface CheckNowConn {
  connected_by: { id: string; name: string | null };
  mine: boolean;
  ok: boolean;
  error?: string;
  message?: string;
  found?: number;
  sent?: number;
  imported: number;
  attached: number;
  updated: number;
  not_ready: number;
  writing: number;
  remaining: number;
}

export interface CheckNowResult {
  ok: boolean;
  message: string;
  checked: number;
  failed: number;
  not_set_up: number;
  imported: number;
  attached: number;
  updated: number;
  not_ready: number;
  writing: number;
  remaining: number;
  connections: CheckNowConn[];
}

/** Turn "Check for new meetings" on (the script's Web app URL) or off (null), for your connection. */
export function setCheckNow(url: string | null) {
  return request<{ connection: MeetConnection }>(`/api/v1/meetings/connection/check-now`,
    { method: "PUT", body: JSON.stringify({ url }) });
}

/** "Check for new meetings": the workspace's scripts run now (waits up to about 50 s).
 *  409 not_connected / not_set_up and 429 too_soon carry {error, message}. */
export function checkMeetingsNow(workspace: string) {
  return request<CheckNowResult>(`/api/v1/meetings/check-now`, { method: "POST", body: JSON.stringify({ workspace }) });
}

export interface HiddenMeeting { id: string; date: string | null; restricted: true; redacted: true; can_delete: true }

export interface MeetingsStatus {
  ai: { enabled: boolean; reason: string | null; message: string | null };
  google: { configured: boolean; connected: boolean };
  folder_id: string | null;
  can_import: boolean;
  /** Workspace admins: "Organize meetings" (file every meeting in Meetings/<series> or Other meetings). */
  can_organize?: boolean;
  types: string[];
}

export interface DetectedMeeting {
  title: string | null;
  date: string | null;
  time: string | null;
  duration_s: number | null;
  attendees: string[];
  segments: number;
  has_notes: boolean;
  kinds: string[];
  truncated: boolean;
  sources: Array<{ name: string; kind: string; format: string; segments: number; speakers: string[] }>;
  /** Teams v1: the teams the attendees / the series point at (lib/teams TeamSuggestion). */
  team_suggestions?: { team_id: string; name: string; reason: "attendees" | "series"; matched: number }[];
}

export interface SourceIn { name?: string; text?: string; data_b64?: string; google_file_id?: string; origin?: "paste" | "upload" }

export const meetingsHref = (workspaceId: string) => `/meetings/${encodeURIComponent(workspaceId)}`;

export function getMeetingsStatus(workspace: string) {
  return request<MeetingsStatus>(`/api/v1/meetings/status?workspace=${encodeURIComponent(workspace)}`);
}

export type MeetingSort = "date_desc" | "date_asc" | "title" | "imported";
export const MEETING_SORTS: Record<MeetingSort, string> = {
  date_desc: "Meeting date, newest",
  date_asc: "Meeting date, oldest",
  title: "Title",
  imported: "Recently imported",
};
export const MEETINGS_PAGE = 30;

/** One meeting as the list shows it (the server's card: GET /meetings/{id} has the rest). */
export type MeetingCard = Pick<Meeting, "id" | "workspace_id" | "title" | "page_title" | "slug" | "transcript_slug" | "date" | "time"
  | "duration_s" | "type" | "attendees" | "restricted" | "action_items" | "segments" | "has_notes" | "has_transcript" | "created_at"
  | "can_delete" | "source" | "history" | "series" | "summary" | "decisions" | "open_questions" | "cover"> & {
  /** Everyone who was there (``attendees`` is the first five). */
  attendee_count: number;
  ai: Pick<MeetingAi, "state" | "message">;
  /** Teams v1: the teams it was routed to (empty: company-wide) and whether that was confirmed. */
  team_ids?: string[];
  teams?: { id: string; name: string; color: string; icon: string | null }[];
  routing_state?: "auto" | "confirmed" | null;
};

export interface MeetingsPage {
  meetings: MeetingCard[];
  /** Pass back as ``cursor`` (same filters and sort) for the next page; null: that was the last. */
  next_cursor: string | null;
  /** How many meetings match (first page only). */
  total: number | null;
  /** Workspace admins, first page, no filter: restricted meetings they can't open (no title). */
  hidden: HiddenMeeting[];
  folder_id?: string | null;
}

export interface MeetingsQuery { /** lib/teams Space. */ space?: string; q?: string; series?: string | null; since?: string; until?: string; sort?: MeetingSort; limit?: number; cursor?: string | null }

/** ``series``: a name, "" for meetings in no series, null/undefined for all. */
export function listMeetings(workspace: string, opts?: MeetingsQuery, init?: { signal?: AbortSignal }) {
  const qs = new URLSearchParams({ workspace });
  if (opts?.space) qs.set("space", opts.space);
  if (opts?.q?.trim()) qs.set("q", opts.q.trim());
  if (opts?.series != null) qs.set("series", opts.series === "" ? "none" : opts.series);
  if (opts?.since) qs.set("since", opts.since);
  if (opts?.until) qs.set("until", opts.until);
  if (opts?.sort && opts.sort !== "date_desc") qs.set("sort", opts.sort);
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  qs.set("limit", String(opts?.limit ?? MEETINGS_PAGE));
  // no-cache, not no-store: the browser revalidates with the ETag and a 304 costs no body (the refreshes
  // while a summary is being written).
  return request<MeetingsPage>(`/api/v1/meetings?${qs}`, { cache: "no-cache", signal: init?.signal });
}

export interface MeetingSeries { name: string; count: number; last: string | null }

/** The series of the meetings the caller can open (most meetings first), how many they can open, and how
 * many are in no series — the hub's chips. */
export function listSeries(workspace: string, space?: string) {
  return request<{ series: MeetingSeries[]; total?: number; one_offs?: number }>(`/api/v1/meetings/series?workspace=${encodeURIComponent(workspace)}${space ? `&space=${encodeURIComponent(space)}` : ""}`);
}

export function getMeeting(id: string) {
  return request<Meeting>(`/api/v1/meetings/${encodeURIComponent(id)}`);
}

/** `workspace` (Teams): each meeting then carries `team_suggestions` from its attendees and series. */
export function previewMeeting(sources: SourceIn[], workspace?: string) {
  return request<{ meetings: DetectedMeeting[] }>(`/api/v1/meetings/preview`, { method: "POST", body: JSON.stringify({ sources, ...(workspace ? { workspace } : {}) }) });
}

/** `team_ids` / `project_ids` (Teams): where it goes; omitted ⇒ the suggested teams (routing "auto"). */
export function importMeeting(body: { workspace: string; sources: SourceIn[]; title?: string; date?: string; type?: string; restricted?: boolean; team_ids?: string[]; project_ids?: string[] }) {
  return request<{ meetings: Meeting[] }>(`/api/v1/meetings/import`, { method: "POST", body: JSON.stringify(body) });
}

/** One pasted Google Docs / Drive link's outcome. */
export interface LinkResult {
  url: string;
  file_id?: string;
  status: "imported" | "attached" | "duplicate" | "queued" | "needs_access" | "error";
  message?: string;
  meeting_id?: string;
  meeting?: Meeting | null;
  connected?: boolean;
}

/** Up to 20 Google Docs / Drive links: Markdrop reads public ones; private ones go to your Google Meet script. */
export function importLinks(body: { workspace: string; urls: string[]; restricted?: boolean; team_ids?: string[]; project_ids?: string[] }) {
  return request<{ results: LinkResult[] }>(`/api/v1/meetings/import-link`, { method: "POST", body: JSON.stringify(body) });
}

/** Pulls the Drive file id out of a Docs / Drive link (the server checks again). */
export function driveFileId(url: string): string | null {
  const u = url.trim();
  const m = /^(?:https?:\/\/)?(?:docs|drive)\.google\.com\/.*?(?:\/d\/|[?&]id=)([A-Za-z0-9_-]{20,})/.exec(u);
  return m ? m[1] : /^[A-Za-z0-9_-]{25,}$/.test(u) ? u : null;
}

export function patchMeeting(id: string, body: { restricted?: boolean; type?: string; series?: string | null }) {
  return request<Meeting>(`/api/v1/meetings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteMeeting(id: string) {
  return request<{ deleted: boolean }>(`/api/v1/meetings/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function regenerateMeeting(id: string) {
  return request<Meeting>(`/api/v1/meetings/${encodeURIComponent(id)}/regenerate`, { method: "POST" });
}

export function googlePickerToken() {
  return request<{ access_token: string; api_key: string; app_id: string; client_id: string }>(`/api/v1/meetings/google/token`, { method: "POST" });
}

// ── Asking ────────────────────────────────────────────────────────────────────

export interface MeetingCitation {
  /** What the model wrote: "s12", "n3", "M2-s14", "M2". */
  label: string;
  kind: "segment" | "page";
  /** "Ada Lovelace, 12:34" / "Meeting notes" / "<meeting> · Nov 4, 2026". */
  text: string;
  href: string;
  slug?: string | null;
  meeting_id?: string;
  /** A transcript line's speaker and time ("12:34"), and what it (or a notes line) says. */
  speaker?: string | null;
  at?: string | null;
  quote?: string | null;
  key?: string;
}

export interface RankedMeeting { n: number; id: string; title: string | null; date: string | null; type: string | null; series?: string | null; slug: string }

/** Which meetings an answer across meetings used: given, or read from the question ("detected"). */
export interface AskScope { series: string | null; since: string | null; until: string | null; detected: boolean; label: string }

export type MeetingAskEvent =
  | { type: "status"; stage: "searching" | "answering" }
  | { type: "results"; items: RankedMeeting[]; scope?: AskScope | null }
  | { type: "delta"; text: string }
  | { type: "done"; answer: string; citations: MeetingCitation[]; ranked?: RankedMeeting[]; truncated?: boolean; scope?: AskScope | null; thread_id?: string | null }
  | { type: "limit"; reason: string; message: string }
  | { type: "error"; detail: string; code?: string };

async function stream(path: string, body: unknown, onEvent: (e: MeetingAskEvent) => void, signal?: AbortSignal) {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", detail: "Couldn't reach Markdrop. Check your connection and try again." });
    return;
  }
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => null);
    const detail = typeof j?.detail === "string" ? j.detail : res.status === 429 ? "You're asking very fast. Wait a moment." : "AI hit a problem. Try again.";
    onEvent({ type: "error", detail });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser((m) => {
    try {
      const data = JSON.parse(m.data);
      if (data && typeof data === "object") onEvent({ ...data, type: data.type ?? m.event } as MeetingAskEvent);
    } catch { /* a keep-alive or a broken line */ }
  });
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.end();
  } catch {
    if (!signal?.aborted) onEvent({ type: "error", detail: "The answer was interrupted. Try again." });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function askMeeting(id: string, body: { question: string; history?: Array<{ question: string; answer: string }>; thread_id?: string | null },
  onEvent: (e: MeetingAskEvent) => void, signal?: AbortSignal) {
  return stream(`/api/v1/meetings/${encodeURIComponent(id)}/ask`, body, onEvent, signal);
}

export function askMeetings(body: { workspace: string; question: string; series?: string; since?: string; until?: string;
  history?: Array<{ question: string; answer: string }>; thread_id?: string | null },
  onEvent: (e: MeetingAskEvent) => void, signal?: AbortSignal) {
  return stream(`/api/v1/meetings/ask`, body, onEvent, signal);
}

// ── Import past meetings (routers/meetings_backfill.py) ──────────────────────

export type BackfillState = "draft" | "running" | "paused" | "waiting" | "done" | "cancelled";
export type BackfillRowState = "pending" | "importing" | "imported" | "attached" | "duplicate" | "skipped" | "failed";

export interface BackfillRow {
  id: string;
  /** The files (or pasted texts) this meeting was found in: Google's notes and the transcript pair up. */
  names: string[];
  kinds: Array<"notes" | "transcript">;
  title: string | null;
  date: string | null;
  time: string | null;
  /** Where the date came from: the file's name, the Google Doc's creation day, the text, or the person. */
  date_from: "title" | "created" | "content" | "user" | null;
  series: string | null;
  series_from: "auto" | "user";
  include: boolean;
  needs_date: boolean;
  /** Against the workspace's meetings: new, already here (skipped), or the missing half of one already here. */
  dup: { status: "new" | "duplicate" | "attach"; meeting_id?: string; title?: string | null; date?: string | null; why?: "file" | "call" | "batch"; row?: string };
  state: BackfillRowState;
  error: string | null;
  meeting_id: string | null;
  slug: string | null;
  segments: number;
  attendees: string[];
  order?: number | null;
  /** Older than a day: never posted to Slack, whatever the switch says. */
  past: boolean;
  /** Where it's filed: the series' folder, or "Other meetings" (both inside Meetings). */
  folder: string;
  /** Only its attendees (a 1:1 or two-person call by default), or the team. */
  restricted: boolean;
  restricted_from: "auto" | "user" | "job";
}

export interface BackfillJob {
  id: string;
  workspace_id: string;
  state: BackfillState;
  quiet: boolean;
  restricted: boolean;
  created_at: string | null;
  started_at: string | null;
  done_at: string | null;
  wait: { reason: string; until: string | null; message: string | null } | null;
  counts: { rows: number; included: number; done: number; imported: number; attached: number; duplicate: number; skipped: number; failed: number; pending: number; needs_date: number };
  problems: Array<{ name: string; error: string; kind?: string }>;
  rows: BackfillRow[];
  /** How many get an AI summary, and whether that's more than today's fair-use limit (`may_wait`). Never an amount. */
  estimate?: { meetings: number; may_wait: boolean; ai: boolean; ai_message: string | null };
}

export interface BackfillSource extends SourceIn { created?: string }

const BF = "/api/v1/meetings/backfill";

export function listBackfills(workspace: string) {
  return request<{ jobs: BackfillJob[] }>(`${BF}?workspace=${encodeURIComponent(workspace)}`);
}
export function createBackfill(body: { workspace: string; quiet?: boolean; restricted?: boolean }) {
  return request<BackfillJob>(BF, { method: "POST", body: JSON.stringify(body) });
}
export function getBackfill(id: string) {
  return request<BackfillJob>(`${BF}/${encodeURIComponent(id)}`);
}
export function addBackfillSources(id: string, sources: BackfillSource[]) {
  return request<BackfillJob>(`${BF}/${encodeURIComponent(id)}/sources`, {
    method: "POST", body: JSON.stringify({ sources, tz_offset_min: -new Date().getTimezoneOffset() }),
  });
}
export function editBackfill(id: string, body: { quiet?: boolean; restricted?: boolean; rows?: Array<{ id: string; title?: string; date?: string; series?: string | null; include?: boolean; restricted?: boolean }> }) {
  return request<BackfillJob>(`${BF}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
}
export function removeBackfillRow(id: string, row: string) {
  return request<BackfillJob>(`${BF}/${encodeURIComponent(id)}/rows/${encodeURIComponent(row)}`, { method: "DELETE" });
}
export function backfillAction(id: string, action: "start" | "pause" | "resume") {
  return request<BackfillJob>(`${BF}/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}
export function retryBackfillRow(id: string, row: string) {
  return request<BackfillJob>(`${BF}/${encodeURIComponent(id)}/rows/${encodeURIComponent(row)}/retry`, { method: "POST" });
}
/** "Organize meetings" (admins): what a run would do now. */
export interface OrganizePreview {
  meetings: number;
  /** Series folders the meetings end up in (Meetings/<Series>); the rest go to Other meetings. */
  series: number;
  other: number;
  to_move: number;
  series_set: number;
  transcripts_to_hide: number;
  series_names: Array<{ name: string; count: number }>;
}
/** A run of "Organize meetings": a background job on the server (one per workspace). */
export interface OrganizeJob {
  id: string;
  workspace: string;
  state: "running" | "done" | "failed";
  phase: "prepare" | "files" | "done" | null;
  total: number;
  done: number;
  /** Meetings moved into another folder. */
  filed: number;
  series_set: number;
  covers: number;
  errors: number;
  folders: number;
  series: number;
  transcripts_hidden: number;
  duplicates_removed: number;
  error_samples: Array<{ title: string; error: string }>;
  message: string | null;
  started_at: string | null;
  done_at: string | null;
}
export function getOrganize(workspace: string) {
  return request<{ preview: OrganizePreview; job: OrganizeJob | null }>(`/api/v1/meetings/organize?workspace=${encodeURIComponent(workspace)}`);
}
/** Starts a run (202), or joins the one already running. */
export function organizeMeetings(workspace: string) {
  return request<{ job: OrganizeJob }>(`/api/v1/meetings/organize`, { method: "POST", body: JSON.stringify({ workspace }) });
}
export function getOrganizeRun(id: string) {
  return request<{ job: OrganizeJob }>(`/api/v1/meetings/organize/${encodeURIComponent(id)}`);
}

export function discardBackfill(id: string) {
  return request<{ deleted: boolean; stopped?: boolean }>(`${BF}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Several meetings pasted at once: split at a line of three or more "=" (or "———"). */
export function splitPasted(text: string): string[] {
  return text.split(/^\s*(?:={3,}|—{3,}|-{3,}\s*next meeting\s*-{3,})\s*$/im).map((t) => t.trim()).filter(Boolean);
}

/** "2026-10" → "October 2026". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return "No date";
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

// ── Small helpers (pure) ──────────────────────────────────────────────────────

export function fmtMeetingDate(d: string | null | undefined): string {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function fmtDuration(s: number | null | undefined): string {
  if (!s) return "";
  const m = Math.max(1, Math.round(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** A file → a source: text files as text, a .docx as base64 (the server reads it). */
export async function fileToSource(file: File): Promise<SourceIn> {
  const name = file.name;
  if (/\.docx$/i.test(name)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { name, data_b64: btoa(bin), origin: "upload" };
  }
  return { name, text: await file.text(), origin: "upload" };
}

export const ACCEPT = ".txt,.vtt,.srt,.sbv,.docx,.md,text/plain,text/vtt";
export const MAX_FILE_BYTES = 4_000_000;

/** Splits an answer at its citations: text pieces and citation labels in order. */
export function splitCitations(answer: string): Array<{ text: string } | { label: string }> {
  const out: Array<{ text: string } | { label: string }> = [];
  const re = /\[((?:M\d{1,2}(?:-[sn]\d{1,5})?)|(?:[sn]\d{1,5}))\]/g;
  let last = 0;
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    if (m.index > last) out.push({ text: answer.slice(last, m.index) });
    out.push({ label: m[1] });
    last = m.index + m[0].length;
  }
  if (last < answer.length) out.push({ text: answer.slice(last) });
  return out;
}
