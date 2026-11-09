/**
 * Jira inside pages (backend routers/jira_pages.py; docs pages/jira-in-pages):
 *
 *   GET    /api/v1/jira/pages/{slug}/items           the page's chips and cards for me (snapshot; live through my Jira)
 *   POST   /api/v1/jira/pages/{slug}/list            one page of a list block, as me
 *   POST   /api/v1/jira/pages/{slug}/remember        an issue just put on the page (its "KEY · title" snapshot)
 *   GET    /api/v1/jira/pages/{slug}/threads         discussions linked to issues
 *   POST   /api/v1/jira/pages/{slug}/threads/{id}/draft | /issue | /link   DELETE …/link
 *   GET    /api/v1/jira/search?site=&q=              the editor's picker
 *   GET    /api/v1/jira/issue/{key}  …/transitions  …/assignable     POST …/transition  …/comment
 *   PUT    /api/v1/jira/issue/{key}/assignee         PATCH /api/v1/jira/issue/{key}
 *
 * The page syntax (also written by MCP's insert_jira):
 *   :jira[KEY]{site=host}    ::jira{key=KEY site=host}    ::jira-list{jql="…"|project=KEY|filter=ID site=… cols=… limit=… title=…}
 */
import { request } from "@/lib/workspaces";
import type { JiraCreateFields, JiraCreated, JiraDraft, JiraIssue } from "@/lib/jira";

export type { JiraIssue };

export interface JiraPageItem {
  key: string;
  site: string;
  /** The snapshot's title (what everyone who can read the page sees); null when none was taken. */
  title: string | null;
  url: string;
  /** Live details: only when your own Jira can open it. */
  issue: (JiraIssue & { sprint?: string | null }) | null;
}

export interface JiraPageItems {
  configured: boolean;
  signed_in: boolean;
  connected: boolean;
  broken: boolean;
  can_edit: boolean;
  default_site: string | null;
  /** Sites your own Jira reaches. */
  sites: string[];
  /** "<site>/<KEY>" → item. */
  items: Record<string, JiraPageItem>;
  lists: number;
}

export type JiraCol = "status" | "assignee" | "priority" | "type" | "due" | "sprint" | "updated";
export const JIRA_COLS: Array<{ id: JiraCol; label: string }> = [
  { id: "status", label: "Status" }, { id: "assignee", label: "Assignee" }, { id: "priority", label: "Priority" },
  { id: "type", label: "Type" }, { id: "due", label: "Due" }, { id: "sprint", label: "Sprint" }, { id: "updated", label: "Updated" },
];
export const DEFAULT_COLS: JiraCol[] = ["status", "assignee", "priority", "due"];

export interface JiraListSpec {
  jql?: string | null;
  project?: string | null;
  filter?: string | null;
  site?: string | null;
  cols?: JiraCol[] | null;
  limit?: number | null;
  title?: string | null;
}

export interface JiraListPage {
  site: string;
  jql: string;
  url: string;
  cols: JiraCol[];
  title: string | null;
  issues: Array<JiraIssue & { sprint?: string | null }>;
  next: string | null;
}

export interface JiraField { key: string; name: string; required: boolean; type: string; options: Array<{ id: string; name: string }> }
export interface JiraTransition { id: string; name: string; to: { name: string; category: JiraIssue["status"]["category"] }; fields: JiraField[] }
export interface JiraPersonOption { account_id: string; name: string; avatar: string | null }
export interface JiraThreadLink { thread_id: string; key: string; site: string | null; title: string | null; url: string | null; issue: JiraIssue | null }

const enc = encodeURIComponent;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const jiraPageItems = (slug: string) => request<JiraPageItems>(`/api/v1/jira/pages/${enc(slug)}/items`);
export const jiraPageList = (slug: string, spec: JiraListSpec, pageToken?: string | null) =>
  request<JiraListPage>(`/api/v1/jira/pages/${enc(slug)}/list`, post({ ...spec, page_token: pageToken ?? null }));
export const jiraRemember = (slug: string, key: string, site: string | null) =>
  request<{ key: string; site: string; title: string | null; url: string; issue: JiraIssue }>(`/api/v1/jira/pages/${enc(slug)}/remember`, post({ key, site }));
export const jiraThreadLinks = (slug: string) => request<{ threads: Record<string, JiraThreadLink> }>(`/api/v1/jira/pages/${enc(slug)}/threads`);
export const jiraThreadDraft = (slug: string, thread: string, project?: string | null) =>
  request<JiraDraft>(`/api/v1/jira/pages/${enc(slug)}/threads/${enc(thread)}/draft`, post({ project: project ?? null }));
export const jiraThreadCreate = (slug: string, thread: string, fields: JiraCreateFields) =>
  request<JiraThreadLink>(`/api/v1/jira/pages/${enc(slug)}/threads/${enc(thread)}/issue`, post({ fields }));
export const jiraThreadLink = (slug: string, thread: string, key: string, site?: string | null) =>
  request<JiraThreadLink>(`/api/v1/jira/pages/${enc(slug)}/threads/${enc(thread)}/link`, post({ key, site: site ?? null }));
