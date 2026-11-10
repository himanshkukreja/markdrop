"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Anchor, Dropdown, FileIcon, Icon, Skeleton, Tooltip, copyText, cx, useToast, type MenuEntry } from "@/components/ui";
import { usePwa } from "@/components/pwa/PwaProvider";
import { openNotifications, useUnreadCount } from "./NotificationBell";
import { openCommandPalette } from "./commands";
import { DOCS_URL } from "./links";
import { isStudioHost } from "@/lib/studioHost";
import { TreeView, shareNodes, type TreeNode } from "@/components/workspace/FolderTree";
import { useUploads } from "@/components/workspace/uploads/UploadProvider";
import { can, type NavItem, type TreeFolder, type Workspace, type WorkspaceNav, type WorkspaceTree } from "@/lib/workspaces";
import { childrenMap, descendants, refreshTree, useWorkspaceTrees } from "@/lib/workspaceStore";
import { childrenSlot, navSlot, navTeamKey, useNavRetain, type NavSlot } from "@/lib/navStore";
import { useAuth } from "@/contexts/AuthContext";
import { TeamTile } from "@/components/teams/parts";
import { TeamDialog } from "@/components/teams/TeamDialog";
import { teamsSlot, useTeamsSidebar } from "@/lib/teamsStore";
import { favoritesSlot, isFavorite, toggleFavorite, useFavorites, type Favorite, type FavoriteKind } from "@/lib/favorites";
import {
  browseHref, projectHref as teamProjectHref, reviewHref, teamHref as teamHomeHref, teamMeetingsHref, teamMemoryHref,
  teamSettingsHref, type TeamCard, type TeamsSidebar,
} from "@/lib/teams";
import type { FileRenderer } from "@/components/ui/markdrop";

/** A page's rail key (also its expand key). */
export const railPageKey = (wsId: string, slug: string) => `ws:${wsId}:page:${slug}`;

/** What the rail shows. Every field may be missing: the rail omits what failed to load. */
export interface RailData {
  workspaces?: Workspace[];
  tokens?: number;
  /** Shared with me: granted in the last 7 days and not opened yet. */
  sharedNew?: number;
}

/** Rail keys for a workspace's tree nodes (also the tree's expand keys). */
export const wsRootKey = (id: string) => `ws:${id}:root`;
export const wsFolderKey = (id: string, folderId: string) => `ws:${id}:folder:${folderId}`;
export const wsSettingsKey = (id: string) => `ws:${id}:settings`;
/** The workspace's Meetings hub (/meetings/<id>): General's Meetings row once teams are known. */
export const wsMeetingsKey = (id: string) => `ws:${id}:meetings`;
/** The workspace's Team board (/team/<id>): General's "People & memory" row once teams are known. */
export const wsTeamKey = (id: string) => `ws:${id}:team`;
export const wsBrowseKey = (id: string) => `ws:${id}:browse`;
export const wsReviewKey = (id: string) => `ws:${id}:review`;
/** A team's row (its expand key, and its home), or one of its rows: meetings | memory | project:<id>. */
export const wsTeamRowKey = (id: string, teamId: string, sub?: string) => `ws:${id}:team:${teamId}${sub ? `:${sub}` : ""}`;
/** General (the default team) starts open: it is open unless "<key>!closed" is in the saved set. */
const closedKey = (k: string) => `${k}!closed`;
/** The workspace the rail shows when the URL names none (the last one you were in, on this device). */
const WS_KEY = "md_rail_ws";
const meetingsHref = (id: string) => `/meetings/${encodeURIComponent(id)}`;

/**
 * Which rail item the URL points at. Keys: "home" | "search" | "ask" | "files" | "shared" | "recent" | "analytics" | "trash" |
 * "ws:<id>:root" | "ws:<id>:folder:<fid>" | "ws:<id>:meetings" | "ws:<id>:team" | "ws:<id>:settings" | "ws:new" | "settings",
 * and raw team keys (`ws:<id>:tslug:<slug>`, `ws:<id>:pslug:<slug>`) that resolveRailKey turns into rows.
 */
