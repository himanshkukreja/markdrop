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
 *
 * Kept out of lib/api.ts (that one loads on public pages).
 */
import { request } from "@/lib/workspaces";

export interface HubSpotScope { scope: string; why: string; required: boolean }
export interface HubSpotTeam { id: string; name: string; visibility: "open" | "private"; slug?: string | null }

export type HubSpotSwitch = "auto_log" | "suggest" | "accounts" | "precall" | "approve";

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

export interface HubSpotMe { teams: Array<{ workspace_id: string; workspace: string | null; team: string | null }>; precall: boolean; approve: boolean }
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
