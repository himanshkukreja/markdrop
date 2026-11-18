"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Anchor, Dropdown, Icon, Skeleton, Tooltip, copyText, cx, useToast, type MenuEntry } from "@/components/ui";
import { usePwa } from "@/components/pwa/PwaProvider";
import { openNotifications, useUnreadCount } from "./NotificationBell";
import { openCommandPalette } from "./commands";
import { DOCS_URL } from "./links";
import { isStudioHost } from "@/lib/studioHost";
import { TreeView, shareNodes, type TreeNode } from "@/components/workspace/FolderTree";
import { useUploads } from "@/components/workspace/uploads/UploadProvider";
import { can, type NavItem, type Workspace } from "@/lib/workspaces";
import { refreshTree, useWorkspaceTrees } from "@/lib/workspaceStore";
import {
  ALL_DEALS_KEY, askLinkFor, generalOf, workspaceOfKey, wsBrowseKey, wsMeetingsKey, wsReviewKey, wsRootKey, wsSettingsKey, wsTeamRowKey,
} from "@/lib/railKeys.mjs";
import { useAuth } from "@/contexts/AuthContext";
import { TeamTile } from "@/components/teams/parts";
import { ItemIcon, PageIcon } from "@/components/teams/filesTree";
import dynamic from "next/dynamic";
import { teamsSlot, useTeamsSidebar } from "@/lib/teamsStore";
import { favoritesSlot, isFavorite, toggleFavorite, useFavorites, type Favorite, type FavoriteKind } from "@/lib/favorites";
import {
  allDealsHref, allMeetingsHref, browseHref, reviewHref, teamHref as teamHomeHref, teamDealsHref, teamMeetingsHref, teamMemoryHref,
  teamPagesHref, teamSettingsHref, type TeamCard,
} from "@/lib/teams";

// The New team dialog loads when it opens (most visits never open it).
const TeamDialog = dynamic(() => import("@/components/teams/TeamDialog").then((m) => m.TeamDialog), { ssr: false });

/** What the rail shows. Every field may be missing: the rail omits what failed to load. */
export interface RailData {
  workspaces?: Workspace[];
  tokens?: number;
  /** Shared with me: granted in the last 7 days and not opened yet. */
  sharedNew?: number;
}

/** General (the default team) starts open: it is open unless "<key>!closed" is in the saved set. */
const closedKey = (k: string) => `${k}!closed`;
/** The workspace the rail shows when the URL names none (the last one you were in, on this device). */
const WS_KEY = "md_rail_ws";

// The rail's keys and URL → row logic (plain JS, unit tested: lib/railKeys.test.mjs).
export {
  ALL_DEALS_KEY, TEAM_SECTIONS, askLinkFor, generalOf, railKeyFor, resolveRailKey, workspaceOfKey, wsBrowseKey, wsCompanyMeetingsKey,
  wsDealsKey, wsFolderKey, wsMeetingsKey, wsReviewKey, wsRootKey, wsSettingsKey, wsTeamKey, wsTeamRowKey,
} from "@/lib/railKeys.mjs";

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
  // The observers below outlive renders: they read the active key from here, never a stale closure's.
  const current = useRef(active);
  current.current = active;
  const place = (animate: boolean) => {
    const c = container.current, p = pill.current;
    const active = current.current;
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
    // Rows above the active one can appear without the rail changing size (the workspace's links, a team's
    // sections, badges): re-place once a frame after the rail's content changes.
    let frame = 0;
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(false); });
    });
    mo?.observe(c, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo?.disconnect(); if (frame) cancelAnimationFrame(frame); };
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

/* ── Teams: each team's row and its sections ────────────────────────────────────── */

interface Ctx {
  ws: Workspace;
  member: boolean;
  copy: (href: string, label: string) => void;
  /** "Add to / Remove from favorites" for a row's ⋯ menu. */
  fav: (kind: FavoriteKind, ref: string, label: string, draft?: Partial<Favorite>) => MenuEntry;
}

/** A node's `sig` (see shareNodes): the values its row shows and its handlers use. */
const sig = (...parts: unknown[]) => JSON.stringify(parts);

const absolute = (href: string) => (typeof window === "undefined" ? href : new URL(href, window.location.origin).toString());

/** A quiet pill after a row's label ("3 to review"); `label` is what a screen reader hears. */
function Pill({ children, label, accent }: { children: React.ReactNode; label: string; accent?: boolean }) {
  return (
    <span className={cx("ml-auto shrink-0 rounded-full px-1.5 text-micro font-semibold tabular-nums",
      accent ? "bg-accent-soft text-accent-text" : "bg-surface-active text-text-secondary")}>
      <span aria-hidden>{children}</span><span className="md-visually-hidden">, {label}</span>
    </span>
  );
}

