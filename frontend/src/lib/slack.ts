/**
 * Markdrop for Slack's client (backend routers/slack.py; .work/slack/SPEC.md):
 *
 *   GET    /api/v1/slack/status?workspace_id=      the card: set up?, the connected team, me (linked?, prefs)
 *   POST   /api/v1/slack/install                   {workspace_id} → {url}: Add to Slack (admins)
 *   POST   /api/v1/slack/connect                   {code, state}: the end of Add to Slack
 *   DELETE /api/v1/slack/install?workspace_id=     disconnect (admins)
 *   GET    /api/v1/slack/channels?workspace_id=    channels for meeting posts (admins)
 *   PATCH  /api/v1/slack/settings                  {workspace_id, meetings_channel_id?, clear_channel?, post_meetings?}
 *   POST   /api/v1/slack/link/start                {workspace_id | team_id} → {url}: Sign in with Slack
 *   GET    /api/v1/slack/link/info?team_id=        the Slack workspace a link page is for
 *   POST   /api/v1/slack/link/finish               {code, state}
 *   DELETE /api/v1/slack/link?workspace_id=        unlink my Slack account
 *   GET    /api/v1/slack/me                        Slack notifications (Settings › Account): on?, kinds, my Slack teams
 *   PUT    /api/v1/slack/me/notifications          {on}: turn them on (finds me by my own email) or off
 *   PATCH  /api/v1/slack/me/prefs                  my Slack direct messages, per kind
 *   POST   /api/v1/slack/meetings/{id}/post        post a meeting to the meetings channel (again)
 *
 * Kept out of lib/api.ts (that one loads on public pages).
 */
import { request } from "@/lib/workspaces";

export type SlackNotifyKind = "mention" | "signoff_requested" | "shared" | "access_request";

export interface SlackChannel { id: string; name: string; private: boolean; shared?: boolean }

export interface SlackInstall {
  team_id: string;
  team_name: string;
  installed_by: string | null;
  installed_at: string | null;
  meetings_channel: SlackChannel | null;
  post_meetings: boolean;
  linked_people: number;
  token_ok: boolean;
  /** False: installed before Markdrop could find people by email; an admin updates the app (Add to Slack again). */
  can_find_by_email: boolean;
}

/** How a Slack account got linked: found by email, Sign in with Slack, the installer, or from before opt-in. */
export type SlackMatch = "email" | "oauth" | "install" | "legacy";

export interface SlackStatus {
  configured: boolean;
  can_manage: boolean;
  install: SlackInstall | null;
  me: {
    linked: boolean; slack_user_id: string | null; slack_name: string | null; match: SlackMatch | null;
    /** Slack notifications turned on (off by default; Settings › Account). */
    on: boolean;
    prefs: Record<SlackNotifyKind, boolean>;
  };
  kinds: Array<{ key: SlackNotifyKind; label: string }>;
}

export interface SlackTeam {
  team_id: string;
  team_name: string;
  workspace_id: string;
  workspace_name: string;
  linked: boolean;
  slack_name: string | null;
  match: SlackMatch | null;
  can_find_by_email: boolean;
  token_ok: boolean;
}

export type SlackFindResult = "linked" | "matched" | "not_found" | "taken" | "needs_update" | "token" | "error";

export interface SlackMe {
  configured: boolean;
  on: boolean;
  prefs: Record<SlackNotifyKind, boolean>;
  kinds: Array<{ key: SlackNotifyKind; label: string }>;
  /** Slack workspaces connected to Markdrop workspaces you're in. */
  teams: SlackTeam[];
  email: string;
  /** PUT /me/notifications only: what turning it on found, per team. */
  results?: Array<{ team_id: string; team_name: string; result: SlackFindResult; message: string | null }>;
}

const q = (ws: string) => `workspace_id=${encodeURIComponent(ws)}`;

export const slackStatus = (ws: string) => request<SlackStatus>(`/api/v1/slack/status?${q(ws)}`);

export const slackInstallUrl = (ws: string) =>
  request<{ url: string }>("/api/v1/slack/install", { method: "POST", body: JSON.stringify({ workspace_id: ws }) });

export const slackConnect = (code: string, state: string) =>
  request<SlackStatus>("/api/v1/slack/connect", { method: "POST", body: JSON.stringify({ code, state }) });

export const slackDisconnect = (ws: string) =>
  request<SlackStatus>(`/api/v1/slack/install?${q(ws)}`, { method: "DELETE" });

export const slackChannels = (ws: string) => request<{ channels: SlackChannel[] }>(`/api/v1/slack/channels?${q(ws)}`);

export const slackSettings = (ws: string, patch: { meetings_channel_id?: string; clear_channel?: boolean; post_meetings?: boolean }) =>
  request<SlackStatus>("/api/v1/slack/settings", { method: "PATCH", body: JSON.stringify({ workspace_id: ws, ...patch }) });

export const slackLinkStart = (body: { workspace_id?: string; team_id?: string }) =>
  request<{ url: string }>("/api/v1/slack/link/start", { method: "POST", body: JSON.stringify(body) });

export const slackLinkInfo = (team: string) =>
  request<{ team_id: string; team_name: string; linked: boolean; slack_name: string | null }>(
    `/api/v1/slack/link/info?team_id=${encodeURIComponent(team)}`);

export const slackLinkFinish = (code: string, state: string) =>
  /** `workspace_id`: the connected workspace when you're a member of it (else null: just say it's linked). */
  request<{ team_id: string; team_name: string; workspace_id: string | null; linked: boolean; slack_name: string | null }>(
    "/api/v1/slack/link/finish", { method: "POST", body: JSON.stringify({ code, state }) });

export const slackUnlink = (ws: string) => request<SlackStatus>(`/api/v1/slack/link?${q(ws)}`, { method: "DELETE" });

export const slackMe = () => request<SlackMe>("/api/v1/slack/me");

export const slackSetNotifications = (on: boolean) =>
  request<SlackMe>("/api/v1/slack/me/notifications", { method: "PUT", body: JSON.stringify({ on }) });

export const slackPrefs = (patch: Partial<Record<SlackNotifyKind, boolean>>) =>
  request<{ prefs: Record<SlackNotifyKind, boolean> }>("/api/v1/slack/me/prefs", { method: "PATCH", body: JSON.stringify(patch) });

export const slackPostMeeting = (meetingId: string) =>
  request<{ posted: boolean; channel: string | null }>(`/api/v1/slack/meetings/${encodeURIComponent(meetingId)}/post`, { method: "POST" });

/** Which round trip a state belongs to ("install" | "link"), and its workspace (install only). The
 *  server checks the signature; this only picks which endpoint finishes it. */
export function readSlackState(state: string): { kind: string | null; workspace: string | null } {
  try {
    const body = state.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const data = JSON.parse(atob(body + "=".repeat((4 - (body.length % 4)) % 4)));
    return { kind: typeof data.k === "string" ? data.k : null, workspace: typeof data.w === "string" ? data.w : null };
  } catch {
    return { kind: null, workspace: null };
  }
}

const RETURN_KEY = "md_slack_return";

/** Where Sign in with Slack should land afterwards, when not the workspace's Integrations tab (the
 *  account card's "Link my Slack account" comes back to Settings › Account). Only same-site paths. */
export function setSlackReturn(path: string): void {
  try { if (path.startsWith("/") && !path.startsWith("//")) sessionStorage.setItem(RETURN_KEY, path); } catch { /* ignore */ }
}

export function takeSlackReturn(): string | null {
  try {
    const v = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    return v && v.startsWith("/") && !v.startsWith("//") ? v : null;
  } catch {
    return null;
  }
}
