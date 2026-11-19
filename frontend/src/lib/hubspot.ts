/**
 * HubSpot's client (backend routers/hubspot.py; docs integrations/hubspot):
 *
 *   GET    /api/v1/hubspot/status?workspace_id=          the Integrations card
 *   PUT    /api/v1/hubspot/connection                    {workspace_id, token?, team_id?}
 *   PUT    /api/v1/hubspot/team                          {workspace_id, team_id}
 *   PUT    /api/v1/hubspot/settings                      {workspace_id, auto_log}
 *   DELETE /api/v1/hubspot/connection?workspace_id=
 *   GET    /api/v1/hubspot/meetings/{id}                 the meeting panel's HubSpot section
 *   POST   /api/v1/hubspot/meetings/{id}/match           match again
 *   PUT    /api/v1/hubspot/meetings/{id}/match           {deal_id | null}
 *   POST   /api/v1/hubspot/meetings/{id}/log             Log to HubSpot
 *   POST   /api/v1/hubspot/meetings/{id}/tasks           {keys}
 *   GET    /api/v1/hubspot/deals?workspace_id=&q=        deal search (Change match)
 *   POST   /api/v1/hubspot/meetings/{id}/suggestions     suggest deal updates again
 *   POST   /api/v1/hubspot/meetings/{id}/suggestions/{sid}/apply | /dismiss
 *   POST   /api/v1/hubspot/meetings/{id}/account         make or update the account page
 *   GET    /api/v1/hubspot/pipeline?workspace_id=        deals, last call, at risk
 *   GET    /api/v1/hubspot/me, PUT {precall?, approve?}  your own HubSpot messages
 *   GET    /api/v1/hubspot/deals/board?workspace_id=     the Deals section (board / list; filters are client-side)
 *   GET    /api/v1/hubspot/deals/{id}?workspace_id=&fresh=  a deal page (overview, calls, assets, activity)
 *   POST   /api/v1/hubspot/deals/sync                    {workspace_id} Sync now (workspace admins) → the board's sync
 *   GET    /api/v1/hubspot/meetings/{id}/chip            the meeting page's deal chip (cheap; no HubSpot call)
 *
 * Kept out of lib/api.ts (that one loads on public pages).
 */
import { request } from "@/lib/workspaces";

export interface HubSpotScope { scope: string; why: string; required: boolean }
export interface HubSpotTeam { id: string; name: string; visibility: "open" | "private"; slug?: string | null }

export type HubSpotSwitch = "auto_log" | "suggest" | "precall" | "approve";

export interface HubSpotStatus {
  /** The workspace's switches (auto_log off by default, the rest on). */
  switches?: Record<HubSpotSwitch, boolean>;
  /** Whether the key may change deals (Apply on a suggested update). */
  deals_write?: "granted" | "missing" | "unchecked" | null;
  configured: boolean;
  can_manage: boolean;
  connected: boolean;
  mode: "token" | "oauth" | null;
  /** Admins only: the scopes the key needs. */
  scopes_needed: HubSpotScope[] | null;
  team: HubSpotTeam | null;
  teams: HubSpotTeam[] | null;
  auto_log: boolean;
  /** The signed-in person can use HubSpot on the team's meetings (a member of the team, or an admin). */
  can_use: boolean;
  connection: {
    portal_id: string | null; connected_at: string | null; broken: string | null;
    logged: number; created: number; tasks: number; auto: number; last_log_at: string | null; url: string;
    connected_by?: string | null; checked_at?: string | null; missing_scopes?: HubSpotScope[];
    unchecked_scopes?: string[]; scopes_from?: "token_info" | "probe" | null; last_error?: string | null;
  } | null;
}

export interface HubSpotDeal {
  id: string; name: string; stage: string | null; pipeline: string | null; closed: boolean;
  amount: number | null; currency: string | null; close_date: string | null; owner: string | null; owner_id: string | null;
  url: string | null;
}

export interface HubSpotTask {
  key: string; text: string; owner_said: string | null; due: string; due_said: string | null;
  assignee: { owner_id: string; name: string | null; from: "named" | "deal_owner" | "host" } | null;
  created: { id: string; at: string | null } | null; pending: boolean;
}

export interface HubSpotEvidence { ref: string; quote: string | null; speaker: string | null; at: string | null; href: string | null }

export interface HubSpotSuggestion {
  id: string; field: string; label: string; kind: "stage" | "date" | "number" | "text" | "enum";
  value: string; display: string; current: string | null; why: string | null; evidence: HubSpotEvidence[];
  state: "open" | "applying" | "applied" | "dismissed" | "failed"; error: string | null; at: string | null;
}

