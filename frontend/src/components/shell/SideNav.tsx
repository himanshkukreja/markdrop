"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Anchor, Dropdown, FileIcon, Icon, Skeleton, Tooltip, copyText, cx, useToast } from "@/components/ui";
import { usePwa } from "@/components/pwa/PwaProvider";
import { openNotifications, useUnreadCount } from "./NotificationBell";
import { DOCS_URL } from "./links";
import { studioUrl } from "@/lib/studioHost";
import { TreeView, shareNodes, type TreeNode } from "@/components/workspace/FolderTree";
import { useUploads } from "@/components/workspace/uploads/UploadProvider";
import { can, type NavItem, type TreeFolder, type Workspace, type WorkspaceNav } from "@/lib/workspaces";
import { childrenMap, descendants, refreshTree, useWorkspaceTrees, type TreeSlot } from "@/lib/workspaceStore";
import { childrenSlot, navSlot, useNavRetain, type NavSlot } from "@/lib/navStore";
import { useAuth } from "@/contexts/AuthContext";
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
/** The workspace's "Guides" link: it opens Markdrop Guides filtered to the workspace (never active here). */
export const wsDocsKey = (id: string) => `ws:${id}:docs`;
/** The workspace's Meetings hub (/meetings/<id>). */
export const wsMeetingsKey = (id: string) => `ws:${id}:meetings`;
/** The workspace's Team board (/team/<id>). */
export const wsTeamKey = (id: string) => `ws:${id}:team`;
const teamHref = (id: string) => `/team/${encodeURIComponent(id)}`;
/** lib/meetings' meetingsHref, without loading the meetings client into the shell. */
const meetingsHref = (id: string) => `/meetings/${encodeURIComponent(id)}`;

/**
 * Which rail item the URL points at. Keys: "home" | "search" | "ask" | "files" | "shared" | "recent" | "analytics" | "trash" |
 * "ws:<id>:root" | "ws:<id>:folder:<fid>" | "ws:<id>:meetings" | "ws:<id>:settings" | "ws:new" | "settings".
 */
