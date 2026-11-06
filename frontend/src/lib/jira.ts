/**
 * Jira Cloud's client (backend routers/jira.py; docs integrations/jira):
 *
 *   GET    /api/v1/jira/status?workspace_id=        the workspace card: set up?, the site, me
 *   POST   /api/v1/jira/connect/start               {kind: "site"|"me", workspace_id?, back?} → {url}
 *   POST   /api/v1/jira/connect/finish              {code, state}
 *   GET    /api/v1/jira/sites?workspace_id=         the sites my connection reaches (admins)
 *   GET    /api/v1/jira/projects?workspace_id=&cloud_id=
 *   GET    /api/v1/jira/issue-types?workspace_id=&project=
 *   PUT    /api/v1/jira/site                        {workspace_id, cloud_id, projects, default_project, default_issue_type}
 *   DELETE /api/v1/jira/site?workspace_id=
 *   GET    /api/v1/jira/me     DELETE /api/v1/jira/me
 *   GET    /api/v1/jira/page?slug=                  a page's chips for me
 *   POST   /api/v1/jira/draft  /draft/all  /issues  /issues/bulk  /links  /lookup
 *   DELETE /api/v1/jira/links/{id}   POST /api/v1/jira/links/{id}/retry
 *   GET    /api/v1/jira/team/{ws}   /team/{ws}/people/{user}
 *
 * Kept out of lib/api.ts (that one loads on public pages).
 */
import { request } from "@/lib/workspaces";

export type JiraCategory = "new" | "indeterminate" | "done";

export interface JiraIssue {
  key: string;
  summary: string | null;
  status: { name: string; category: JiraCategory };
  assignee: { account_id: string; name: string; avatar?: string | null } | null;
  due: string | null;
  priority: string | null;
  project: { key: string | null; name: string | null } | null;
  type: string | null;
  url: string | null;
  blocked: boolean;
  updated: string | null;
  resolved: string | null;
  labels: string[];
  overdue?: boolean;
}

export interface JiraSite { id: string; url: string; name: string }

export interface JiraMe {
  connected: boolean;
  name: string | null;
  avatar?: string | null;
  broken: boolean;
  reaches_site: boolean;
  sites?: Array<{ id: string; name: string; url: string }>;
}

export interface JiraStatus {
  configured: boolean;
  can_manage: boolean;
  site: {
    cloud_id: string; name: string; url: string; connected_by: string | null; connected_at: string | null;
    /** The projects that feed Team (none: Team shows nothing from Jira). */
    projects: string[];
    default_project: string | null; default_issue_type: string | null;
    connector_ok: boolean;
    webhook: { ok: boolean; error: string | null; expires_at: string | null };
    connected_people: number;
  } | null;
  me: JiraMe;
}

export interface JiraAccount extends JiraMe {
  configured: boolean;
  workspaces: Array<{ workspace_id: string; workspace_name: string | null; site: string; url: string; reaches: boolean }>;
}

export interface JiraLink {
  id: string;
  key: string;
  block: string | null;
  fact_id: string | null;
  kind: string | null;
  url: string | null;
  /** Only when your own Jira connection can open the issue. */
  issue: JiraIssue | null;
  sync: { state: "ok" | "error" | "pending"; message: string | null };
}

export interface JiraPage {
  configured: boolean;
  site: { name: string; url: string } | null;
  connected: boolean;
  can_create: boolean;
  can_edit: boolean;
  links: Record<string, JiraLink>;
}

export interface JiraProject { key: string; name: string; id?: string }
export interface JiraOption { id: string; name: string }
export interface JiraPerson { user_id: string; name: string; account_id: string | null }

export interface JiraDraftFields {
  project: string | null;
  issue_type: string;
  summary: string;
  description: string;
  priority: string | null;
  assignee: { user_id: string; name: string; account_id: string | null } | null;
  due: string | null;
  labels: string[];
}