export interface HubSpotPanel {
  suggestions?: {
    enabled: boolean; state: "done" | "failed" | "skipped" | null; reason: string | null; message: string | null;
    at: string | null; items: HubSpotSuggestion[]; can_suggest: boolean;
  } | null;
  account?: { name: string | null; slug: string; href: string; updated_at: string | null } | null;
  deals_write?: "granted" | "missing" | "unchecked";
  available: boolean;
  /** Why HubSpot doesn't apply to this meeting. */
  reason: "not_connected" | "not_team" | "not_member" | null;
  auto_log: boolean;
  broken?: string | null;
  match: {
    how: "meeting" | "contacts" | "names" | "user" | "none"; confidence: "high" | "medium" | "low" | "none";
    detail: string | null; meeting_found: boolean; deal_id: string | null;
    candidates: Array<{ id: string; name: string | null }>; at: string | null; by_person: boolean;
  } | null;
  deal: HubSpotDeal | null;
  contacts: Array<{ id: string; name: string | null; email: string | null; url: string | null }>;
  companies: Array<{ id: string; name: string | null; url: string | null }>;
  logged: { at: string | null; by: string | null; auto: boolean; created: boolean; meeting_id: string; url: string | null } | null;
  tasks: HubSpotTask[];
  error: string | null;
  portal_url?: string;
  results?: Array<{ key: string; status: "created" | "exists" | "failed"; id?: string; reason?: string }>;
}

