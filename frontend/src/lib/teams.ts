/**
 * Teams' client (backend routers/teams.py; .work/teams/CONTRACT.md §4). Prefix /api/v1/workspaces/{ws}:
 *
 *   GET    /teams                         the sidebar: my teams, readable projects, browse counts, suggested, review chip
 *   GET    /teams/browse                  every team (private ones you're not in: can_read=false)
 *   POST   /teams                         (admin) create → TeamFull
 *   GET    /teams/{tid}                   team home (or {team: card, brief, can_read: false})
 *   PATCH  /teams/{tid}                   lead|admin (visibility: admin) → TeamFull
 *   DELETE /teams/{tid}                   admin
 *   POST   /teams/{tid}/members           {user_ids}      DELETE /teams/{tid}/members/{uid}   (leave: yourself)
 *   PUT    /teams/{tid}/leads             (admin) {lead_ids}
 *   POST   /teams/suggested/{gid}/accept  DELETE /teams/suggested/{gid}
 *   GET|PUT /items/{doc}/teams            move / share an item to teams + projects
 *   PUT    /folders/{fid}/teams
 *   GET|POST /folders/{fid}/move-to-team   move a folder (and everything in it) to another team: preview, move
 *   GET    /folders/{fid}/move-to-team/job progress of a big move
 *   GET|POST /projects   GET|PATCH|DELETE /projects/{pid}
 *   GET    /teams/{tid}/briefs            GET /teams/{tid}/briefs/{bid|latest}   PATCH/POST lines   POST briefs/draft
 *   GET|PUT /api/v1/meetings/{mid}/teams  meeting routing
 *   GET    /teams-review   POST /teams-review/apply   POST /teams-review/done
 *
 * A space ("team:<id>" | "project:<id>" | "company" | "all") scopes items, meetings, memory, search and Ask.
 */
import { request, type WorkspaceItem } from "@/lib/workspaces";
import type { MeetingCard } from "@/lib/meetings";

export type TeamColor = "blue" | "green" | "amber" | "red" | "violet" | "pink" | "teal" | "gray";
export const TEAM_COLORS: TeamColor[] = ["blue", "green", "amber", "red", "violet", "pink", "teal", "gray"];
export type Visibility = "open" | "private";
export type Space = `team:${string}` | `project:${string}` | "company" | "all";

export interface Person { id: string; name: string; email: string; picture: string | null }

export interface TeamCard {
  id: string; name: string; slug: string; icon: string | null; color: TeamColor; description: string;
  visibility: Visibility; member_count: number; lead_ids: string[]; my_role: "lead" | "member" | null;
  can_read: boolean; can_manage: boolean; can_admin: boolean; project_ids: string[];
  /** The workspace's default team (General): everyone is in it, always open, renameable, not deletable. Its
   *  content is the company-wide content. */
  general?: boolean;
  /** Integrations linked to this team ("Zoom", "HubSpot"): team settings say "Linked to: …". */
  linked?: string[];
  /** The HubSpot-linked team: its sidebar shows Deals. */
  hubspot?: boolean;
  /** The Zoom team: your recorded Zoom meetings waiting for your decision (its Meetings › To review). */
  to_review?: number;
  /** The HubSpot team: its open deals (the sidebar's Deals count). */
  deals?: number;
  /** The team's backlog page (services/team_backlog.py): the sidebar's Backlog row and its open items. */
  backlog?: { slug: string; open: number };
}
export interface TeamFull extends TeamCard {
  members: (Person & { role: "lead" | "member" })[];
  slack_channel: { id: string; name: string } | null;
  /** New and resolved comments on the team's pages post to its channel (default on). */
  slack_comments?: boolean;
  /** New meetings join the team by who attended (default on); off: only meetings imported or moved into it. */
  meetings_by_attendees?: boolean;
  /** The team's backlog fills from its calls (default on; never General). */
  backlog_enabled?: boolean;
  jira_projects: string[];
  digest: { enabled: boolean; email: boolean; slack: boolean };
  admins_can_see: boolean;
  created_at: string;
}
export interface ProjectCard {
  id: string; name: string; slug: string; icon: string | null; color: TeamColor; description: string;
  team_ids: string[]; visibility: Visibility; status: "active" | "archived"; member_count: number;
  my_role: "lead" | "member" | null; can_read: boolean; can_manage: boolean;
}
export interface ProjectFull extends ProjectCard {
  members: (Person & { role?: "lead" | "member" })[];
  teams: TeamCard[];
  member_ids?: string[]; lead_ids?: string[];
}
export interface SuggestedTeam { group_id: string; name: string; member_ids: string[]; member_count: number }