export const jiraThreadUnlink = (slug: string, thread: string) =>
  request<{ unlinked: boolean }>(`/api/v1/jira/pages/${enc(slug)}/threads/${enc(thread)}/link`, { method: "DELETE" });

export const jiraSearch = (site: string, q: string) =>
  request<{ issues: JiraIssue[]; site: string }>(`/api/v1/jira/search?site=${enc(site)}&q=${enc(q)}`);
export const jiraIssue = (site: string, key: string) => request<{ issue: JiraIssue; site: string }>(`/api/v1/jira/issue/${enc(key)}?site=${enc(site)}`);
export const jiraTransitions = (site: string, key: string) =>
  request<{ key: string; transitions: JiraTransition[] }>(`/api/v1/jira/issue/${enc(key)}/transitions?site=${enc(site)}`);
export const jiraTransition = (site: string, key: string, transition: string, fields?: Record<string, unknown> | null, slug?: string | null) =>
  request<{ key: string; issue: JiraIssue | null; transition: string }>(`/api/v1/jira/issue/${enc(key)}/transition`, post({ site, transition, fields: fields ?? null, slug: slug ?? null }));
export const jiraAssignable = (site: string, key: string, q: string) =>
  request<{ people: JiraPersonOption[] }>(`/api/v1/jira/issue/${enc(key)}/assignable?site=${enc(site)}&q=${enc(q)}`);
export const jiraAssign = (site: string, key: string, accountId: string | null, slug?: string | null) =>
  request<{ key: string; issue: JiraIssue | null }>(`/api/v1/jira/issue/${enc(key)}/assignee`, { method: "PUT", body: JSON.stringify({ site, account_id: accountId, slug: slug ?? null }) });
export const jiraComment = (site: string, key: string, body: string, slug?: string | null) =>
  request<{ key: string; issue: JiraIssue | null }>(`/api/v1/jira/issue/${enc(key)}/comment`, post({ site, body, slug: slug ?? null }));
export const jiraEdit = (site: string, key: string, changes: { summary?: string; priority?: string; due?: string | null }, slug?: string | null) =>
  request<{ key: string; issue: JiraIssue | null }>(`/api/v1/jira/issue/${enc(key)}`, { method: "PATCH", body: JSON.stringify({ site, ...changes, slug: slug ?? null }) });
export const jiraPriorities = (site: string) => request<{ priorities: Array<{ id: string; name: string }> }>(`/api/v1/jira/priorities?site=${enc(site)}`);

export type { JiraCreateFields, JiraCreated, JiraDraft };

/* ── The syntax ─────────────────────────────────────────────────────────── */

const KEY_RE = /^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8}$/;

/** "PAY-12" from a key or a Jira link (any case), else null. */
export function normKey(v: string | null | undefined): string | null {
  const m = /([A-Za-z][A-Za-z0-9_]{0,19}-[1-9][0-9]{0,8})\/?\s*$/.exec((v ?? "").trim().replace(/[?#].*$/, ""));
  const k = m ? m[1].toUpperCase() : null;
  return k && KEY_RE.test(k) ? k : null;
}

/** "acme.atlassian.net" from a host or an address, else null. */
export function hostOf(v: string | null | undefined): string | null {
  const h = (v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  return /^[a-z0-9][a-z0-9.-]{1,200}$/.test(h) && h.includes(".") ? h : null;
}

/** A Jira issue link ("https://acme.atlassian.net/browse/PAY-12…") → {site, key}, else null. */
export function parseJiraUrl(url: string | null | undefined): { site: string; key: string } | null {
  const m = /^https:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\/browse\/([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,8})(?:[/?#][^\s]*)?$/i.exec((url ?? "").trim());
  if (!m) return null;
  const key = m[2].toUpperCase();
  return KEY_RE.test(key) ? { site: m[1].toLowerCase(), key } : null;
}

export const itemId = (site: string, key: string) => `${site}/${key}`;
export const browseUrl = (site: string, key: string) => `https://${site}/browse/${key}`;

/** A list block's attributes (as the editor stores them) → its query, checked loosely (the server checks again). */
export function specOf(a: Record<string, string | undefined>): JiraListSpec | null {
  const jql = (a.jql ?? "").trim();
  const project = (a.project ?? "").trim().toUpperCase();
  const filter = (a.filter ?? "").trim();
  const cols = (a.cols ?? "").split(",").map((c) => c.trim()).filter((c): c is JiraCol => JIRA_COLS.some((x) => x.id === c));
  const limit = Number(a.limit) || null;
  const base = { site: hostOf(a.site), cols: cols.length ? cols : null, limit, title: a.title?.trim() || null };
  if (jql) return { ...base, jql };
  if (/^[A-Z][A-Z0-9_]{0,19}$/.test(project)) return { ...base, project };
  if (/^\d{1,12}$/.test(filter)) return { ...base, filter };
  return null;
}

export function specJql(s: JiraListSpec): string {
  if (s.jql) return s.jql;
  if (s.project) return `project = "${s.project}" ORDER BY updated DESC`;
  if (s.filter) return `filter = ${s.filter}`;
  return "";
}

export const linkText = (key: string, title: string | null | undefined) => (title ? `${key} · ${title}` : key);