export interface JiraDraft {
  source: {
    slug: string | null; block: string | null; offset: number | null; fact_id: string | null; kind: string;
    kind_label: string; text: string; title: string | null; url: string | null; restricted: boolean;
    meeting: { id: string; title: string | null; date: string | null; date_label: string | null } | null;
    moment: { clock: string; url: string } | null;
  };
  draft: JiraDraftFields;
  ai: boolean;
  note: string | null;
  /** Restricted page: who the link back works for. */
  notice: string | null;
  meta: {
    projects: JiraProject[]; issue_types: JiraOption[]; priorities: JiraOption[]; people: JiraPerson[];
    site: { name: string; url: string }; backlink: string;
  };
}

export interface JiraItemRef {
  slug?: string | null;
  block?: string | null;
  offset?: number | null;
  selection?: string | null;
  fact_id?: string | null;
}

export interface JiraCreateFields {
  project: string;
  issue_type?: string | null;
  summary: string;
  description?: string;
  priority?: string | null;
  assignee_user_id?: string | null;
  assignee_account_id?: string | null;
  due?: string | null;
  labels?: string[];
}

export interface JiraCreated { key: string; url: string; issue: JiraIssue | null; link: JiraLink | null }

export interface JiraTeamCounts { todo: number; in_progress: number; done_recent: number; overdue: number; blocked: number }

export interface JiraTeam {
  configured: boolean;
  /** off: no site; no_projects: no project chosen for Team; counts: you aren't connected; details: you are. */
  mode: "off" | "no_projects" | "counts" | "details";
  site: { name: string; url: string; projects: string[] } | null;
  people: Record<string, { matched: boolean; counts: JiraTeamCounts; top: JiraIssue[] }>;
  team: (JiraTeamCounts & {
    projects: Array<{ key: string; name: string; open: number; overdue: number; done_recent: number }>;
    connected_people: number;
    overdue_issues?: JiraIssue[];
    blocked_issues?: JiraIssue[];
  }) | null;
  error: boolean;
}

export interface JiraPersonView {
  configured: boolean;
  mode: JiraTeam["mode"];
  site: { name: string; url: string } | null;
  matched: boolean;
  counts: JiraTeamCounts | null;
  groups: Array<{ key: string; label: string; issues: JiraIssue[] }>;
}

const q = (ws: string) => `workspace_id=${encodeURIComponent(ws)}`;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const jiraStatus = (ws: string) => request<JiraStatus>(`/api/v1/jira/status?${q(ws)}`);
export const jiraStart = (body: { kind: "site" | "me"; workspace_id?: string | null; back?: string | null }) =>
  request<{ url: string }>("/api/v1/jira/connect/start", post(body));
export const jiraFinish = (code: string, state: string) =>
  request<{ kind: "site" | "me"; workspace_id: string | null; back: string | null; sites: JiraSite[]; account: { name: string | null } }>(
    "/api/v1/jira/connect/finish", post({ code, state }));
export const jiraSites = (ws: string) => request<{ sites: JiraSite[] }>(`/api/v1/jira/sites?${q(ws)}`);
export const jiraProjects = (ws: string, cloud?: string | null) =>
  request<{ projects: JiraProject[] }>(`/api/v1/jira/projects?${q(ws)}${cloud ? `&cloud_id=${encodeURIComponent(cloud)}` : ""}`);
export const jiraIssueTypes = (ws: string, project: string, cloud?: string | null) =>
  request<{ issue_types: JiraOption[] }>(`/api/v1/jira/issue-types?${q(ws)}&project=${encodeURIComponent(project)}${cloud ? `&cloud_id=${encodeURIComponent(cloud)}` : ""}`);
export const jiraSetSite = (body: { workspace_id: string; cloud_id: string; projects: string[]; default_project: string | null; default_issue_type: string | null }) =>
  request<JiraStatus>("/api/v1/jira/site", { method: "PUT", body: JSON.stringify(body) });