export interface TeamsSidebar {
  my_role: string;
  can_create: boolean;
  teams: TeamCard[];
  projects: ProjectCard[];
  browse: { open: number; private: number };
  suggested: SuggestedTeam[];
  review: { pending: number } | null;
}

export type BriefKind = "shipped" | "decision" | "update" | "blocker" | "focus" | "note";
export interface BriefLine {
  id: string; kind: BriefKind; text: string; person: Person | null; hidden?: boolean; edited: boolean;
  sources: { title: string; href: string }[];
}
export interface Brief {
  id: string; team_id: string; week: string; label: string; published_at: string | null; ai: boolean; can_edit: boolean;
  lines: BriefLine[];
}
export interface BriefSummary { id: string; week: string; label: string; published_at: string | null; line_count: number }

/** The workspace items' item shape (lib/workspaces) and the meetings list's card shape (only what team views use). */
export type TeamItem = WorkspaceItem & { team_ids?: string[] };
export type TeamMeetingCard = MeetingCard;
export interface MemoryHighlights {
  highlights: { text: string; kind: string; person: Person | null; source: { title: string; href: string } | null }[];
  people: (Person & { status?: { label: string; state?: string; emoji?: string | null } | null })[];
}

export interface TeamHome {
  team: TeamFull;
  brief: Brief | null;
  recent: TeamItem[];
  meetings: TeamMeetingCard[];
  memory: MemoryHighlights;
  jira: { projects: string[] };
  projects: ProjectCard[];
  can_read?: true;
  /** General only: one line from each other team's latest brief (a private team you can't read: name only). */
  across?: { team: TeamCard; line: string | null }[];
  /** General only: items and meetings from every team you can see ("What's happening"). */
  activity?: { items: TeamItem[]; meetings: TeamMeetingCard[] };
  /** General only: joined the workspace in the last 30 days. */
  new_people?: (Person & { joined_at: string | null })[];
}
export interface TeamHomeLocked { team: TeamCard; brief: Brief | null; can_read: false }

export interface ProjectHome {
  project: ProjectFull;
  recent: TeamItem[];
  meetings: TeamMeetingCard[];
  memory: MemoryHighlights;
}

export interface TeamRef { id: string; name: string; icon: string | null; color: TeamColor; visibility: Visibility }
export interface ItemTeams {
  team_ids: string[]; project_ids: string[];
  teams: TeamRef[]; projects: TeamRef[];
  can_change: boolean;
  options: { teams: TeamCard[]; projects: ProjectCard[] };
}

export interface MeetingRouting {
  team_ids: string[]; project_ids: string[]; state: "auto" | "confirmed" | null;
  suggestions: TeamSuggestion[];
  options: TeamCard[];
}
export interface TeamSuggestion { team_id: string; name: string; reason: "attendees" | "series"; matched: number }

export interface ReviewMove { kind: "meeting" | "page" | "folder"; id: string; team_ids: string[] }
export interface TeamsReview {
  suggested_teams: SuggestedTeam[];
  meetings: { id: string; title: string; date: string | null; series: string | null; attendees: string[]; team_ids: string[]; suggest: string[]; reason: string }[];
  pages: { id: string; slug: string; title: string | null; kind: string; folder: { id: string; name: string } | null; owner: Person | null; team_ids: string[]; suggest: string[]; reason: "author" | "folder" }[];
  folders: { id: string; name: string; item_count: number; suggest: string[]; reason: string }[];
  done: boolean;
}