const q = (ws: string) => `workspace_id=${encodeURIComponent(ws)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const hubspotStatus = (ws: string) => request<HubSpotStatus>(`/api/v1/hubspot/status?${q(ws)}`);
export const hubspotConnect = (body: { workspace_id: string; token?: string | null; team_id?: string | null }) =>
  request<HubSpotStatus>("/api/v1/hubspot/connection", json("PUT", body));
export const hubspotSetTeam = (ws: string, team_id: string) => request<HubSpotStatus>("/api/v1/hubspot/team", json("PUT", { workspace_id: ws, team_id }));
export const hubspotSetAutoLog = (ws: string, auto_log: boolean) => request<HubSpotStatus>("/api/v1/hubspot/settings", json("PUT", { workspace_id: ws, auto_log }));
export const hubspotSetSwitch = (ws: string, key: HubSpotSwitch, on: boolean) =>
  request<HubSpotStatus>("/api/v1/hubspot/settings", json("PUT", { workspace_id: ws, [key]: on }));
export const hubspotDisconnect = (ws: string) => request<HubSpotStatus>(`/api/v1/hubspot/connection?${q(ws)}`, { method: "DELETE" });

const m = (id: string) => `/api/v1/hubspot/meetings/${encodeURIComponent(id)}`;
export const hubspotMeeting = (id: string) => request<HubSpotPanel>(m(id));
export const hubspotRematch = (id: string) => request<HubSpotPanel>(`${m(id)}/match`, { method: "POST" });
export const hubspotSetMatch = (id: string, deal_id: string | null) => request<HubSpotPanel>(`${m(id)}/match`, json("PUT", { deal_id }));
export const hubspotLog = (id: string) => request<HubSpotPanel>(`${m(id)}/log`, { method: "POST" });
export const hubspotCreateTasks = (id: string, keys: string[]) => request<HubSpotPanel>(`${m(id)}/tasks`, json("POST", { keys }));
export const hubspotSuggest = (id: string) => request<HubSpotPanel>(`${m(id)}/suggestions`, { method: "POST" });
export const hubspotApply = (id: string, sid: string) => request<HubSpotPanel>(`${m(id)}/suggestions/${encodeURIComponent(sid)}/apply`, { method: "POST" });
export const hubspotDismiss = (id: string, sid: string) => request<HubSpotPanel>(`${m(id)}/suggestions/${encodeURIComponent(sid)}/dismiss`, { method: "POST" });
export const hubspotAccount = (id: string) =>
  request<{ name: string | null; slug: string; href: string; updated_at: string | null }>(`${m(id)}/account`, { method: "POST" });

export interface HubSpotMe {
  /** The HubSpot teams you're in (one per workspace): Deals (all teams) reads each one's board. */
  teams: Array<{ workspace_id: string; workspace: string | null; team: string | null; team_id?: string | null }>;
  precall: boolean; approve: boolean;
}
export const hubspotMe = () => request<HubSpotMe>("/api/v1/hubspot/me");
export const hubspotSetMe = (body: { precall?: boolean; approve?: boolean }) => request<HubSpotMe>("/api/v1/hubspot/me", json("PUT", body));

export const hubspotDeals = (ws: string, query: string) =>
  request<{ deals: HubSpotDeal[] }>(`/api/v1/hubspot/deals?${q(ws)}&q=${encodeURIComponent(query)}`);

/** "$48,000" in the deal's currency (no decimals for whole amounts). */
export function fmtAmount(amount: number | null, currency: string | null): string | null {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
  } catch {
    return `${amount}${currency ? ` ${currency}` : ""}`;
  }
}

/* ── Deal folders: the Deals section, a deal page, the meeting chip ─────────────────────────────── */

/** An optional read scope the HubSpot key lacks (emails, attachments). */
export interface DealMissingScope { scope: string; why?: string; what?: string }

export interface DealCard {
  id: string;
  name: string;
  company: { id: string; name: string } | null;
  /** "<Company> — <Deal>" (the folder's name). */
  title: string;
  stage_id: string | null; stage: string | null; pipeline: string | null; pipeline_id: string | null;
  closed: boolean; closed_label: "Closed won" | "Closed lost" | null;
  amount: number | null; currency: string | null; owner: string | null; owner_id: string | null;
  close_date: string | null;
  /** The deal in HubSpot. */
  url: string;
  /** The Markdrop folder its calls and assets are in. */
  folder_id: string | null;
  calls: number;
  last_call: { date: string | null; title: string; slug: string } | null;
  days_quiet: number | null;
  /** No call in 14+ days (or never). */
  quiet: boolean;
  /** Calls waiting for "Pick the deal" that could be this deal. */
  pick: number;
  updated_at: string | null;
}

export interface DealSync { at: string | null; state: "idle" | "running" | "error"; last_error: string | null; deals: number; next_at: string | null }
export interface DealStage { id: string; label: string; pipeline: string | null; pipeline_id: string | null; closed: boolean }

export interface DealBoard {
  team: { id: string; name: string; slug: string } | null;
  /** Workspace admins: Sync now. */
  can_sync: boolean;
  sync: DealSync;
  /** Board columns in pipeline order (open stages, and the closed ones). */
  stages: DealStage[];
  pipelines: Array<{ id: string; label: string }>;
  deals: DealCard[];
  missing_scopes: DealMissingScope[];
  /** The portal's deals in HubSpot ("Open HubSpot"). */
  portal_url?: string | null;
}

export interface DealLine { text: string; date: string | null; slug: string }
export interface DealCallRow {
  meeting_id: string; title: string; date: string | null; slug: string; href: string;
  how: string | null; confidence: string | null; logged: { at: string | null } | null;
  /** Action items in the call. */
  actions: number; tasks_created: number; suggestions_open: number;
  /** How long the call was, a line of its summary, a kept recording, a transcript page. */
  duration_s?: number | null; summary?: string | null; recording?: boolean; transcript?: boolean;
}
export interface DealActivity {
  kind: "note" | "email" | "meeting" | "task" | "call"; id: string; at: string | null; title: string | null; preview: string | null;
  direction?: "in" | "out" | null; status?: string | null; owner?: string | null; url: string | null;
}
export interface DealDetail {
  deal: DealCard & { contacts: Array<{ id: string; name: string | null; title: string | null; email: string | null; url: string | null }> };
  /** The "Deal overview" page in the folder (people's own notes live outside its kept section). */
  overview: { slug: string; href: string; updated_at: string | null } | null;
  folder: { id: string; name: string; href: string } | null;
  rollup: {
    decisions: DealLine[]; risks: DealLine[]; questions: DealLine[]; next_steps: DealLine[];
    last_call: { date: string | null; title: string; slug: string } | null;
  };
  /** Filed in this deal, newest first. */
  calls: DealCallRow[];
  /** Matched only to the company / contacts with several open deals (this one among them): "File here". */
  pick: DealCallRow[];
  suggestions: Array<{ meeting_id: string; title: string; date: string | null; slug: string; items: HubSpotSuggestion[] }>;
  activity: { items: DealActivity[]; missing: DealMissingScope[]; at: string | null };
  attachments: { items: Array<{ id: string; name: string; ext: string | null; size: number | null; at: string | null; url: string }>; missing: DealMissingScope[] };
  can_sync: boolean;
  /** Optional: whether the key may change deals (Apply on a suggested update), as on the meeting panel. */
  deals_write?: "granted" | "missing" | "unchecked" | null;
}

export interface MeetingDealChip {
  deal: { id: string; name: string; company: string | null; stage: string | null; closed_label: string | null; href: string } | null;
  /** The call isn't filed in a deal (no match, or a low one): "Pick the deal". False once a person chose none. */
  pick: boolean;
  workspace_id?: string;
}

export const dealsBoard = (ws: string) => request<DealBoard>(`/api/v1/hubspot/deals/board?${q(ws)}`);
export const dealDetail = (ws: string, dealId: string, fresh = false) =>
  request<DealDetail>(`/api/v1/hubspot/deals/${encodeURIComponent(dealId)}?${q(ws)}${fresh ? "&fresh=1" : ""}`);
export const dealsSync = (ws: string) => request<DealSync>("/api/v1/hubspot/deals/sync", json("POST", { workspace_id: ws }));
export const meetingDealChip = (id: string) => request<MeetingDealChip>(`${m(id)}/chip`);
