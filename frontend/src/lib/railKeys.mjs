/**
 * The sidebar's keys (components/shell/SideNav; nav redesign 2026-11-18): which rail row a URL points at, and which
 * team row opens so it shows. Plain JS so `node --test` covers it (railKeys.test.mjs).
 *
 * Keys: "home" | "search" | "ask" | "files" | "shared" | "recent" | "todos" | "analytics" | "trash" | "settings" | "ws:new" |
 * "deals" (Deals across teams) | "ws:<id>:root" | "ws:<id>:folder:<fid>" | "ws:<id>:meetings" (Meetings across teams) |
 * "ws:<id>:meetings-company" | "ws:<id>:deals" | "ws:<id>:team" | "ws:<id>:settings" | "ws:<id>:browse" | "ws:<id>:review" |
 * "ws:<id>:ask", team rows ("ws:<id>:team:<tid>" and its sections "ws:<id>:team:<tid>:<section>"), and raw team keys
 * ("ws:<id>:tslug:<slug>", "ws:<id>:tfiles:<slug>", "ws:<id>:pslug:<slug>") that resolveRailKey turns into rows.
 */

export const wsRootKey = (id) => `ws:${id}:root`;
export const wsFolderKey = (id, folderId) => `ws:${id}:folder:${folderId}`;
export const wsSettingsKey = (id) => `ws:${id}:settings`;
/** Meetings across every team you can read (/meetings/<id>?space=all): the top-level Meetings row. */
export const wsMeetingsKey = (id) => `ws:${id}:meetings`;
/** Company-wide meetings (/meetings/<id>?space=company, older links): General's Meetings row. */
export const wsCompanyMeetingsKey = (id) => `ws:${id}:meetings-company`;
/** The workspace's Team board (/team/<id>): General's "People & memory" row once teams are known. */
export const wsTeamKey = (id) => `ws:${id}:team`;
export const wsBrowseKey = (id) => `ws:${id}:browse`;
export const wsReviewKey = (id) => `ws:${id}:review`;
/** Deals across teams (/deals): the top-level Deals row. */
export const ALL_DEALS_KEY = "deals";
/** A workspace's Deals (/deals/<id>) and a deal page (/deals/<id>/<deal>): the CRM-linked team's Deals row. */
export const wsDealsKey = (id) => `ws:${id}:deals`;
/** A team's row (its expand key), or one of its sections: overview | meetings | deals | files | memory. */
export const wsTeamRowKey = (id, teamId, sub) => `ws:${id}:team:${teamId}${sub ? `:${sub}` : ""}`;
/** A team's sections, in the sidebar's order (Deals: the CRM-linked team only). */
export const TEAM_SECTIONS = ["overview", "meetings", "deals", "files", "memory"];

/** Which rail item the URL points at (`search`: the query string, with or without "?"). */
export function railKeyFor(pathname, search) {
  const q = new URLSearchParams(search);
  const tw = pathname.match(/^\/w\/([^/]+)\/(home|teams|teams-review|teams\/([^/]+)(?:\/(pages|settings))?|projects\/([^/]+))\/?$/);
  if (tw) {
    const id = decodeURIComponent(tw[1]);
    if (tw[2] === "home") return wsRootKey(id);
    if (tw[2] === "teams") return wsBrowseKey(id);
    if (tw[2] === "teams-review") return wsReviewKey(id);
    if (tw[3]) return `ws:${id}:${tw[4] === "pages" ? "tfiles" : "tslug"}:${decodeURIComponent(tw[3])}`;
    if (tw[5]) return `ws:${id}:pslug:${decodeURIComponent(tw[5])}`;
  }
  const space = q.get("space") || "";
  const spaceTeam = space.startsWith("team:") ? space.slice(5) : null;
  const w = pathname.match(/^\/w\/([^/]+)(?:\/f\/([^/]+))?\/?$/);
  if (w) {
    const id = decodeURIComponent(w[1]);
    return w[2] ? wsFolderKey(id, decodeURIComponent(w[2])) : wsRootKey(id);
  }
  if (pathname === "/dashboard" || pathname === "/dashboard/files") {
    const ws = q.get("ws");
    if (ws) {
      const folder = q.get("folder");
      return folder && folder !== "unfiled" ? wsFolderKey(ws, folder) : wsRootKey(ws);
    }
    // Old links (/dashboard?kind=…, ?q=…) are the files list; they forward there.
    if (pathname === "/dashboard" && !["kind", "q", "page", "gdocs"].some((k) => q.has(k))) return "home";
    return "files";
  }
  // Meetings: a team's (?space=team:<id>), company-wide (?space=company), else every team's (?space=all, or none).
  const mt = pathname.match(/^\/meetings\/(?!start\/?$)([^/]+)\/?$/);
  if (mt) {
    const id = decodeURIComponent(mt[1]);
    return spaceTeam ? wsTeamRowKey(id, spaceTeam, "meetings") : space === "company" ? wsCompanyMeetingsKey(id) : wsMeetingsKey(id);
  }
  // Deals: every team's (/deals), a team's section (?space=team:<id>), a workspace's and a deal page (/deals/<ws>/<deal id>).
  if (pathname === "/deals" || pathname === "/deals/") return ALL_DEALS_KEY;
  const dl = pathname.match(/^\/deals\/([^/]+)(?:\/[^/]+)?\/?$/);
  if (dl) return spaceTeam ? wsTeamRowKey(decodeURIComponent(dl[1]), spaceTeam, "deals") : wsDealsKey(decodeURIComponent(dl[1]));
  const tm = pathname.match(/^\/team\/([^/]+)(?:\/.*)?$/);
  if (tm) return spaceTeam ? wsTeamRowKey(decodeURIComponent(tm[1]), spaceTeam, "memory") : wsTeamKey(decodeURIComponent(tm[1]));
  if (pathname === "/search") return "search";
  if (pathname === "/ask") {
    const ws = q.get("workspace");
    return ws ? `ws:${ws}:ask` : "ask";
  }
  if (pathname === "/shared" || pathname.startsWith("/requests")) return "shared";
  if (pathname === "/recent") return "recent";
  if (pathname === "/todos") return "todos";
  if (pathname === "/trash") return "trash";
  if (pathname === "/dashboard/analytics" || pathname.startsWith("/dashboard/analytics/") || pathname === "/dashboard/live") return "analytics";
  const m = pathname.match(/^\/settings\/workspaces\/([^/]+)/);
  if (m) return wsSettingsKey(decodeURIComponent(m[1]));
  if (pathname === "/settings/workspaces") return "ws:new";
  // Integrations (VS Code tokens, connected apps) live under Settings.
  if (pathname === "/settings" || pathname.startsWith("/settings/account") || pathname.startsWith("/settings/tokens")
    || pathname.startsWith("/settings/connections") || pathname.startsWith("/settings/integrations")) return "settings";
  return null;
}