export const jiraDisconnectSite = (ws: string) => request<JiraStatus>(`/api/v1/jira/site?${q(ws)}`, { method: "DELETE" });
export const jiraMe = () => request<JiraAccount>("/api/v1/jira/me");
export const jiraDisconnectMe = () => request<JiraAccount>("/api/v1/jira/me", { method: "DELETE" });

export const jiraPage = (slug: string) => request<JiraPage>(`/api/v1/jira/page?slug=${encodeURIComponent(slug)}`);
export const jiraDraft = (item: JiraItemRef & { project?: string | null }) => request<JiraDraft>("/api/v1/jira/draft", post(item));
export const jiraDraftAll = (slug: string, project?: string | null) =>
  request<{ items: JiraDraft[]; skipped: number; more: number; meta: JiraDraft["meta"] }>("/api/v1/jira/draft/all", post({ slug, project }));
export const jiraCreate = (item: JiraItemRef, fields: JiraCreateFields) => request<JiraCreated>("/api/v1/jira/issues", post({ ...item, fields }));
export const jiraCreateBulk = (slug: string, items: Array<{ block: string; fields: JiraCreateFields }>) =>
  request<{ results: Array<JiraCreated & { block: string; ok: boolean; detail?: string }>; created: number }>("/api/v1/jira/issues/bulk", post({ slug, items }));
export const jiraLink = (item: JiraItemRef, key: string) => request<JiraCreated>("/api/v1/jira/links", post({ ...item, key }));
export const jiraUnlink = (id: string) => request<{ unlinked: boolean }>(`/api/v1/jira/links/${encodeURIComponent(id)}`, { method: "DELETE" });
export const jiraRetry = (id: string) =>
  request<{ state: string; message: string | null }>(`/api/v1/jira/links/${encodeURIComponent(id)}/retry`, { method: "POST" });
export const jiraLookup = (urls: string[]) =>
  request<{ connected: boolean; issues: Record<string, JiraIssue> }>("/api/v1/jira/lookup", post({ urls }));
export const jiraTeam = (ws: string, refresh = false) =>
  request<JiraTeam>(`/api/v1/jira/team/${encodeURIComponent(ws)}${refresh ? "?refresh=true" : ""}`);
export const jiraTeamPerson = (ws: string, user: string) =>
  request<JiraPersonView>(`/api/v1/jira/team/${encodeURIComponent(ws)}/people/${encodeURIComponent(user)}`);

/** A Jira browse link ("https://acme.atlassian.net/browse/PAY-12"), else null. */
export function jiraKeyOf(url: string | null | undefined): string | null {
  const m = /^https:\/\/[a-z0-9.-]+\/browse\/([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8})(?:[/?#].*)?$/.exec(url || "");
  return m ? m[1] : null;
}

export const CATEGORY_LABEL: Record<JiraCategory, string> = { new: "To do", indeterminate: "In progress", done: "Done" };

/** Which round trip a state belongs to ("site" | "me") and its workspace. The server checks the signature. */
export function readJiraState(state: string): { kind: string | null; workspace: string | null; back: string | null } {
  try {
    const body = state.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const data = JSON.parse(atob(body + "=".repeat((4 - (body.length % 4)) % 4)));
    return {
      kind: typeof data.k === "string" ? data.k : null,
      workspace: typeof data.w === "string" ? data.w : null,
      back: typeof data.b === "string" && data.b.startsWith("/") && !data.b.startsWith("//") ? data.b : null,
    };
  } catch {
    return { kind: null, workspace: null, back: null };
  }
}

/** Start connecting my own Atlassian account, coming back to `back` (this page) afterwards. */
export async function connectMyJira(back?: string | null, workspace?: string | null): Promise<void> {
  const { url } = await jiraStart({ kind: "me", workspace_id: workspace ?? null, back: back ?? (typeof window !== "undefined" ? window.location.pathname + window.location.search : null) });
  window.location.href = url;
}