export function railKeyFor(pathname: string, search: string): string | null {
  const q = new URLSearchParams(search);
  const tw = pathname.match(/^\/w\/([^/]+)\/(home|teams|teams-review|teams\/([^/]+)(?:\/(pages|settings))?|projects\/([^/]+))\/?$/);
  if (tw) {
    const id = decodeURIComponent(tw[1]!);
    if (tw[2] === "home") return wsRootKey(id);
    if (tw[2] === "teams") return wsBrowseKey(id);
    if (tw[2] === "teams-review") return wsReviewKey(id);
    if (tw[3]) return `ws:${id}:tslug:${decodeURIComponent(tw[3])}`;
    if (tw[5]) return `ws:${id}:pslug:${decodeURIComponent(tw[5])}`;
  }
  const space = q.get("space") || "";
  const spaceTeam = space.startsWith("team:") ? space.slice(5) : null;
  const w = pathname.match(/^\/w\/([^/]+)(?:\/f\/([^/]+))?\/?$/);
  if (w) {
    const id = decodeURIComponent(w[1]!);
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
  const mt = pathname.match(/^\/meetings\/(?!start\/?$)([^/]+)\/?$/);
  if (mt) return spaceTeam ? wsTeamRowKey(decodeURIComponent(mt[1]!), spaceTeam, "meetings") : wsMeetingsKey(decodeURIComponent(mt[1]!));
  const tm = pathname.match(/^\/team\/([^/]+)(?:\/.*)?$/);
  if (tm) return spaceTeam ? wsTeamRowKey(decodeURIComponent(tm[1]!), spaceTeam, "memory") : wsTeamKey(decodeURIComponent(tm[1]!));
  if (pathname === "/search") return "search";
  if (pathname === "/ask") {
    const ws = q.get("workspace");
    return ws ? `ws:${ws}:ask` : "ask";
  }
  if (pathname === "/shared" || pathname.startsWith("/requests")) return "shared";
  if (pathname === "/recent") return "recent";
  if (pathname === "/trash") return "trash";
  if (pathname === "/dashboard/analytics" || pathname.startsWith("/dashboard/analytics/") || pathname === "/dashboard/live") return "analytics";
  const m = pathname.match(/^\/settings\/workspaces\/([^/]+)/);
  if (m) return wsSettingsKey(decodeURIComponent(m[1]!));
  if (pathname === "/settings/workspaces") return "ws:new";
  // Integrations (VS Code tokens, connected apps) live under Settings.
  if (pathname === "/settings" || pathname.startsWith("/settings/account") || pathname.startsWith("/settings/tokens")
    || pathname.startsWith("/settings/connections")) return "settings";
  return null;
}

/** The Ask page for where you are: in a workspace, Ask <Workspace> (?workspace=, + &team= inside a team). */
export function askLinkFor(active: string | null, wsFallback?: string | null): string {
  const ws = workspaceOfKey(active) ?? wsFallback ?? null;
  const team = active?.match(/^ws:[^:]+:team:([^:]+)/)?.[1];
  if (ws && team) return `/ask?workspace=${encodeURIComponent(ws)}&team=${encodeURIComponent(team)}`;
  return ws ? `/ask?workspace=${encodeURIComponent(ws)}` : "/ask";
}

/** The workspace's default team (General) in a sidebar payload. */
export const generalOf = (teams: TeamsSidebar | null | false | undefined): TeamCard | undefined =>
  teams ? teams.teams.find((t) => t.general) : undefined;

/**
 * The row a raw rail key (railKeyFor) lands on once the workspace's teams are known (lib/teamsStore), and the
 * team rows to open so it shows: team slugs → the team's row, a project → its row under its first team, the
 * workspace's top level, its Meetings hub and Team board → General's rows. Without teams keys stay as they are.
 */
export function resolveRailKey(active: string | null, teams: TeamsSidebar | null | false | undefined): { key: string | null; open: string[] } {
  const ws = workspaceOfKey(active);
  if (!active || !ws || !teams) return { key: active, open: [] };
  const g = generalOf(teams);
  const row = (t: { id: string }, sub?: string) => ({ key: wsTeamRowKey(ws, t.id, sub), open: [wsTeamRowKey(ws, t.id)] });
  const ts = active.match(/^ws:[^:]+:tslug:(.+)$/);
  if (ts) {
    const t = teams.teams.find((x) => x.slug === ts[1]);
    return t ? row(t) : { key: wsBrowseKey(ws), open: [] };
  }
  const ps = active.match(/^ws:[^:]+:pslug:(.+)$/);
  if (ps) {
    const p = teams.projects.find((x) => x.slug === ps[1]);
    const t = p && teams.teams.find((x) => p.team_ids.includes(x.id));
    return p && t ? row(t, `project:${p.id}`) : { key: null, open: [] };
  }
  const tr = active.match(/^ws:[^:]+:team:([^:]+)(?::|$)/);
  if (tr) return teams.teams.some((x) => x.id === tr[1]) ? { key: active, open: [wsTeamRowKey(ws, tr[1]!)] } : { key: null, open: [] };
  if (g && active === wsRootKey(ws)) return row(g);
  if (g && active === wsMeetingsKey(ws)) return row(g, "meetings");
  if (g && active === wsTeamKey(ws)) return row(g, "memory");
  return { key: active, open: [] };
}

/** The workspace an item key belongs to, if any. */
export function workspaceOfKey(key: string | null): string | null {
  const m = key?.match(/^ws:([^:]+):/);
  return m && m[1] !== "new" ? m[1]! : null;
}

/** The workspace the rail shows: the URL's, else the last one shown on this device, else the first. */
export function useRailWorkspace(workspaces: Workspace[] | undefined, urlWs: string | null): Workspace | null {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    try { setSaved(localStorage.getItem(WS_KEY)); } catch { /* storage off */ }
  }, []);
  useEffect(() => {
    if (!urlWs || !workspaces?.some((w) => w.id === urlWs)) return;
    setSaved(urlWs);
    try { localStorage.setItem(WS_KEY, urlWs); } catch { /* storage off */ }
  }, [urlWs, workspaces]);
  if (!workspaces?.length) return null;
  return workspaces.find((w) => w.id === urlWs) ?? workspaces.find((w) => w.id === saved) ?? workspaces[0]!;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * One accent-soft pill behind the active item that slides to the next one (a 200ms WAAPI FLIP on
 * top/left/width/height; instant under reduced motion). Hidden when the active item isn't rendered
 * (e.g. inside a collapsed workspace).
 */