/** The workspace an item key belongs to, if any. */
export function workspaceOfKey(key) {
  const m = key?.match(/^ws:([^:]+):/);
  return m && m[1] !== "new" ? m[1] : null;
}

/** The Ask page for where you are: in a workspace, Ask <Workspace> (?workspace=, + &team= inside a team). */
export function askLinkFor(active, wsFallback) {
  const ws = workspaceOfKey(active) ?? wsFallback ?? null;
  const team = active?.match(/^ws:[^:]+:team:([^:]+)/)?.[1];
  if (ws && team) return `/ask?workspace=${encodeURIComponent(ws)}&team=${encodeURIComponent(team)}`;
  return ws ? `/ask?workspace=${encodeURIComponent(ws)}` : "/ask";
}

/** The workspace's default team (General) in a sidebar payload. */
export const generalOf = (teams) => (teams ? teams.teams.find((t) => t.general) : undefined);

/** A folder and the folders above it, nearest first. */
function upFrom(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = [];
  for (let cur = byId.get(id), guard = 0; cur && guard < 32; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, guard++) out.push(cur);
  return out;
}

/**
 * The row a raw rail key lands on once the workspace's teams are known (lib/teamsStore), and the team rows to open so
 * it shows: a team's home → its Overview, its pages → Files & pages, a project → its first team's Overview, a folder
 * (with `folders`, the workspace tree's) → Files & pages of the team it's in (General's when none, and for the
 * workspace's top level), a deal page → the CRM-linked team's Deals, the Team board → General's People & memory.
 * Without teams keys stay as they are.
 */
export function resolveRailKey(active, teams, folders) {
  const ws = workspaceOfKey(active);
  if (!active || !ws || !teams) return { key: active, open: [] };
  const g = generalOf(teams);
  const row = (t, sub) => ({ key: wsTeamRowKey(ws, t.id, sub), open: [wsTeamRowKey(ws, t.id)] });
  const slug = active.match(/^ws:[^:]+:(tslug|tfiles):(.+)$/);
  if (slug) {
    const t = teams.teams.find((x) => x.slug === slug[2]);
    return t ? row(t, slug[1] === "tfiles" ? "files" : "overview") : { key: wsBrowseKey(ws), open: [] };
  }
  const ps = active.match(/^ws:[^:]+:pslug:(.+)$/);
  if (ps) {
    const p = teams.projects.find((x) => x.slug === ps[1]);
    const t = p && teams.teams.find((x) => p.team_ids.includes(x.id));
    return p && t ? row(t, "overview") : { key: null, open: [] };
  }
  const tr = active.match(/^ws:[^:]+:team:([^:]+)(?::|$)/);
  if (tr) return teams.teams.some((x) => x.id === tr[1]) ? { key: active, open: [wsTeamRowKey(ws, tr[1])] } : { key: null, open: [] };
  if (g && active === wsRootKey(ws)) return row(g, "files");
  const fd = active.match(/^ws:[^:]+:folder:(.+)$/);
  if (fd) {
    const owner = (folders ? upFrom(folders, fd[1]) : []).map((f) => f.team_ids?.[0]).find(Boolean);
    const t = (owner && teams.teams.find((x) => x.id === owner)) || g;
    return t ? row(t, "files") : { key: active, open: [] };
  }
  if (active === wsDealsKey(ws)) {
    const h = teams.teams.find((x) => x.hubspot);
    return h ? row(h, "deals") : { key: ALL_DEALS_KEY, open: [] };
  }
  if (g && active === wsCompanyMeetingsKey(ws)) return row(g, "meetings");
  if (g && active === wsTeamKey(ws)) return row(g, "memory");
  return { key: active, open: [] };
}