const enc = encodeURIComponent;
const base = (ws: string) => `/api/v1/workspaces/${enc(ws)}`;
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/* ── Events: the sidebar refetches after a teams mutation anywhere in the app ── */
export const TEAMS_EVENT = "md:teams-change";
export function teamsChanged(ws: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TEAMS_EVENT, { detail: { ws } }));
}
async function mutate<T>(ws: string, p: Promise<T>): Promise<T> {
  const out = await p;
  teamsChanged(ws);
  return out;
}

/* ── Sidebar / browse / CRUD ── */
export const getTeams = (ws: string) => request<TeamsSidebar>(`${base(ws)}/teams`);
export const browseTeams = (ws: string) => request<{ teams: TeamCard[] }>(`${base(ws)}/teams/browse`);
export const getTeamHome = (ws: string, tid: string) => request<TeamHome | TeamHomeLocked>(`${base(ws)}/teams/${enc(tid)}`);
export const createTeam = (ws: string, body: { name: string; icon?: string | null; color?: TeamColor; description?: string; visibility: Visibility; lead_ids: string[]; member_ids: string[] }) =>
  mutate(ws, request<TeamFull>(`${base(ws)}/teams`, json("POST", body)));
export const updateTeam = (ws: string, tid: string, body: Partial<Pick<TeamFull, "name" | "icon" | "color" | "description" | "slack_channel" | "slack_comments" | "meetings_by_attendees" | "jira_projects" | "digest" | "visibility">> & { backlog?: boolean }) =>
  mutate(ws, request<TeamFull>(`${base(ws)}/teams/${enc(tid)}`, json("PATCH", body)));
export const deleteTeam = (ws: string, tid: string) => mutate(ws, request<void>(`${base(ws)}/teams/${enc(tid)}`, json("DELETE")));
export const addTeamMembers = (ws: string, tid: string, user_ids: string[]) =>
  mutate(ws, request<TeamFull>(`${base(ws)}/teams/${enc(tid)}/members`, json("POST", { user_ids })));
export const removeTeamMember = (ws: string, tid: string, uid: string) =>
  mutate(ws, request<TeamFull>(`${base(ws)}/teams/${enc(tid)}/members/${enc(uid)}`, json("DELETE")));
export const setTeamLeads = (ws: string, tid: string, lead_ids: string[]) =>
  mutate(ws, request<TeamFull>(`${base(ws)}/teams/${enc(tid)}/leads`, json("PUT", { lead_ids })));
export const acceptSuggested = (ws: string, gid: string, body: { name?: string; visibility: Visibility; lead_ids: string[] }) =>
  mutate(ws, request<TeamFull>(`${base(ws)}/teams/suggested/${enc(gid)}/accept`, json("POST", body)));
export const dismissSuggested = (ws: string, gid: string) => mutate(ws, request<void>(`${base(ws)}/teams/suggested/${enc(gid)}`, json("DELETE")));

/* ── Items / folders in teams ── */
export const getItemTeams = (ws: string, docId: string) => request<ItemTeams>(`${base(ws)}/items/${enc(docId)}/teams`);
export const setItemTeams = (ws: string, docId: string, team_ids: string[], project_ids: string[]) =>
  mutate(ws, request<ItemTeams>(`${base(ws)}/items/${enc(docId)}/teams`, json("PUT", { team_ids, project_ids })));
export const setFolderTeams = (ws: string, fid: string, team_ids: string[], project_ids: string[], apply_to_items: boolean) =>
  mutate(ws, request<{ team_ids: string[]; project_ids: string[]; applied: number }>(`${base(ws)}/folders/${enc(fid)}/teams`, json("PUT", { team_ids, project_ids, apply_to_items })));