/** A team's sections, in this order for every team (General too): Overview, Meetings, Deals (the CRM-linked
 *  team only), Files & pages, People & memory (lib/railKeys TEAM_SECTIONS). Never its meetings, pages, files or
 *  folders: those live in their section. */
function teamNode(c: Ctx, t: TeamCard, onFiles: ((wsId: string, folderId: string | null, label: string, files: File[]) => void) | null): TreeNode {
  const { ws } = c;
  const k = (sub?: string) => wsTeamRowKey(ws.id, t.id, sub);
  const inTeam = !!t.my_role || t.can_admin;
  const newPage = `/pages/new?workspace=${encodeURIComponent(ws.id)}${t.general ? "" : `&team=${encodeURIComponent(t.id)}`}`;
  const review = t.to_review ?? 0;
  const sections: TreeNode[] = [
    { key: k("overview"), sig: sig("tov", t.id), label: "Overview", icon: <Icon name="grid" size={16} />, href: teamHomeHref(ws.id, t), leaf: true },
    { key: k("meetings"), sig: sig("tm", t.id, review), label: "Meetings", icon: <Icon name="mic" size={16} />, href: teamMeetingsHref(ws.id, t), leaf: true,
      marker: review > 0 ? <Pill accent label={`${review} to review`}>{review} to review</Pill> : undefined },
    ...(t.hubspot ? [{ key: k("deals"), sig: sig("tdeals", t.id, t.deals), label: "Deals", icon: <Icon name="briefcase" size={16} />, href: teamDealsHref(ws.id, t), leaf: true,
      marker: t.deals ? <Pill label={`${t.deals} open`}>{t.deals}</Pill> : undefined } satisfies TreeNode] : []),
    { key: k("files"), sig: sig("tfiles", t.id, t.slug), label: "Files & pages", icon: <Icon name="folder" size={16} />, href: teamPagesHref(ws.id, t), leaf: true },
    { key: k("memory"), sig: sig("tmem", t.id, t.general), label: "People & memory", icon: <Icon name="users" size={16} />,
      href: t.general ? `/team/${encodeURIComponent(ws.id)}` : teamMemoryHref(ws.id, t), leaf: true },
  ];
  const fav = isFavorite(ws.id, "team", t.id);
  return {
    key: k(),
    sig: sig("t", t.name, t.icon, t.color, t.visibility, t.slug, t.can_manage, t.general, inTeam, fav),
    label: t.name,
    icon: <TeamTile team={t} size={18} />,
    href: teamHomeHref(ws.id, t),
    marker: t.visibility === "private" && !t.general ? (
      <span className="inline-flex shrink-0 text-text-muted" title="Private team"><Icon name="lock" size={12} /><span className="md-visually-hidden">, private</span></span>
    ) : undefined,
    children: sections,
    // Files dropped on General upload to the workspace's top level (its Files & pages).
    drop: c.member && t.general ? { workspaceId: ws.id, folderId: null, label: `${t.name}`, acceptsFolders: false } : null,
    onFiles: t.general && c.member && onFiles ? (files: File[]) => onFiles(ws.id, null, t.name, files) : undefined,
    actions: {
      add: c.member && inTeam ? { href: newPage, label: `New page in ${t.name}` } : null,
      menu: [
        ...(c.member && inTeam ? [{ label: "New page", icon: "plus", href: newPage }] : []),
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
    : <ItemIcon it={{ kind: (f.doc_kind ?? "markdown") as NavItem["kind"], renderer: f.renderer, mime: f.mime, filename: f.filename }} />;
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
 * The sidebar (nav redesign 2026-11-18, "sections", brief .work/briefs/nav-redesign.md): the workspace switcher;
 * Search ⌘K, Home, Inbox, Ask <workspace>, Meetings (every team's) and Deals (every team's; only when one of your
 * teams is linked to a CRM); Teams — General first, each team collapsible (remembered on this device) with the same
 * fixed sections: Overview, Meetings ("N to review"), Deals (the CRM-linked team, its open deals), Files & pages,
 * People & memory — then Browse teams; Favorites; You (My files, Shared with me, Recent); then Analytics, Trash,
 * settings and help. The sidebar never lists a team's meetings, pages, files or folders: they live in its sections,
 * so it stays short however much a team makes. `nav aria-label="Your drive"`.
 *
 * Data: the workspace shown costs its teams (lib/teamsStore, with the badges) and favorites (lib/favorites); its
 * folder tree (lib/workspaceStore) only to place a folder page under its team.
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
  // General starts open: open unless "<key>!closed" is in the saved set.
  const expanded = useMemo(() => {
    const out = new Set(expandedRaw);
    if (wsId && general && !expandedRaw.has(closedKey(wsTeamRowKey(wsId, general.id)))) out.add(wsTeamRowKey(wsId, general.id));
    return out;
  }, [expandedRaw, wsId, general]);
  const onToggle = useCallback((key: string, open: boolean) => {
    if (general && wsId && key === wsTeamRowKey(wsId, general.id)) {
      onToggleRaw(closedKey(key), !open);
      if (!open) onToggleRaw(key, false);   // a link inside it may have opened it explicitly
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
  // The Admin link: the server decides (only admins get `admin` on /auth/me, never on the studio host).
  const showAdmin = !!user?.admin && mounted && !isStudioHost(window.location.hostname);

  const trees = useWorkspaceTrees(wsId ? [wsId] : []);
  const tree = (wsId ? trees[wsId] : null) || null;
  useEffect(() => {
    if (!wsId) return;
    refreshTree(wsId, 60_000);
  }, [wsId]);

  const myTeams = useMemo(() => (teams ? teams.teams.filter((t) => t.general || t.my_role || t.can_admin) : []), [teams]);
  const crm = myTeams.filter((t) => t.hubspot);
  const toReview = myTeams.reduce((n, t) => n + (t.to_review ?? 0), 0);
  const openDeals = crm.reduce((n, t) => n + (t.deals ?? 0), 0);

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
    if (!ws || !teams) return { teams: [] as TreeNode[], favs: [] as TreeNode[] };
    const c: Ctx = { ws, member: can(tree?.workspace.role ?? ws.role, "member"), copy, fav: fav(ws.id) };
    const fresh = myTeams.map((t) => teamNode(c, t, onFiles));
    const favs = (favoritesSlot(ws.id) || []).map((f) => favoriteNode(c, f));
    const deps = [onFiles, copy, fav];
    const prev = prevNodes.current.deps.every((d, i) => d === deps[i]) && prevNodes.current.deps.length ? prevNodes.current.byKey : new Map<string, TreeNode>();
    const { nodes, byKey } = shareNodes([...fresh, ...favs], prev);
    prevNodes.current = { byKey, deps };
    return { teams: nodes.slice(0, fresh.length), favs: nodes.slice(fresh.length) };
  }, [ws, teams, tree?.workspace.role, myTeams, onFiles, copy, fav, teamsVersion, favVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const layoutKey = [
    mounted, wsId, data.workspaces?.length ?? -1, [...expanded].join(","), teamsVersion, favVersion, data.sharedNew ?? -1,
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
        crm={crm.length > 0} toReview={toReview}
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
        {/* Every team's meetings and deals you can open, in one place (a Team filter on the page). */}
        {ws && (
          <RailLink k={wsMeetingsKey(ws.id)} href={allMeetingsHref(ws.id)} active={active} onNavigate={onNavigate} testId="rail-meetings">
            <Icon name="mic" size={18} /> <span className="truncate">Meetings</span>
            {toReview > 0 && <Pill accent label={`${toReview} to review`}>{toReview} to review</Pill>}
          </RailLink>
        )}
        {ws && crm.length > 0 && (
          <RailLink k={ALL_DEALS_KEY} href={allDealsHref()} active={active} onNavigate={onNavigate} testId="rail-deals">
            <Icon name="briefcase" size={18} /> <span className="truncate">Deals</span>
            {openDeals > 0 && <Pill label={`${openDeals} open`}>{openDeals}</Pill>}
          </RailLink>
        )}
      </div>

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
              <Pill accent label={`${teams.review.pending} suggestions`}>{teams.review.pending}</Pill>
            </RailLink>
          ) : null}
        </section>
      )}

      {built.favs.length > 0 && (
        <section aria-labelledby={`${uid}-fav`} className="flex flex-col" data-testid="rail-favorites">
          <Heading id={`${uid}-fav`}>Favorites</Heading>
          <TreeView label="Favorites" nodes={built.favs} expanded={expanded} onToggle={onToggle} current={active} onNavigate={onNavigate}
            itemClassName={TREE_ITEM} activeClassName={ACTIVE} />
        </section>
      )}

      <section aria-labelledby={`${uid}-you`} className="flex flex-col gap-0.5">
        <Heading id={`${uid}-you`}>You</Heading>
        <RailLink k="files" href="/dashboard/files" active={active} onNavigate={onNavigate}>
          <Icon name="folder" size={16} /> <span className="truncate">My files</span>
        </RailLink>
        <RailLink k="shared" href="/shared" active={active} onNavigate={onNavigate}>
          <Icon name="inbox" size={16} /> <span className="truncate">Shared with me</span>
          {fresh > 0 && <Pill accent label={`${fresh} new`}>{fresh} new</Pill>}
        </RailLink>
        <RailLink k="recent" href="/recent" active={active} onNavigate={onNavigate}>
          <Icon name="clock" size={16} /> <span className="truncate">Recent</span>
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
        <RailLink k="analytics" href="/dashboard/analytics" active={active} onNavigate={onNavigate}>
          <Icon name="chart" size={16} /> <span className="truncate">Analytics</span>
        </RailLink>
        {/* Trash: deleted items wait here for 30 days (components/trash). */}
        <RailLink k="trash" href="/trash" active={active} onNavigate={onNavigate}>
          <Icon name="trash" size={16} /> <span className="truncate">Trash</span>
        </RailLink>
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
 * The collapsed rail (desktop by choice, tablets always): the same places as icons, each named in a tooltip;
 * Meetings and Deals across the workspace's teams; workspaces as their tiles. "Expand" brings the full sidebar
 * back (tablets: as a drawer over the page).
 */
function CollapsedRail({ container, pill, data, ws, general, active, unread, fresh, crm, toReview, onExpand, onFeedback, canInstall, onInstall, admin }: {
  container: React.RefObject<HTMLElement | null>; pill: React.RefObject<HTMLSpanElement | null>; data: RailData; ws: Workspace | null;
  general?: TeamCard; active: string | null; crm: boolean; toReview: number;
  unread: number; fresh: number; onExpand?: () => void; onFeedback: () => void; canInstall: boolean; onInstall: () => void; admin?: boolean;
}) {
  const wss = data.workspaces ?? [];
  const activeWs = workspaceOfKey(active);
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
        {ws && (
          <RailIcon k={wsMeetingsKey(ws.id)} href={allMeetingsHref(ws.id)} label={toReview ? `Meetings, ${toReview} to review` : "Meetings"}
            icon={<Icon name="mic" size={18} />} active={active} badge={toReview || undefined} testId="rail-meetings" />
        )}
        {ws && crm && (
          <RailIcon k={ALL_DEALS_KEY} href={allDealsHref()} label="Deals" icon={<Icon name="briefcase" size={18} />} active={active} testId="rail-deals" />
        )}
      </div>
      <span className="h-px w-8 bg-border" aria-hidden />
      <div className="flex flex-col items-center gap-1">
        <RailIcon k="files" href="/dashboard/files" label="My files" icon={<Icon name="folder" size={18} />} active={active} />
        <RailIcon k="shared" href="/shared" label={fresh ? `Shared with me, ${fresh} new` : "Shared with me"} icon={<Icon name="inbox" size={18} />} active={active} badge={fresh || undefined} />
        <RailIcon k="recent" href="/recent" label="Recent" icon={<Icon name="clock" size={18} />} active={active} />
      </div>
      {wss.length > 0 && <span className="h-px w-8 bg-border" aria-hidden />}
      <div className="flex flex-col items-center gap-1">
        {wss.slice(0, 8).map((w) => (
          <RailIcon key={w.id} k={w.id === ws?.id && general ? wsTeamRowKey(w.id, general.id, "overview") : wsRootKey(w.id)} href={`/w/${encodeURIComponent(w.id)}/teams/general`} label={w.name}
            icon={<WorkspaceTile ws={w} active={(activeWs ?? ws?.id) === w.id} size={22} />} active={active} />
        ))}
        <RailIcon k="ws:new" href="/settings/workspaces" label="New workspace" icon={<Icon name="plus" size={18} />} active={active} />
      </div>
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-border pt-3">
        {canInstall && <RailIcon label="Install app" icon={<Icon name="download" size={18} />} active={active} onClick={onInstall} />}
        <RailIcon k="analytics" href="/dashboard/analytics" label="Analytics" icon={<Icon name="chart" size={18} />} active={active} />
        <RailIcon k="trash" href="/trash" label="Trash" icon={<Icon name="trash" size={18} />} active={active} />
        <RailIcon k="settings" href="/settings/account" label="Settings" icon={<Icon name="settings" size={18} />} active={active} />
        {admin && <RailIcon k="admin" href="/admin" label="Admin" icon={<Icon name="shieldCheck" size={18} />} active={active} testId="rail-admin" />}
        <RailIcon k="docs" href={DOCS_URL} label="Help & docs" icon={<Icon name="doc" size={18} />} active={active} />
        <RailIcon label="Send feedback" icon={<Icon name="message" size={18} />} active={active} onClick={onFeedback} />
      </div>
    </nav>
  );
}

export default SideNav;