export function railKeyFor(pathname: string, search: string): string | null {
  const q = new URLSearchParams(search);
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
  const mt = pathname.match(/^\/meetings\/([^/]+)\/?$/);
  if (mt) return wsMeetingsKey(decodeURIComponent(mt[1]!));
  const tm = pathname.match(/^\/team\/([^/]+)(?:\/.*)?$/);
  if (tm) return wsTeamKey(decodeURIComponent(tm[1]!));
  if (pathname === "/search") return "search";
  if (pathname === "/ask") return "ask";
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

/** The Ask page for where you are: in a workspace, Ask <Workspace> (?workspace=); else Ask. */
export function askLinkFor(active: string | null): string {
  const ws = workspaceOfKey(active);
  return ws ? `/ask?workspace=${encodeURIComponent(ws)}` : "/ask";
}

/** The workspace an item key belongs to, if any. */
export function workspaceOfKey(key: string | null): string | null {
  const m = key?.match(/^ws:([^:]+):/);
  return m ? m[1]! : null;
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
    sig: sig("p", label, p.icon, p.icon_url, isLazy, isLeaf, c.member, at.folderId, at.parent, at.ancestors),
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
    sig: sig("i", label, it.kind, it.renderer, it.mime, it.filename, it.folder_id, c.member),
    label,
    icon: <ItemIcon it={it} />,
    href,
    leaf: true,
    drag: c.member ? { type: "items", workspaceId: c.ws.id, slugs: [it.slug], label, fromFolderId: it.folder_id ?? null } : null,
    actions: {
      menu: [
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

function workspaceNode(
  c: Ctx,
  slot: TreeSlot,
  nav: NavSlot<WorkspaceNav> | undefined,
  active: boolean,
  onFiles: ((wsId: string, folderId: string | null, label: string, files: File[]) => void) | null,
): TreeNode {
  const { ws } = c;
  const tree = slot || null;
  const admin = can(tree?.workspace.role ?? ws.role, "admin");
  const member = c.member;
  const filesTo = (folderId: string | null, label: string) =>
    member && onFiles ? (files: File[]) => onFiles(ws.id, folderId, label, files) : undefined;
  const wsHref = `/w/${encodeURIComponent(ws.id)}`;
  const folderHref = (id: string) => `${wsHref}/f/${encodeURIComponent(id)}`;
  // The outline loads with the tree; until both are here the open workspace shows placeholders.
  const outline = nav || null;
  let children: TreeNode[] | undefined;
  if (tree && nav !== null) {
    const kids = childrenMap(tree.folders);
    const build = (f: TreeFolder, parentShown: boolean): TreeNode => {
      const shown = parentShown && c.expanded.has(wsFolderKey(ws.id, f.id));
      const sub = (kids.get(f.id) ?? []).map((k) => build(k, shown));
      const items = outline ? placeNodes(c, outline, f.id, folderHref(f.id), shown) : [];
      const all = [...sub, ...items];
      const blocked = admin ? [...descendants(tree.folders, f.id)] : [];
      return {
        key: wsFolderKey(ws.id, f.id),
        sig: sig("f", f.name, f.parent_id, f.share?.level ?? null, !all.length, member, admin, blocked),
        label: f.name,
        icon: <Icon name="folder" size={16} />,
        href: folderHref(f.id),
        children: all.length ? all : undefined,
        // Without an outline (it failed), a folder with items opens on the folder view instead.
        leaf: !all.length,
        marker: f.share ? (
          <span className="inline-flex shrink-0 text-text-muted" title={f.share.level === "link" ? "Shared by link" : "Shared with the team"}>
            <Icon name="link" size={12} />
            <span className="md-visually-hidden">, shared</span>
          </span>
        ) : undefined,
        drop: member ? { workspaceId: ws.id, folderId: f.id, label: f.name, acceptsFolders: admin } : null,
        drag: admin
          ? { type: "folder", workspaceId: ws.id, folderId: f.id, label: f.name, parentId: f.parent_id, blocked }
          : null,
        onFiles: filesTo(f.id, f.name),
        actions: {
          add: member ? { href: `/pages/new?workspace=${encodeURIComponent(ws.id)}&folder=${encodeURIComponent(f.id)}`, label: `New page in ${f.name}` } : null,
          menu: [
            ...(member ? [{ label: "New page here", icon: "plus", href: `/pages/new?workspace=${encodeURIComponent(ws.id)}&folder=${encodeURIComponent(f.id)}` }] : []),
            { label: "Copy link", icon: "link", onClick: () => c.copy(folderHref(f.id), f.name) },
          ],
        },
      };
    };
    const open = c.expanded.has(wsRootKey(ws.id));
    // Meetings first: the hub (/meetings/<id>) for members (they can import) and anyone once there are meetings.
    // It stands for the Meetings folder too (one "Meetings" in the tree; the hub opens the folder).
    const hub = member || tree.folders.some((f) => f.meetings);
    const meetingsRow: TreeNode[] = hub ? [{
      key: wsMeetingsKey(ws.id),
      sig: sig("mt", ws.id),
      label: "Meetings",
      icon: <Icon name="mic" size={16} />,
      href: meetingsHref(ws.id),
      leaf: true,
    }] : [];
    // Team (who is doing what): every member (any role) once Team memory is on; admins also while it is off (to turn it on).
    if (ws.settings?.team_memory === true || admin) {
      meetingsRow.push({
        key: wsTeamKey(ws.id),
        sig: sig("tm", ws.id, ws.settings?.team_memory === true),
        label: "Team",
        icon: <Icon name="users" size={16} />,
        href: teamHref(ws.id),
        leaf: true,
      });
    }
    children = [...meetingsRow, ...(kids.get(null) ?? []).filter((f) => !(hub && f.meetings)).map((f) => build(f, open)), ...(outline ? placeNodes(c, outline, null, wsHref, open) : [])];
    if (children.length === meetingsRow.length) {
      children = [...meetingsRow, { key: `ws:${ws.id}:empty`, sig: sig("e", member), label: member ? "No pages yet. Use + to add one." : "Nothing here yet", note: true }];
    }
  }
  const lazy = slot === null || (!!tree && nav === null);
  return {
    key: wsRootKey(ws.id),
    sig: sig("w", ws.name, ws.branding?.logo_url, ws.branding?.site_name, active, lazy, slot === false, member, admin),
    label: ws.name,
    icon: <WorkspaceTile ws={ws} active={active} />,
    href: wsHref,
    children,
    // Not loaded yet: expandable, with placeholders when opened. Failed: a leaf (the folder view
    // explains the error).
    lazy,
    leaf: slot === false,
    className: "font-semibold text-text",
    drop: member ? { workspaceId: ws.id, folderId: null, label: `the top of ${ws.name}`, acceptsFolders: admin } : null,
    onFiles: filesTo(null, ws.name),
    actions: {
      add: member ? { href: `/pages/new?workspace=${encodeURIComponent(ws.id)}`, label: `New page in ${ws.name}` } : null,
      menu: [
        ...(member ? [{ label: "New page", icon: "plus", href: `/pages/new?workspace=${encodeURIComponent(ws.id)}` }] : []),
        // The workspace's guides live in Markdrop Guides (its own area); this opens it filtered.
        { label: "Open in Guides", icon: "layers", href: studioUrl(`/?ws=${encodeURIComponent(ws.id)}`) },
        { label: "Workspace settings", icon: "settings", href: `/settings/workspaces/${encodeURIComponent(ws.id)}` },
      ],
    },
  };
}

export interface SideNavProps {
  data: RailData;
  active: string | null;
  /** Expanded tree keys (workspace roots and folders). */
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

/**
 * The drive rail (simpler UI, Main board): My files · Shared with me ("N new") · Recent, then
 * WORKSPACES (each workspace › its folders › their pages (with sub-pages), documents and files),
 * "New workspace", then the quieter account links at the bottom. `nav aria-label="Your drive"`.
 * Files dropped on a folder upload there.
 *
 * Data: an open workspace costs two requests whatever is open inside it: its folder tree (the
 * shared workspaceStore copy the folder view uses too) and its outline (`/nav`, lib/navStore);
 * an open page asks for its sub-pages once (shared with the page tree). Both are cached and
 * refreshed in the background (on mount when older than 10 s, on window focus after a minute,
 * and whenever `workspaceChanged` / a page change says so), so moving around the app never
 * blanks or refetches the tree.
 */
export function SideNav({ data, active, expanded, onToggle, onNavigate, onFeedback, footer, className, collapsed, onExpand, onCollapse }: SideNavProps) {
  const container = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const uid = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const uploads = useUploads();
  const toast = useToast();
  const { user, loading: authLoading } = useAuth();
  const viewer = user?.id ?? null;
  const activeWs = workspaceOfKey(active);

  const openWs = useMemo(
    () => (data.workspaces ?? []).filter((w) => expanded.has(wsRootKey(w.id))).map((w) => w.id),
    [data.workspaces, expanded],
  );
  const trees = useWorkspaceTrees(openWs);
  // Coming back to the app (from a page, another tab) refreshes the open trees in the background.
  const openSig = openWs.join(",");
  useEffect(() => {
    const ids = openSig ? openSig.split(",") : [];
    for (const id of ids) refreshTree(id, 10_000);
    const onFocus = () => { if (document.visibilityState !== "hidden") for (const id of ids) refreshTree(id, 60_000); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [openSig]);

  // The open pages whose sub-pages are on screen (known after building the nodes).
  const [wantPages, setWantPages] = useState<string[]>([]);
  const navVersion = useNavRetain(openWs, wantPages);

  const onFiles = useMemo(
    () => (uploads
      ? (wsId: string, folderId: string | null, label: string, files: File[]) => uploads.upload(files, uploads.resolve(wsId, folderId, label))
      : null),
    [uploads],
  );
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const copy = useCallback((href: string, label: string) => {
    void copyText(absolute(href)).then((ok) => (ok ? toastRef.current.success(`Link to “${label}” copied`) : toastRef.current.error("Couldn't copy")));
  }, []);

  // The previous build's nodes, for shareNodes (dropped when the handlers nodes close over change).
  const prevNodes = useRef<{ byKey: Map<string, TreeNode>; deps: unknown[] }>({ byKey: new Map(), deps: [] });
  const built = useMemo(() => {
    const want: string[] = [];
    const fresh = (data.workspaces ?? []).map((ws) => {
      const slot = trees[ws.id] ?? null;
      const open = expanded.has(wsRootKey(ws.id));
      const c: Ctx = { ws, member: can((slot || null)?.workspace.role ?? ws.role, "member"), expanded, want, copy };
      return workspaceNode(c, slot, open ? navSlot(ws.id) : undefined, ws.id === activeWs, onFiles);
    });
    const deps = [onFiles, copy];
    const prev = prevNodes.current.deps.every((d, i) => d === deps[i]) && prevNodes.current.deps.length ? prevNodes.current.byKey : new Map<string, TreeNode>();
    const { nodes, byKey } = shareNodes(fresh, prev);
    prevNodes.current = { byKey, deps };
    return { nodes, want: [...new Set(want)].sort() };
    // navVersion: the outlines and sub-page lists (read through navSlot / childrenSlot) changed.
  }, [data.workspaces, trees, expanded, activeWs, onFiles, viewer, copy, navVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const nodes = built.nodes;
  const wantSig = built.want.join(",");
  useEffect(() => {
    setWantPages((w) => (w.join(",") === wantSig ? w : wantSig ? wantSig.split(",") : []));
  }, [wantSig]);

  const layoutKey = [
    mounted,
    data.workspaces?.length ?? -1,
    [...expanded].join(","),
    Object.entries(trees).map(([k, v]) => `${k}:${v ? v.folders.length : String(v)}`).join(","),
    navVersion,
    data.sharedNew ?? -1,
    data.tokens ?? -1,
  ].join("|");
  useActivePill(container, pill, active, layoutKey);

  const fresh = data.sharedNew ?? 0;
  const unread = useUnreadCount();
  const pwa = usePwa();
  const go = (fn: () => void) => () => { onNavigate?.(); fn(); };

  if (collapsed) {
    return (
      <CollapsedRail
        container={container} pill={pill} data={data} active={active} unread={unread} fresh={fresh}
        onExpand={onExpand} onFeedback={onFeedback} canInstall={!!pwa.installPath} onInstall={pwa.install}
      />
    );
  }

  return (
    <nav ref={container} aria-label="Your drive" className={cx("relative flex min-h-full flex-col gap-4 px-3 py-3", className)}>
      <span ref={pill} aria-hidden className="pointer-events-none absolute rounded-lg bg-accent-soft opacity-0" />

      <div className="flex flex-col gap-0.5">
        <RailLink k="home" href="/dashboard" active={active} onNavigate={onNavigate}>
          <Icon name="home" size={18} /> <span className="truncate">Home</span>
        </RailLink>
        <RailLink k="search" href="/search" active={active} onNavigate={onNavigate}>
          <Icon name="search" size={18} /> <span className="truncate">Search</span>
        </RailLink>
        {/* Ask: the assistant's own page (⌘J still opens it as a side panel anywhere). */}
        <RailLink k="ask" href={askLinkFor(active)} active={active} onNavigate={onNavigate} testId="rail-ask">
          <Icon name="sparkle" size={18} className="text-accent-text" /> <span className="truncate">Ask</span>
        </RailLink>
        <button type="button" className={cx(ITEM, "w-full cursor-pointer bg-transparent text-left")} onClick={go(openNotifications)}
          aria-haspopup="dialog" aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"} data-testid="rail-inbox">
          <Icon name="bell" size={18} /> <span className="truncate">Inbox</span>
          {unread > 0 && <span className="ml-auto shrink-0 rounded-full bg-accent px-1.5 text-micro font-semibold text-on-accent">{unread > 99 ? "99+" : unread}</span>}
        </button>
      </div>

      <div className="flex flex-col gap-0.5">
        <RailLink k="files" href="/dashboard/files" active={active} onNavigate={onNavigate}>
          <Icon name="folder" size={18} /> <span className="truncate">My files</span>
        </RailLink>
        <RailLink k="shared" href="/shared" active={active} onNavigate={onNavigate}>
          <Icon name="inbox" size={18} /> <span className="truncate">Shared with me</span>
          {fresh > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-1.5 text-micro font-semibold text-accent-text">
              {fresh} new
            </span>
          )}
        </RailLink>
        <RailLink k="recent" href="/recent" active={active} onNavigate={onNavigate}>
          <Icon name="clock" size={18} /> <span className="truncate">Recent</span>
        </RailLink>
        <RailLink k="analytics" href="/dashboard/analytics" active={active} onNavigate={onNavigate}>
          <Icon name="chart" size={18} /> <span className="truncate">Analytics</span>
        </RailLink>
        {/* Trash: deleted items wait here for 30 days (components/trash). */}
        <RailLink k="trash" href="/trash" active={active} onNavigate={onNavigate}>
          <Icon name="trash" size={18} /> <span className="truncate">Trash</span>
        </RailLink>
      </div>

      <section aria-labelledby={`${uid}-ws`} className="flex flex-col gap-0.5">
        <div className="mb-1 flex items-center justify-between gap-2 px-2.5">
          <h2 id={`${uid}-ws`} className="text-eyebrow uppercase text-text-muted">Workspaces</h2>
        </div>
        {data.workspaces === undefined && (authLoading || !!user) ? (
          // Loading: rows the size of the real ones, so nothing below jumps when they arrive.
          <div aria-busy="true" className="flex flex-col">
            <span className="md-visually-hidden">Loading workspaces</span>
            {["58%", "44%"].map((w) => (
              <span key={w} aria-hidden className="flex h-[30px] items-center gap-2.5 px-2.5 max-lg:h-11">
                <Skeleton width={18} height={18} variant="rect" className="shrink-0" />
                <Skeleton width={w} height={10} />
              </span>
            ))}
          </div>
        ) : nodes.length > 0 && (
          <TreeView
            label="Workspaces"
            nodes={nodes}
            expanded={expanded}
            onToggle={onToggle}
            current={active}
            onNavigate={onNavigate}
            itemClassName={TREE_ITEM}
            activeClassName={ACTIVE}
          />
        )}
        <RailLink k="ws:new" href="/settings/workspaces" active={active} onNavigate={onNavigate} className="text-text-muted">
          <Icon name="plus" size={16} /> <span className="truncate">New workspace</span>
        </RailLink>
      </section>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
        {pwa.installPath && (
          <button type="button" className={cx(ITEM, "w-full cursor-pointer bg-transparent text-left")} onClick={go(pwa.install)} data-testid="rail-install">
            <Icon name="download" size={16} /> <span className="truncate">Install app</span>
          </button>
        )}
        <RailLink k="settings" href="/settings/account" active={active} onNavigate={onNavigate}>
          <Icon name="settings" size={16} /> <span className="truncate">Settings</span>
        </RailLink>
        <RailLink k="docs" href={DOCS_URL} active={active} onNavigate={onNavigate}>
          <Icon name="doc" size={16} /> <span className="truncate">Help &amp; docs</span>
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
function CollapsedRail({ container, pill, data, active, unread, fresh, onExpand, onFeedback, canInstall, onInstall }: {
  container: React.RefObject<HTMLElement | null>; pill: React.RefObject<HTMLSpanElement | null>; data: RailData; active: string | null;
  unread: number; fresh: number; onExpand?: () => void; onFeedback: () => void; canInstall: boolean; onInstall: () => void;
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
        <RailIcon k="search" href="/search" label="Search" icon={<Icon name="search" size={18} />} active={active} />
        <RailIcon k="ask" href={askLinkFor(active)} label="Ask" icon={<Icon name="sparkle" size={18} className="text-accent-text" />} active={active} testId="rail-ask" />
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
          <RailIcon key={w.id} k={wsRootKey(w.id)} href={`/w/${encodeURIComponent(w.id)}`} label={w.name}
            icon={<WorkspaceTile ws={w} active={activeWs === w.id} size={22} />} active={active} />
        ))}
        <RailIcon k="ws:new" href="/settings/workspaces" label="New workspace" icon={<Icon name="plus" size={18} />} active={active} />
      </div>
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-border pt-3">
        {canInstall && <RailIcon label="Install app" icon={<Icon name="download" size={18} />} active={active} onClick={onInstall} />}
        <RailIcon k="settings" href="/settings/account" label="Settings" icon={<Icon name="settings" size={18} />} active={active} />
        <RailIcon k="docs" href={DOCS_URL} label="Help & docs" icon={<Icon name="doc" size={18} />} active={active} />
        <RailIcon label="Send feedback" icon={<Icon name="message" size={18} />} active={active} onClick={onFeedback} />
      </div>
    </nav>
  );
}

export default SideNav;