export interface FolderMoveJob { state: "running" | "done"; done: number; total: number; to_team?: string | null }
export interface FolderMovePreview {
  folder: { id: string; name: string; path: string };
  from_teams: TeamCard[];
  to_team: TeamCard;
  /** An open target team: the workspace can still view its items (as viewers). */
  to_team_open: boolean;
  parent_id: string | null; parent_path: string | null;
  /** It leaves its parent folder for the top of the workspace (old addresses redirect). */
  moves_to_top: boolean;
  can_move: boolean;
  same_team: boolean;
  counts: {
    folders: number; items: number; pages: number; documents: number; files: number;
    workspace_to_team: number; private: number; public_links: number; shared_with_people: number;
    team_grants_repointed: number; projects_dropped: number;
  };
  /** Public-link items you can open (up to 25); the rest are counted in public_links_more. */
  public_links: { slug: string; title: string | null; kind: "page" | "document" | "file"; password: boolean }[];
  public_links_more: number;
  /** Folders in it shared by link (their links keep working too). */
  folder_links: string[];
  keeps_inherited_rule: boolean;
  /** Big: the items move in the background (job). */
  background: boolean;
  job: FolderMoveJob | null;
}
export const previewFolderMove = (ws: string, fid: string, team: string) =>
  request<FolderMovePreview>(`${base(ws)}/folders/${enc(fid)}/move-to-team?team=${enc(team)}`);
export const moveFolderToTeam = (ws: string, fid: string, team: string, parent_id?: string | null) =>
  mutate(ws, request<FolderMovePreview & { moved: true }>(`${base(ws)}/folders/${enc(fid)}/move-to-team`, json("POST", { team, parent_id: parent_id ?? null })));
export const folderMoveJob = (ws: string, fid: string) =>
  request<{ job: FolderMoveJob | null }>(`${base(ws)}/folders/${enc(fid)}/move-to-team/job`);

/* ── Projects ── */
export const listProjects = (ws: string, team?: string) => request<{ projects: ProjectCard[] }>(`${base(ws)}/projects${team ? `?team=${enc(team)}` : ""}`);
export const createProject = (ws: string, body: { name: string; team_ids: string[]; icon?: string | null; color?: TeamColor; description?: string; member_ids?: string[]; visibility?: Visibility }) =>
  mutate(ws, request<ProjectFull>(`${base(ws)}/projects`, json("POST", body)));
export const getProjectHome = (ws: string, pid: string) => request<ProjectHome>(`${base(ws)}/projects/${enc(pid)}`);
export const updateProject = (ws: string, pid: string, body: Partial<Pick<ProjectFull, "name" | "icon" | "color" | "description" | "team_ids" | "member_ids" | "visibility" | "status">>) =>
  mutate(ws, request<ProjectFull>(`${base(ws)}/projects/${enc(pid)}`, json("PATCH", body)));
export const deleteProject = (ws: string, pid: string) => mutate(ws, request<void>(`${base(ws)}/projects/${enc(pid)}`, json("DELETE")));

/* ── Briefs ── */
export const listBriefs = (ws: string, tid: string, limit = 8) => request<{ briefs: BriefSummary[] }>(`${base(ws)}/teams/${enc(tid)}/briefs?limit=${limit}`);
export const getBrief = (ws: string, tid: string, bid = "latest") => request<Brief>(`${base(ws)}/teams/${enc(tid)}/briefs/${enc(bid)}`);
export const editBriefLine = (ws: string, tid: string, bid: string, lineId: string, body: { text?: string; hidden?: boolean }) =>
  request<Brief>(`${base(ws)}/teams/${enc(tid)}/briefs/${enc(bid)}/lines/${enc(lineId)}`, json("PATCH", body));
export const addBriefLine = (ws: string, tid: string, bid: string, body: { text: string; kind?: BriefKind }) =>
  request<Brief>(`${base(ws)}/teams/${enc(tid)}/briefs/${enc(bid)}/lines`, json("POST", body));