function useActivePill(container: React.RefObject<HTMLElement | null>, pill: React.RefObject<HTMLElement | null>, active: string | null, layoutKey: string) {
  const last = useRef<{ top: number; left: number; width: number; height: number } | null>(null);
  const place = (animate: boolean) => {
    const c = container.current, p = pill.current;
    if (!c || !p) return;
    const el = active ? c.querySelector<HTMLElement>(`[data-rail-key="${CSS.escape(active)}"]`) : null;
    if (!el || el.offsetParent === null) {
      p.style.opacity = "0";
      last.current = null;
      return;
    }
    const cr = c.getBoundingClientRect(), er = el.getBoundingClientRect();
    const next = { top: er.top - cr.top + c.scrollTop, left: er.left - cr.left, width: er.width, height: er.height };
    const prev = last.current;
    Object.assign(p.style, { opacity: "1", top: `${next.top}px`, left: `${next.left}px`, width: `${next.width}px`, height: `${next.height}px` });
    if (animate && prev && !reducedMotion() && (prev.top !== next.top || prev.left !== next.left || prev.width !== next.width)) {
      p.animate(
        [
          { top: `${prev.top}px`, left: `${prev.left}px`, width: `${prev.width}px`, height: `${prev.height}px` },
          { top: `${next.top}px`, left: `${next.left}px`, width: `${next.width}px`, height: `${next.height}px` },
        ],
        { duration: 200, easing: getComputedStyle(document.documentElement).getPropertyValue("--ease-out").trim() || "ease-out" },
      );
    }
    last.current = next;
  };
  // Slide when the active item changes…
  useLayoutEffect(() => place(true), [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // …and snap when the list itself changes shape (data arrives, a workspace expands, resize).
  useLayoutEffect(() => place(false), [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = container.current;
    if (!c || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(c);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

const ITEM =
  "md-focus relative flex min-h-8 min-w-0 items-center gap-2.5 rounded-md px-2.5 text-body text-text-secondary no-underline transition-colors duration-(--duration-fast) hover:bg-surface-hover hover:text-text max-lg:min-h-11 pointer-coarse:min-h-11";
/** A tree row: 30 px (44 px in the phone drawer); tree.css indents it and adds the guides. */
const TREE_ITEM =
  "md-focus relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-md pr-2 text-body text-text-secondary no-underline transition-colors duration-(--duration-fast) hover:bg-surface-hover hover:text-text max-lg:h-11 pointer-coarse:h-11";
const ACTIVE = "font-semibold text-accent-text hover:bg-transparent hover:text-accent-text";

function RailLink({ k, href, active, onNavigate, children, style, className, testId }: { k: string; href: string; active: string | null; onNavigate?: () => void; children: React.ReactNode; style?: React.CSSProperties; className?: string; testId?: string }) {
  const on = active === k;
  return (
    <Anchor href={href} data-rail-key={k} aria-current={on ? "page" : undefined} className={cx(ITEM, on && ACTIVE, className)} onClick={onNavigate} style={style} data-testid={testId}>
      {children}
    </Anchor>
  );
}

/**
 * The workspace's letter tile (Main board: 18px, rounded 5px): the logo on a logo well, else the
 * initial; the workspace you're in shows it on the accent.
 */
export function WorkspaceTile({ ws, active, size = 18 }: { ws: Pick<Workspace, "name" | "branding">; active?: boolean; size?: number }) {
  const logo = ws.branding?.logo_url;
  const box = { width: size, height: size, borderRadius: Math.max(4, Math.round(size * 0.28)) };
  if (logo) {
    return (
      <span className="ph-no-capture grid shrink-0 place-items-center overflow-hidden" style={{ ...box, background: "var(--logo-well-light)" }} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" className="size-full object-contain" />
      </span>
    );
  }
  const initial = (ws.branding?.site_name || ws.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      className={cx("ph-sensitive ph-mask grid shrink-0 place-items-center font-bold leading-none", active ? "bg-accent text-on-accent" : "bg-surface-active text-text")}
      style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.6)) }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

/* ── The tree's nodes ─────────────────────────────────────────────────── */

/** A page's icon: its emoji, its image, else the page glyph. */
function PageIcon({ icon, url }: { icon?: string | null; url?: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" />;
  }
  if (icon && !icon.startsWith("asset:")) return <span className="md-tree__emoji">{icon}</span>;
  return <Icon name="doc" size={16} />;
}

/** A document or file's icon by kind (a Markdown document: lines; files: their type's glyph and tint). */
function ItemIcon({ it }: { it: NavItem }) {
  if (it.kind === "markdown") return <Icon name="lines" size={16} />;
  return <FileIcon renderer={(it.renderer as FileRenderer | null) ?? null} mime={it.mime ?? ""} name={it.filename ?? ""} size={16} />;
}

/** Where a row sits, for drag and drop: its folder (null: the top level), its parent page and every
 *  page above it. Members drag pages (onto a page: inside it; onto a folder: there) and files. */
interface Place { folderId: string | null; parent: string | null; ancestors: string[] }

interface Ctx {
  ws: Workspace;
  member: boolean;
  expanded: Set<string>;
  /** Open pages whose sub-pages the tree needs (collected while building). */
  want: string[];
  copy: (href: string, label: string) => void;
  /** The workspace's teams (lib/teamsStore). */
  teams?: TeamsSidebar | null;
  /** "Add to / Remove from favorites" for a row's ⋯ menu. */
  fav: (kind: FavoriteKind, ref: string, label: string, draft?: Partial<Favorite>) => MenuEntry;
}

/** A node's `sig` (see shareNodes): the values its row shows and its handlers use. */
const sig = (...parts: unknown[]) => JSON.stringify(parts);

const absolute = (href: string) => (typeof window === "undefined" ? href : new URL(href, window.location.origin).toString());

/** `shown`: every row above it is open (only then are its sub-pages asked for). */
function pageNode(c: Ctx, p: { slug: string; title: string | null; has_children?: boolean; icon?: string | null; icon_url?: string | null }, at: Place, shown: boolean): TreeNode {
  const wsId = c.ws.id;
  const key = railPageKey(wsId, p.slug);
  const label = p.title?.trim() || "Untitled";
  const href = `/${encodeURIComponent(p.slug)}`;
  let children: TreeNode[] | undefined;
  let lazy = false;
  if (p.has_children && shown && c.expanded.has(key)) {
    c.want.push(p.slug);
    const kids = childrenSlot(p.slug);
    if (kids === null) lazy = true;
    else if (kids) {
      const below: Place = { ...at, parent: p.slug, ancestors: [...at.ancestors, p.slug] };
      children = kids.map((k) => pageNode(c, k, below, true));
    }
  } else if (p.has_children) lazy = true;
  const isLazy = lazy && !children?.length;
  const isLeaf = !p.has_children || (children !== undefined && !children.length);
  return {
    key,
    sig: sig("p", label, p.icon, p.icon_url, isLazy, isLeaf, c.member, at.folderId, at.parent, at.ancestors, isFavorite(wsId, "doc", p.slug)),
    label,
    icon: <PageIcon icon={p.icon} url={p.icon_url} />,
    href,
    children: children?.length ? children : undefined,
    lazy: isLazy,
    leaf: isLeaf,
    drag: c.member ? { type: "page", workspaceId: wsId, slug: p.slug, label, parent: at.parent, folderId: at.folderId } : null,
    drop: c.member ? { workspaceId: wsId, folderId: at.folderId, label: `“${label}”`, acceptsFolders: false, page: { slug: p.slug, ancestors: at.ancestors } } : null,
    actions: {
      add: c.member ? { href: `/pages/new?parent=${encodeURIComponent(p.slug)}`, label: `Add a page inside ${label}` } : null,
      menu: [
        ...(c.member ? [{ label: "Add a sub-page", icon: "plus", href: `/pages/new?parent=${encodeURIComponent(p.slug)}` }] : []),
        c.fav("doc", p.slug, label, { href, icon: p.icon, doc_kind: "page", editor: "blocks" }),
        { label: "Copy link", icon: "link", onClick: () => c.copy(href, label) },
        { label: "Open in new tab", icon: "external", href, external: true },
      ],
    },
  };
}

function itemNode(c: Ctx, it: NavItem): TreeNode {
  const label = (it.title?.trim() || it.filename || it.slug);
  const href = `/${encodeURIComponent(it.slug)}`;
  return {
    key: `ws:${c.ws.id}:item:${it.slug}`,
    sig: sig("i", label, it.kind, it.renderer, it.mime, it.filename, it.folder_id, c.member, isFavorite(c.ws.id, "doc", it.slug)),
    label,
    icon: <ItemIcon it={it} />,
    href,
    leaf: true,
    drag: c.member ? { type: "items", workspaceId: c.ws.id, slugs: [it.slug], label, fromFolderId: it.folder_id ?? null } : null,
    actions: {
      menu: [
        c.fav("doc", it.slug, label, { href, doc_kind: it.kind, renderer: it.renderer, mime: it.mime, filename: it.filename }),
        { label: "Copy link", icon: "link", onClick: () => c.copy(href, label) },
        { label: "Open in new tab", icon: "external", href, external: true },
      ],
    },
  };
}

/** What sits directly in a place (a folder, or the top level): pages first, then documents and files,
 *  then "N more" (a link to the folder view) when the outline was cut. */
function placeNodes(c: Ctx, nav: WorkspaceNav, folderId: string | null, href: string, shown: boolean): TreeNode[] {
  const here = nav.items.filter((it) => (it.folder_id ?? null) === folderId);
  const out = here.map((it) =>
    it.kind === "page" ? pageNode(c, it, { folderId, parent: null, ancestors: [] }, shown) : itemNode(c, it),
  );
  const more = nav.more[folderId ?? "root"];
  if (more) {
    out.push({
      key: `ws:${c.ws.id}:more:${folderId ?? "root"}`,
      sig: sig("m", more, href),
      label: `${more} more`,
      icon: <Icon name="more" size={16} />,
      href,
      leaf: true,
      className: "text-text-muted",
    });
  }
  return out;
}


/* ── Teams: each team's row, its system rows and its pages / files tree ──────────────── */

type TeamFolder = TreeFolder & { team_ids?: string[]; meetings?: boolean };

/** One team: the row opens its home; open, it shows Meetings, People & memory, its projects, then its pages and
 *  files (folders, pages with sub-pages, documents, files). General's tree is the company-wide content. */
function teamNode(
  c: Ctx, t: TeamCard, teams: TeamsSidebar, tree: WorkspaceTree | null, nav: NavSlot<WorkspaceNav> | undefined,
  onFiles: ((wsId: string, folderId: string | null, label: string, files: File[]) => void) | null,
): TreeNode {
  const { ws } = c;
  const k = (sub?: string) => wsTeamRowKey(ws.id, t.id, sub);
  const open = c.expanded.has(k());
  const inTeam = !!t.my_role || t.can_admin;
  const admin = can(tree?.workspace.role ?? ws.role, "admin");
  const wsHref = `/w/${encodeURIComponent(ws.id)}`;
  const folderHref = (id: string) => `${wsHref}/f/${encodeURIComponent(id)}`;
  const newPage = (folder?: string) => `/pages/new?workspace=${encodeURIComponent(ws.id)}${t.general ? "" : `&team=${encodeURIComponent(t.id)}`}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;
  const filesTo = (folderId: string | null, label: string) =>
    c.member && inTeam && onFiles ? (files: File[]) => onFiles(ws.id, folderId, label, files) : undefined;
  const projects = teams.projects.filter((pr) => pr.team_ids.includes(t.id) && pr.status !== "archived");
  const system: TreeNode[] = [
    { key: k("meetings"), sig: sig("tm", t.id, t.general), label: "Meetings", icon: <Icon name="mic" size={16} />, href: teamMeetingsHref(ws.id, t), leaf: true },
    { key: k("memory"), sig: sig("tmem", t.id, t.general), label: "People & memory", icon: <Icon name="users" size={16} />,
      href: t.general ? `/team/${encodeURIComponent(ws.id)}` : teamMemoryHref(ws.id, t), leaf: true },
    ...projects.map((pr): TreeNode => ({
      key: k(`project:${pr.id}`), sig: sig("pr", pr.name, pr.slug, isFavorite(ws.id, "project", pr.id)), label: pr.name,
      icon: <Icon name="layers" size={16} />, href: teamProjectHref(ws.id, pr), leaf: true,
      actions: { menu: [c.fav("project", pr.id, pr.name, { href: teamProjectHref(ws.id, pr) }), { label: "Copy link", icon: "link", onClick: () => c.copy(teamProjectHref(ws.id, pr), pr.name) }] },
    })),
  ];
  // The pages / files tree: General's = folders without teams + company-wide items; a team's = its folders + its items.
  let content: TreeNode[] = [];
  if (open && tree && nav !== null) {
    const folders = (tree.folders as TeamFolder[]).filter((f) => (t.general ? !f.team_ids?.length && !f.meetings : !!f.team_ids?.includes(t.id)));
    const ids = new Set(folders.map((f) => f.id));
    const kids = childrenMap(folders.map((f) => (f.parent_id && !ids.has(f.parent_id) ? { ...f, parent_id: null } : f)));
    // An item filed in a folder the tree doesn't show sits at the team's top level.
    const outline: WorkspaceNav | null = nav ? { ...nav, items: nav.items.map((it) => (it.folder_id && !ids.has(it.folder_id) ? { ...it, folder_id: null } : it)) } : null;
    const build = (f: TreeFolder, parentShown: boolean): TreeNode => {
      const shown = parentShown && c.expanded.has(wsFolderKey(ws.id, f.id));
      const sub = (kids.get(f.id) ?? []).map((x) => build(x, shown));
      const items = outline ? placeNodes(c, outline, f.id, folderHref(f.id), shown) : [];
      const all = [...sub, ...items];
      const blocked = admin ? [...descendants(tree.folders, f.id)] : [];
      return {
        key: wsFolderKey(ws.id, f.id),
        sig: sig("f", f.name, f.parent_id, f.share?.level ?? null, !all.length, c.member, admin, blocked),
        label: f.name,
        icon: <Icon name="folder" size={16} />,
        href: folderHref(f.id),
        children: all.length ? all : undefined,
        leaf: !all.length,
        marker: f.share ? (
          <span className="inline-flex shrink-0 text-text-muted" title={f.share.level === "link" ? "Shared by link" : "Shared with the team"}>
            <Icon name="link" size={12} />
            <span className="md-visually-hidden">, shared</span>
          </span>
        ) : undefined,
        drop: c.member ? { workspaceId: ws.id, folderId: f.id, label: f.name, acceptsFolders: admin } : null,
        drag: admin ? { type: "folder", workspaceId: ws.id, folderId: f.id, label: f.name, parentId: f.parent_id, blocked } : null,
        onFiles: filesTo(f.id, f.name),
        actions: {
          add: c.member && inTeam ? { href: newPage(f.id), label: `New page in ${f.name}` } : null,
          menu: [
            ...(c.member && inTeam ? [{ label: "New page here", icon: "plus", href: newPage(f.id) }] : []),
            { label: "Copy link", icon: "link", onClick: () => c.copy(folderHref(f.id), f.name) },
          ],
        },
      };
    };
    content = [...(kids.get(null) ?? []).map((f) => build(f, true)), ...(outline ? placeNodes(c, outline, null, wsHref, true) : [])];
    if (!content.length && nav) {
      content = [{ key: `${k()}:empty`, sig: sig("e", inTeam), label: inTeam ? "No pages yet. Use + to add one." : "Nothing here yet", note: true }];
    }
  }
  const lazy = open && (!tree || nav === null);
  const fav = isFavorite(ws.id, "team", t.id);
  return {
    key: k(),
    sig: sig("t", t.name, t.icon, t.color, t.visibility, t.slug, t.can_manage, t.general, inTeam, fav, lazy, projects.map((pr) => [pr.id, pr.name])),
    label: t.name,
    icon: <TeamTile team={t} size={18} />,
    href: teamHomeHref(ws.id, t),
    marker: t.general ? <span className="md-tree__tag" title="Everyone in the workspace is in it">Everyone</span>
      : t.visibility === "private" ? (
        <span className="inline-flex shrink-0 text-text-muted" title="Private team"><Icon name="lock" size={12} /><span className="md-visually-hidden">, private</span></span>
      ) : undefined,
    children: open ? [...system, ...(content.length ? [{ key: `${k()}:div`, sig: "d", label: "", note: true, className: "md-tree__divider" } as TreeNode, ...content] : [])] : [...system],
    lazy,
    drop: c.member && inTeam && t.general ? { workspaceId: ws.id, folderId: null, label: `${t.name}`, acceptsFolders: admin } : null,
    onFiles: t.general ? filesTo(null, t.name) : undefined,
    actions: {
      add: c.member && inTeam ? { href: newPage(), label: `New page in ${t.name}` } : null,
      menu: [
        ...(c.member && inTeam ? [{ label: "New page", icon: "plus", href: newPage() }] : []),
        ...(t.can_manage ? [{ label: "Team settings", icon: "settings", href: teamSettingsHref(ws.id, t) }] : []),
        c.fav("team", t.id, t.name, { href: teamHomeHref(ws.id, t), icon: t.icon, color: t.color, general: t.general }),
        { label: "Copy link", icon: "link", onClick: () => c.copy(teamHomeHref(ws.id, t), t.name) },
      ],
    },
  };
}

/** Favorites: one row each (a page, a file, a project or a team). */
function favoriteNode(c: Ctx, f: Favorite): TreeNode {
  const label = f.title?.trim() || "Untitled";
  const icon = f.kind === "team" ? <TeamTile team={{ name: label, icon: f.icon ?? null, color: f.color ?? null }} size={16} />
    : f.kind === "project" ? <Icon name="layers" size={16} />
    : f.doc_kind === "page" || f.editor === "blocks" ? <PageIcon icon={f.icon} />
    : <ItemIcon it={{ slug: f.ref, title: f.title, kind: (f.doc_kind ?? "markdown") as NavItem["kind"], folder_id: null, renderer: f.renderer, mime: f.mime, filename: f.filename } as NavItem} />;
  return {
    key: `ws:${c.ws.id}:fav:${f.kind}:${f.ref}`,
    sig: sig("fav", label, f.icon, f.href, f.kind),
    label, icon, href: f.href, leaf: true,
    actions: { menu: [c.fav(f.kind, f.ref, label), { label: "Copy link", icon: "link", onClick: () => c.copy(f.href, label) }] },
  };
}

export interface SideNavProps {
  data: RailData;
  active: string | null;
  /** Expanded tree keys (team rows, folders, pages). */
  expanded: Set<string>;
  onToggle: (key: string, open: boolean) => void;
  onNavigate?: () => void;
  onFeedback: () => void;
  /** Extra content after the bottom links (the drawer adds theme + identity). */
  footer?: React.ReactNode;
  className?: string;
  /** The icon rail instead of the full sidebar (desktop: collapsed by choice; tablets: always). */
  collapsed?: boolean;
  /** Shows "Expand" on the icon rail. */
  onExpand?: () => void;
  /** Shows "Collapse" at the bottom of the full sidebar (desktop). */
  onCollapse?: () => void;
}

/** Section heading (FAVORITES, TEAMS, YOU) with an optional action on the right. */
function Heading({ id, children, action }: { id: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-0.5 mt-1 flex h-7 items-center justify-between gap-2 px-2.5">
      <h2 id={id} className="text-eyebrow uppercase text-text-muted">{children}</h2>
      {action}
    </div>
  );
}

/**
 * The sidebar (nav redesign 2026-11-10, Option A "One tree"): the workspace switcher; Search ⌘K, Home, Inbox,
 * Ask <workspace>; Favorites; Teams — General first (everyone), each team expanding inline to Meetings,
 * People & memory, its projects and its pages / files tree — and Browse teams; "You" (My files, Shared, Recent,
 * Analytics, Trash); then settings and help. `nav aria-label="Your drive"`. Files dropped on a folder upload there.
 *
 * Data: the workspace shown costs its folder tree (lib/workspaceStore), its teams (lib/teamsStore), favorites
 * (lib/favorites) and one outline per open team (lib/navStore); all cached and refreshed in the background.
 */
export function SideNav({ data, active, expanded: expandedRaw, onToggle: onToggleRaw, onNavigate, onFeedback, footer, className, collapsed, onExpand, onCollapse }: SideNavProps) {
  const router = useRouter();
  const urlWs = workspaceOfKey(active);
  const ws = useRailWorkspace(data.workspaces, urlWs);
  const wsId = ws?.id ?? null;
  const teamsVersion = useTeamsSidebar(wsId ? [wsId] : [], active ?? "");
  const favVersion = useFavorites(wsId, active ?? "");
  const teams = wsId ? teamsSlot(wsId) : undefined;
  const general = generalOf(teams);
  // General starts open (it holds what everyone used to see at the top of a workspace): open unless "<key>!closed".
  const expanded = useMemo(() => {
    const out = new Set(expandedRaw);
    if (wsId && general && !expandedRaw.has(closedKey(wsTeamRowKey(wsId, general.id)))) out.add(wsTeamRowKey(wsId, general.id));
    return out;
  }, [expandedRaw, wsId, general]);
  const onToggle = useCallback((key: string, open: boolean) => {
    if (general && wsId && key === wsTeamRowKey(wsId, general.id)) {
      onToggleRaw(closedKey(key), !open);
      if (!open) onToggleRaw(key, false);   // a folder link may have opened it explicitly
    } else onToggleRaw(key, open);
  }, [onToggleRaw, general, wsId]);
  const container = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const uid = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [newTeam, setNewTeam] = useState(false);
  const uploads = useUploads();
  const toast = useToast();
  const { user, loading: authLoading } = useAuth();
  const viewer = user?.id ?? null;
  // The Admin link: the server decides (only admins get `admin` on /auth/me, never on the studio host).
  const showAdmin = !!user?.admin && mounted && !isStudioHost(window.location.hostname);

  const trees = useWorkspaceTrees(wsId ? [wsId] : []);
  const tree = (wsId ? trees[wsId] : null) || null;
  useEffect(() => {
    if (!wsId) return;
    refreshTree(wsId, 10_000);
    const onFocus = () => { if (document.visibilityState !== "hidden") refreshTree(wsId, 60_000); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [wsId]);

  // One outline per open team: General's is the workspace's ("company"), a team's is its space.
  const myTeams = useMemo(() => (teams ? teams.teams.filter((t) => t.general || t.my_role || t.can_admin) : []), [teams]);
  const navIds = useMemo(() => {
    if (!wsId) return [];
    return myTeams.filter((t) => expanded.has(wsTeamRowKey(wsId, t.id))).map((t) => (t.general ? wsId : navTeamKey(wsId, t.id)));
  }, [wsId, myTeams, expanded]);
  const [wantPages, setWantPages] = useState<string[]>([]);
  const navVersion = useNavRetain(navIds, wantPages);

  const onFiles = useMemo(
    () => (uploads
      ? (w: string, folderId: string | null, label: string, files: File[]) => uploads.upload(files, uploads.resolve(w, folderId, label))
      : null),
    [uploads],
  );
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const copy = useCallback((href: string, label: string) => {
    void copyText(absolute(href)).then((ok) => (ok ? toastRef.current.success(`Link to “${label}” copied`) : toastRef.current.error("Couldn't copy")));
  }, []);
  const fav = useCallback((w: string) => (kind: FavoriteKind, ref: string, label: string, draft?: Partial<Favorite>): MenuEntry => {
    const on = isFavorite(w, kind, ref);
    return {
      label: on ? "Remove from favorites" : "Add to favorites", icon: "star",
      onClick: () => {
        toggleFavorite(w, kind, ref, !on, { title: label, ...draft }).then(
          () => toastRef.current.success(on ? `Removed “${label}” from favorites` : `Added “${label}” to favorites`),
          () => toastRef.current.error("Couldn't change your favorites"),
        );
      },
    };
  }, []);

  const prevNodes = useRef<{ byKey: Map<string, TreeNode>; deps: unknown[] }>({ byKey: new Map(), deps: [] });
  const built = useMemo(() => {
    const want: string[] = [];
    if (!ws || !teams) return { teams: [] as TreeNode[], favs: [] as TreeNode[], want };
    const c: Ctx = { ws, member: can(tree?.workspace.role ?? ws.role, "member"), expanded, want, copy, teams, fav: fav(ws.id) };
    const fresh = myTeams.map((t) => teamNode(c, t, teams, tree, navSlot(t.general ? ws.id : navTeamKey(ws.id, t.id)), onFiles));
    const favs = (favoritesSlot(ws.id) || []).map((f) => favoriteNode(c, f));
    const deps = [onFiles, copy, fav];
    const prev = prevNodes.current.deps.every((d, i) => d === deps[i]) && prevNodes.current.deps.length ? prevNodes.current.byKey : new Map<string, TreeNode>();
    const { nodes, byKey } = shareNodes([...fresh, ...favs], prev);
    prevNodes.current = { byKey, deps };
    return { teams: nodes.slice(0, fresh.length), favs: nodes.slice(fresh.length), want: [...new Set(want)].sort() };
  }, [ws, teams, tree, myTeams, expanded, onFiles, viewer, copy, fav, navVersion, teamsVersion, favVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const wantSig = built.want.join(",");
  useEffect(() => {
    setWantPages((w) => (w.join(",") === wantSig ? w : wantSig ? wantSig.split(",") : []));
  }, [wantSig]);

  const layoutKey = [
    mounted, wsId, data.workspaces?.length ?? -1, [...expanded].join(","), tree ? tree.folders.length : String(tree),
    navVersion, teamsVersion, favVersion, data.sharedNew ?? -1,
  ].join("|");
  useActivePill(container, pill, active, layoutKey);

  const fresh = data.sharedNew ?? 0;
  const unread = useUnreadCount();
  const pwa = usePwa();
  const go = (fn: () => void) => () => { onNavigate?.(); fn(); };

  if (collapsed) {
    return (
      <CollapsedRail
        container={container} pill={pill} data={data} ws={ws} general={general} active={active} unread={unread} fresh={fresh}
        onExpand={onExpand} onFeedback={onFeedback} canInstall={!!pwa.installPath} onInstall={pwa.install} admin={showAdmin}
      />
    );
  }

  const extra = teams ? teams.browse.open + teams.browse.private - myTeams.filter((t) => !t.general).length : 0;
  const askKey = wsId ? `ws:${wsId}:ask` : "ask";
  const loadingWs = data.workspaces === undefined && (authLoading || !!user);
  const switchTo = (w: Workspace) => {
    try { localStorage.setItem(WS_KEY, w.id); } catch { /* storage off */ }
    onNavigate?.();
    router.push(`/w/${encodeURIComponent(w.id)}/teams/general`);
  };

  return (
    <nav ref={container} aria-label="Your drive" className={cx("relative flex min-h-full flex-col gap-3 px-3 py-3", className)}>
      <span ref={pill} aria-hidden className="pointer-events-none absolute rounded-lg bg-accent-soft opacity-0" />

      {/* The workspace switcher: which workspace the sidebar shows (its teams, favorites and Ask). */}
      {loadingWs ? (
        <div aria-busy="true" className="flex h-12 items-center gap-2.5 px-2"><Skeleton width={30} height={30} variant="rect" /><Skeleton width="50%" height={12} /></div>
      ) : ws ? (
        <Dropdown
          portal align="left" aria-label="Switch workspace" minWidth={260}
          trigger={
            <button type="button" className="md-focus flex min-h-12 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-left hover:border-border hover:bg-surface-hover" data-testid="ws-switcher">
              <WorkspaceTile ws={ws} active size={30} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body-strong text-text" dir="auto">{ws.name}</span>
                <span className="truncate text-caption text-text-muted">{ws.member_count ? `${ws.member_count} ${ws.member_count === 1 ? "member" : "members"}` : "Workspace"}</span>
              </span>
              <Icon name="chevronDown" size={14} className="shrink-0 text-text-muted" />
            </button>
          }
          items={[
            { header: "Workspaces" },
            ...(data.workspaces ?? []).map((w) => ({
              label: w.name, tile: <WorkspaceTile ws={w} active={w.id === wsId} size={20} />, onClick: () => switchTo(w),
              ...(w.id === wsId ? { icon: "check" } : {}),
            })),
            { label: "New workspace", icon: "plus", href: "/settings/workspaces", separated: true },
            { label: "Workspace settings", icon: "settings", href: `/settings/workspaces/${encodeURIComponent(ws.id)}` },
          ]}
        />
      ) : null}

      <div className="flex flex-col gap-0.5">
        <button type="button" className={cx(ITEM, "w-full cursor-pointer border border-border bg-surface text-left")} onClick={go(openCommandPalette)} data-testid="rail-search"
          aria-label="Search (⌘K)">
          <Icon name="search" size={16} /> <span className="flex-1 truncate">Search</span>
          <kbd className="shrink-0 rounded border border-border px-1 text-micro text-text-muted max-lg:hidden">⌘K</kbd>
        </button>
        <RailLink k="home" href="/dashboard" active={active} onNavigate={onNavigate}>
          <Icon name="home" size={18} /> <span className="truncate">Home</span>
        </RailLink>
        <button type="button" className={cx(ITEM, "w-full cursor-pointer bg-transparent text-left")} onClick={go(openNotifications)}
          aria-haspopup="dialog" aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"} data-testid="rail-inbox">
          <Icon name="bell" size={18} /> <span className="truncate">Inbox</span>
          {unread > 0 && <span className="ml-auto shrink-0 rounded-full bg-accent px-1.5 text-micro font-semibold text-on-accent">{unread > 99 ? "99+" : unread}</span>}
        </button>
        {/* Ask: the assistant's own page, about this workspace (⌘J still opens it as a side panel anywhere). */}
        <RailLink k={active === "ask" ? "ask" : askKey} href={askLinkFor(active, wsId)} active={active} onNavigate={onNavigate} testId="rail-ask">
          <Icon name="sparkle" size={18} className="text-accent-text" /> <span className="truncate">{ws ? `Ask ${ws.name}` : "Ask"}</span>
        </RailLink>
      </div>

      {built.favs.length > 0 && (
        <section aria-labelledby={`${uid}-fav`} className="flex flex-col">
          <Heading id={`${uid}-fav`}>Favorites</Heading>
          <TreeView label="Favorites" nodes={built.favs} expanded={expanded} onToggle={onToggle} current={active} onNavigate={onNavigate}
            itemClassName={TREE_ITEM} activeClassName={ACTIVE} />
        </section>
      )}

      {ws && (
        <section aria-labelledby={`${uid}-teams`} className="flex flex-col" data-testid="rail-teams">
          <Heading id={`${uid}-teams`} action={teams && teams.can_create ? (
            <Tooltip content="New team" side="right">
              <button type="button" aria-label="New team" onClick={() => setNewTeam(true)} data-testid="rail-new-team"
                className="md-focus grid size-6 cursor-pointer place-items-center rounded-md bg-transparent text-text-muted hover:bg-surface-hover hover:text-text pointer-coarse:size-9">
                <Icon name="plus" size={14} />
              </button>
            </Tooltip>
          ) : undefined}>Teams</Heading>
          {teams === null || teams === undefined ? (
            <div aria-busy="true" className="flex flex-col">
              <span className="md-visually-hidden">Loading teams</span>
              {["58%", "44%", "50%"].map((w) => (
                <span key={w} aria-hidden className="flex h-[30px] items-center gap-2.5 px-2.5 max-lg:h-11">
                  <Skeleton width={18} height={18} variant="rect" className="shrink-0" />
                  <Skeleton width={w} height={10} />
                </span>
              ))}
            </div>
          ) : teams === false ? (
            <p className="px-2.5 text-caption text-text-muted">Couldn&apos;t load the teams.</p>
          ) : (
            <TreeView label="Teams" nodes={built.teams} expanded={expanded} onToggle={onToggle} current={active} onNavigate={onNavigate}
              itemClassName={TREE_ITEM} activeClassName={ACTIVE} />
          )}
          {teams && (
            <RailLink k={wsBrowseKey(ws.id)} href={browseHref(ws.id)} active={active} onNavigate={onNavigate} className="text-text-muted" testId="rail-browse-teams">
              <Icon name="compass" size={16} /> <span className="truncate">Browse teams{extra > 0 ? <span className="text-text-muted"> · {extra} more</span> : null}</span>
            </RailLink>
          )}
          {teams && teams.review?.pending ? (
            <RailLink k={wsReviewKey(ws.id)} href={reviewHref(ws.id)} active={active} onNavigate={onNavigate} className="text-text-muted">
              <Icon name="listTree" size={16} /> <span className="truncate">Sort content into teams</span>
              <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-1.5 text-micro font-semibold text-accent-text" title={`${teams.review.pending} suggestions`}>{teams.review.pending}</span>
            </RailLink>
          ) : null}
        </section>
      )}

      <section aria-labelledby={`${uid}-you`} className="flex flex-col gap-0.5">
        <Heading id={`${uid}-you`}>You</Heading>
        <RailLink k="files" href="/dashboard/files" active={active} onNavigate={onNavigate}>
          <Icon name="folder" size={16} /> <span className="truncate">My files</span>
        </RailLink>
        <RailLink k="shared" href="/shared" active={active} onNavigate={onNavigate}>
          <Icon name="inbox" size={16} /> <span className="truncate">Shared with me</span>
          {fresh > 0 && <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-1.5 text-micro font-semibold text-accent-text">{fresh} new</span>}
        </RailLink>
        <RailLink k="recent" href="/recent" active={active} onNavigate={onNavigate}>
          <Icon name="clock" size={16} /> <span className="truncate">Recent</span>
        </RailLink>
        <RailLink k="analytics" href="/dashboard/analytics" active={active} onNavigate={onNavigate}>
          <Icon name="chart" size={16} /> <span className="truncate">Analytics</span>
        </RailLink>
        {/* Trash: deleted items wait here for 30 days (components/trash). */}
        <RailLink k="trash" href="/trash" active={active} onNavigate={onNavigate}>
          <Icon name="trash" size={16} /> <span className="truncate">Trash</span>
        </RailLink>
        {!ws && !loadingWs && (
          <RailLink k="ws:new" href="/settings/workspaces" active={active} onNavigate={onNavigate} className="text-text-muted">
            <Icon name="plus" size={16} /> <span className="truncate">New workspace</span>
          </RailLink>
        )}
      </section>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
        {pwa.installPath && (
          <button type="button" className={cx(ITEM, "w-full cursor-pointer bg-transparent text-left")} onClick={go(pwa.install)} data-testid="rail-install">
            <Icon name="download" size={16} /> <span className="truncate">Install app</span>
          </button>
        )}
        {ws && (
          <RailLink k={wsSettingsKey(ws.id)} href={`/settings/workspaces/${encodeURIComponent(ws.id)}`} active={active} onNavigate={onNavigate}>
            <Icon name="building" size={16} /> <span className="truncate">Workspace settings</span>
          </RailLink>
        )}
        <RailLink k="settings" href="/settings/account" active={active} onNavigate={onNavigate}>
          <Icon name="settings" size={16} /> <span className="truncate">Settings</span>
        </RailLink>
        {showAdmin && (
          // Admins only: the server sets `admin` on /auth/me (backend services/admin_roles).
          <RailLink k="admin" href="/admin" active={active} onNavigate={onNavigate} testId="rail-admin">
            <Icon name="shieldCheck" size={16} /> <span className="truncate">Admin</span>
          </RailLink>
        )}
        <RailLink k="docs" href={DOCS_URL} active={active} onNavigate={onNavigate}>
          <Icon name="help" size={16} /> <span className="truncate">Help &amp; docs</span>
        </RailLink>
        <button type="button" className={cx(ITEM, "w-full cursor-pointer bg-transparent text-left")} onClick={onFeedback}>
          <Icon name="message" size={16} /> <span className="truncate">Send feedback</span>
        </button>
        {onCollapse && (
          <button type="button" className={cx(ITEM, "w-full cursor-pointer bg-transparent text-left text-text-muted")} onClick={onCollapse}
            aria-label="Collapse the sidebar" data-testid="rail-collapse">
            <Icon name="sidebar" size={16} /> <span className="truncate">Collapse</span>
          </button>
        )}
        {footer}
      </div>
      {ws && newTeam && (
        <TeamDialog ws={ws.id} wsName={ws.name} open={newTeam} onClose={() => setNewTeam(false)}
          onSaved={(t) => { setNewTeam(false); onNavigate?.(); router.push(teamHomeHref(ws.id, t)); }} />
      )}
    </nav>
  );
}

/** One icon in the collapsed rail: a link or a button, its name in a tooltip (and to screen readers). */
function RailIcon({ k, href, label, icon, active, onClick, badge, testId }: {
  k?: string; href?: string; label: string; icon: React.ReactNode; active: string | null; onClick?: () => void; badge?: number; testId?: string;
}) {
  const on = !!k && active === k;
  const cls = cx(
    "md-focus relative grid size-10 place-items-center rounded-lg text-text-secondary no-underline transition-colors duration-(--duration-fast) hover:bg-surface-hover hover:text-text pointer-coarse:size-11",
    on && "text-accent-text hover:bg-transparent hover:text-accent-text",
  );
  const dot = badge ? <span className="absolute right-1 top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-on-accent" aria-hidden>{badge > 99 ? "99+" : badge}</span> : null;
  const inner = href ? (
    <Anchor href={href} data-rail-key={k} aria-current={on ? "page" : undefined} aria-label={label} className={cls} data-testid={testId}>{icon}{dot}</Anchor>
  ) : (
    <button type="button" data-rail-key={k} aria-label={badge ? `${label}, ${badge} unread` : label} className={cx(cls, "cursor-pointer bg-transparent")} onClick={onClick} data-testid={testId}>{icon}{dot}</button>
  );
  return <Tooltip content={label} side="right">{inner}</Tooltip>;
}

/**
 * The collapsed rail (desktop by choice, tablets always): the same places as icons, each named in a
 * tooltip; workspaces as their tiles; Meetings opens a workspace's hub (a menu when there are several).
 * "Expand" brings the full sidebar back (tablets: as a drawer over the page).
 */
function CollapsedRail({ container, pill, data, ws, general, active, unread, fresh, onExpand, onFeedback, canInstall, onInstall, admin }: {
  container: React.RefObject<HTMLElement | null>; pill: React.RefObject<HTMLSpanElement | null>; data: RailData; ws: Workspace | null;
  general?: TeamCard; active: string | null;
  unread: number; fresh: number; onExpand?: () => void; onFeedback: () => void; canInstall: boolean; onInstall: () => void; admin?: boolean;
}) {
  const wss = data.workspaces ?? [];
  const activeWs = workspaceOfKey(active);
  const meetingsWs = wss.find((w) => w.id === activeWs) ?? (wss.length === 1 ? wss[0] : null);
  const meetingsKey = meetingsWs ? wsMeetingsKey(meetingsWs.id) : undefined;
  const meetingsOn = !!active && active.endsWith(":meetings");
  return (
    <nav ref={container} aria-label="Your drive" className="relative flex min-h-full flex-col items-center gap-3 px-2 py-3" data-collapsed="true">
      <span ref={pill} aria-hidden className="pointer-events-none absolute rounded-lg bg-accent-soft opacity-0" />
      {onExpand && (
        <RailIcon label="Expand the sidebar" icon={<Icon name="sidebar" size={18} />} active={active} onClick={onExpand} testId="rail-expand" />
      )}
      <div className="flex flex-col items-center gap-1">
        <RailIcon k="home" href="/dashboard" label="Home" icon={<Icon name="home" size={18} />} active={active} />
        <RailIcon label="Search (⌘K)" icon={<Icon name="search" size={18} />} active={active} onClick={openCommandPalette} testId="rail-search" />
        <RailIcon k={ws ? `ws:${ws.id}:ask` : "ask"} href={askLinkFor(active, ws?.id)} label={ws ? `Ask ${ws.name}` : "Ask"} icon={<Icon name="sparkle" size={18} className="text-accent-text" />} active={active} testId="rail-ask" />
        <RailIcon label="Inbox" icon={<Icon name="bell" size={18} />} active={active} onClick={openNotifications} badge={unread} testId="rail-inbox" />
      </div>
      <span className="h-px w-8 bg-border" aria-hidden />
      <div className="flex flex-col items-center gap-1">
        <RailIcon k="files" href="/dashboard/files" label="My files" icon={<Icon name="folder" size={18} />} active={active} />
        <RailIcon k="shared" href="/shared" label={fresh ? `Shared with me, ${fresh} new` : "Shared with me"} icon={<Icon name="inbox" size={18} />} active={active} badge={fresh || undefined} />
        <RailIcon k="recent" href="/recent" label="Recent" icon={<Icon name="clock" size={18} />} active={active} />
        <RailIcon k="analytics" href="/dashboard/analytics" label="Analytics" icon={<Icon name="chart" size={18} />} active={active} />
        <RailIcon k="trash" href="/trash" label="Trash" icon={<Icon name="trash" size={18} />} active={active} />
      </div>
      {wss.length > 0 && <span className="h-px w-8 bg-border" aria-hidden />}
      <div className="flex flex-col items-center gap-1">
        {wss.length > 0 && (meetingsWs ? (
          <RailIcon k={meetingsKey} href={`/meetings/${encodeURIComponent(meetingsWs.id)}`} label={`Meetings · ${meetingsWs.name}`} icon={<Icon name="mic" size={18} />} active={active} testId="rail-meetings" />
        ) : (
          <Dropdown
            portal
            aria-label="Meetings of"
            trigger={
              <button type="button" aria-label="Meetings" className={cx("md-focus grid size-10 cursor-pointer place-items-center rounded-lg bg-transparent text-text-secondary hover:bg-surface-hover hover:text-text pointer-coarse:size-11", meetingsOn && "text-accent-text")} data-testid="rail-meetings">
                <Icon name="mic" size={18} />
              </button>
            }
            items={[{ header: "Meetings of" }, ...wss.map((w) => ({ label: w.name, icon: "mic", href: `/meetings/${encodeURIComponent(w.id)}` }))]}
          />
        ))}
        {wss.slice(0, 8).map((w) => (
          <RailIcon key={w.id} k={w.id === ws?.id && general ? wsTeamRowKey(w.id, general.id) : wsRootKey(w.id)} href={`/w/${encodeURIComponent(w.id)}/teams/general`} label={w.name}
            icon={<WorkspaceTile ws={w} active={(activeWs ?? ws?.id) === w.id} size={22} />} active={active} />
        ))}
        <RailIcon k="ws:new" href="/settings/workspaces" label="New workspace" icon={<Icon name="plus" size={18} />} active={active} />
      </div>
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-border pt-3">
        {canInstall && <RailIcon label="Install app" icon={<Icon name="download" size={18} />} active={active} onClick={onInstall} />}
        <RailIcon k="settings" href="/settings/account" label="Settings" icon={<Icon name="settings" size={18} />} active={active} />
        {admin && <RailIcon k="admin" href="/admin" label="Admin" icon={<Icon name="shieldCheck" size={18} />} active={active} testId="rail-admin" />}
        <RailIcon k="docs" href={DOCS_URL} label="Help & docs" icon={<Icon name="doc" size={18} />} active={active} />
        <RailIcon label="Send feedback" icon={<Icon name="message" size={18} />} active={active} onClick={onFeedback} />
      </div>
    </nav>
  );
}

export default SideNav;