export const draftBrief = (ws: string, tid: string) => request<Brief>(`${base(ws)}/teams/${enc(tid)}/briefs/draft`, json("POST"));

/* ── Meeting routing ── */
export const getMeetingTeams = (mid: string) => request<MeetingRouting>(`/api/v1/meetings/${enc(mid)}/teams`);
export const setMeetingTeams = (mid: string, team_ids: string[], project_ids: string[] = []) =>
  request<MeetingRouting>(`/api/v1/meetings/${enc(mid)}/teams`, json("PUT", { team_ids, project_ids }));

/* ── Guided review ── */
export const getReview = (ws: string) => request<TeamsReview>(`${base(ws)}/teams-review`);
export const applyReview = (ws: string, moves: ReviewMove[]) => mutate(ws, request<{ applied: number }>(`${base(ws)}/teams-review/apply`, json("POST", { moves })));
export const finishReview = (ws: string) => mutate(ws, request<void>(`${base(ws)}/teams-review/done`, json("POST")));

/* ── Hrefs ── */
export const teamHref = (ws: string, t: Pick<TeamCard, "slug">) => `/w/${enc(ws)}/teams/${enc(t.slug)}`;
/** A team's Files & pages: its folder / page tree (the sidebar never lists items). */
export const teamPagesHref = (ws: string, t: Pick<TeamCard, "slug">) => `${teamHref(ws, t)}/pages`;
export const teamSettingsHref = (ws: string, t: Pick<TeamCard, "slug">) => `${teamHref(ws, t)}/settings`;
export const teamMeetingsHref = (ws: string, t: Pick<TeamCard, "id">) => `/meetings/${enc(ws)}?space=${enc(`team:${t.id}`)}`;
export const teamMemoryHref = (ws: string, t: Pick<TeamCard, "id">) => `/team/${enc(ws)}?space=${enc(`team:${t.id}`)}`;
/** A team's backlog page, marked so the sidebar keeps the team's Backlog row active there. */
export const teamBacklogHref = (ws: string, t: Pick<TeamCard, "id" | "backlog">) =>
  t.backlog ? `/${enc(t.backlog.slug)}?space=${enc(`team:${t.id}`)}&ws=${enc(ws)}` : null;
export const teamDealsHref = (ws: string, t: Pick<TeamCard, "id">) => `/deals/${enc(ws)}?space=${enc(`team:${t.id}`)}`;
export const dealHref = (ws: string, dealId: string) => `/deals/${enc(ws)}/${enc(dealId)}`;
/** The sidebar's top-level Meetings and Deals: every team's that you can open (a Team filter on the page). Deals
 *  across teams is /deals (every workspace's CRM-linked team you're in; components/hubspot/deals). */
export const allMeetingsHref = (ws: string) => `/meetings/${enc(ws)}?space=all`;
export const allDealsHref = () => "/deals";
export const teamAskHref = (ws: string, t: Pick<TeamCard, "id">) => `/ask?workspace=${enc(ws)}&team=${enc(t.id)}`;
export const projectHref = (ws: string, p: Pick<ProjectCard, "slug">) => `/w/${enc(ws)}/projects/${enc(p.slug)}`;
export const browseHref = (ws: string) => `/w/${enc(ws)}/teams`;
/** The default team's home (the backend resolves "general" to it whatever it's called now). */
export const generalHref = (ws: string) => `/w/${enc(ws)}/teams/general`;
export const reviewHref = (ws: string) => `/w/${enc(ws)}/teams-review`;

/** A space from a URL's ?space= (anything else: undefined = all). */
export function parseSpace(v: string | null | undefined): Space | undefined {
  if (!v) return undefined;
  if (v === "company" || v === "all") return v;
  if (/^(team|project):[A-Za-z0-9_-]+$/.test(v)) return v as Space;
  return undefined;
}

/** The tint for a team colour (CSS custom properties from team.css / the colour tokens). */
export const teamTint = (c: TeamColor | null | undefined) => `var(--team-${c || "gray"})`;
