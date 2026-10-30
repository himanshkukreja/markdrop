"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Anchor, Icon, cx } from "@/components/ui";
import VSCodeIcon from "@/components/VSCodeIcon";
import { DOCS_URL } from "./links";
import { TreeView, type TreeNode } from "@/components/workspace/FolderTree";
import { useUploads } from "@/components/workspace/uploads/UploadProvider";
import { can, type TreeFolder, type Workspace } from "@/lib/workspaces";
import { childrenMap, descendants, useWorkspaceTrees, type TreeSlot } from "@/lib/workspaceStore";

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
export const wsDocsKey = (id: string) => `ws:${id}:docs`;

/**
 * Which rail item the URL points at. Keys: "files" | "shared" | "recent" | "analytics" | "ws:<id>:root" |
 * "ws:<id>:folder:<fid>" | "ws:<id>:settings" | "ws:<id>:docs" | "ws:new" | "int:vscode" | "int:apps" | "settings".
 */
export function railKeyFor(pathname: string, search: string): string | null {
  const q = new URLSearchParams(search);
  const docs = pathname.match(/^\/w\/([^/]+)\/docs(?:\/|$)/);
  if (docs) return wsDocsKey(decodeURIComponent(docs[1]!));
  const w = pathname.match(/^\/w\/([^/]+)(?:\/f\/([^/]+))?\/?$/);
  if (w) {
    const id = decodeURIComponent(w[1]!);
    return w[2] ? wsFolderKey(id, decodeURIComponent(w[2])) : wsRootKey(id);
  }
  if (pathname === "/dashboard") {
    const ws = q.get("ws");
    if (ws) {
      const folder = q.get("folder");
      return folder && folder !== "unfiled" ? wsFolderKey(ws, folder) : wsRootKey(ws);
    }
    return "files";
  }
  if (pathname === "/shared" || pathname.startsWith("/requests")) return "shared";
  if (pathname === "/recent") return "recent";
  if (pathname === "/dashboard/analytics" || pathname.startsWith("/dashboard/analytics/") || pathname === "/dashboard/live") return "analytics";
  const m = pathname.match(/^\/settings\/workspaces\/([^/]+)/);
  if (m) return wsSettingsKey(decodeURIComponent(m[1]!));
  if (pathname === "/settings/workspaces") return "ws:new";
  if (pathname.startsWith("/settings/tokens")) return "int:vscode";
  if (pathname.startsWith("/settings/connections")) return "int:apps";
  if (pathname === "/settings" || pathname.startsWith("/settings/account")) return "settings";
  return null;
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
  "md-focus relative flex min-h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-body text-text-secondary no-underline transition-colors duration-(--duration-fast) hover:bg-surface-hover hover:text-text max-lg:min-h-11";
const ACTIVE = "font-semibold text-accent-text hover:bg-transparent hover:text-accent-text";

function RailLink({ k, href, active, onNavigate, children, style, className }: { k: string; href: string; active: string | null; onNavigate?: () => void; children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  const on = active === k;
  return (
    <Anchor href={href} data-rail-key={k} aria-current={on ? "page" : undefined} className={cx(ITEM, on && ACTIVE, className)} onClick={onNavigate} style={style}>
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
      <span className="grid shrink-0 place-items-center overflow-hidden" style={{ ...box, background: "var(--logo-well-light)" }} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" className="size-full object-contain" />
      </span>
    );
  }
  const initial = (ws.branding?.site_name || ws.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      className={cx("grid shrink-0 place-items-center font-bold leading-none", active ? "bg-accent text-on-accent" : "bg-surface-active text-text")}
      style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.6)) }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

/** The workspace's tree as rail nodes: the workspace (its root folder view), then its folders by
 *  depth with total counts. Drop targets for rows and folders (dnd-kit) and for files (uploads). */
function workspaceNode(
  ws: Workspace,
  slot: TreeSlot,
  active: boolean,
  onFiles: ((wsId: string, folderId: string | null, label: string, files: File[]) => void) | null,
): TreeNode {
  const tree = slot || null;
  const admin = can(tree?.workspace.role ?? ws.role, "admin");
  const member = can(tree?.workspace.role ?? ws.role, "member");
  const filesTo = (folderId: string | null, label: string) =>
    member && onFiles ? (files: File[]) => onFiles(ws.id, folderId, label, files) : undefined;
  let children: TreeNode[] | undefined;
  let total: number | undefined;
  if (tree) {
    const kids = childrenMap(tree.folders);
    const build = (f: TreeFolder): TreeNode => {
      const sub = kids.get(f.id) ?? [];
      return {
        key: wsFolderKey(ws.id, f.id),
        label: f.name,
        icon: <Icon name="folder" size={16} />,
        count: f.total_count,
        href: `/w/${encodeURIComponent(ws.id)}/f/${encodeURIComponent(f.id)}`,
        children: sub.length ? sub.map(build) : undefined,
        marker: f.share ? (
          <span className="inline-flex shrink-0 text-text-muted" title={f.share.level === "link" ? "Shared by link" : "Shared with the team"}>
            <Icon name="link" size={12} />
            <span className="md-visually-hidden">, shared</span>
          </span>
        ) : undefined,
        drop: member ? { workspaceId: ws.id, folderId: f.id, label: f.name, acceptsFolders: admin } : null,
        drag: admin
          ? { type: "folder", workspaceId: ws.id, folderId: f.id, label: f.name, parentId: f.parent_id, blocked: [...descendants(tree.folders, f.id)] }
          : null,
        onFiles: filesTo(f.id, f.name),
      };
    };
    // Docs sites: the workspace's documentation websites, after its folders (Main board, Docs).
    children = [
      ...(kids.get(null) ?? []).map(build),
      { key: wsDocsKey(ws.id), label: "Docs sites", icon: <Icon name="layers" size={16} />, href: `/w/${encodeURIComponent(ws.id)}/docs`, leaf: true },
    ];
    total = tree.unfiled_count + (kids.get(null) ?? []).reduce((n, f) => n + f.total_count, 0);
  }
  return {
    key: wsRootKey(ws.id),
    label: ws.name,
    icon: <WorkspaceTile ws={ws} active={active} />,
    count: total,
    href: `/w/${encodeURIComponent(ws.id)}`,
    children,
    // Not loaded yet: expandable, with a spinner when opened. Loaded and empty: a leaf. Failed: a leaf
    // too (the folder view explains the error).
    lazy: slot === null,
    className: "font-semibold text-text",
    drop: member ? { workspaceId: ws.id, folderId: null, label: `the top of ${ws.name}`, acceptsFolders: admin } : null,
    onFiles: filesTo(null, ws.name),
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
}

/**
 * The drive rail (simpler UI, Main board): My files · Shared with me ("N new") · Recent, then
 * WORKSPACES (each workspace's tile, its folder tree with counts, "New workspace"), then the quieter
 * account links at the bottom. `nav aria-label="Your drive"`. Files dropped on a folder upload there.
 */
export function SideNav({ data, active, expanded, onToggle, onNavigate, onFeedback, footer, className }: SideNavProps) {
  const container = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const uid = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const uploads = useUploads();
  const activeWs = workspaceOfKey(active);

  const openWs = useMemo(
    () => (data.workspaces ?? []).filter((w) => expanded.has(wsRootKey(w.id))).map((w) => w.id),
    [data.workspaces, expanded],
  );
  const trees = useWorkspaceTrees(openWs);
  const onFiles = useMemo(
    () => (uploads
      ? (wsId: string, folderId: string | null, label: string, files: File[]) => uploads.upload(files, uploads.resolve(wsId, folderId, label))
      : null),
    [uploads],
  );
  const nodes = useMemo(
    () => (data.workspaces ?? []).map((ws) => workspaceNode(ws, trees[ws.id] ?? null, ws.id === activeWs, onFiles)),
    [data.workspaces, trees, activeWs, onFiles],
  );

  const layoutKey = [
    mounted,
    data.workspaces?.length ?? -1,
    [...expanded].join(","),
    Object.entries(trees).map(([k, v]) => `${k}:${v ? v.folders.length : String(v)}`).join(","),
    data.sharedNew ?? -1,
    data.tokens ?? -1,
  ].join("|");
  useActivePill(container, pill, active, layoutKey);

  const tokens = data.tokens;
  const fresh = data.sharedNew ?? 0;

  return (
    <nav ref={container} aria-label="Your drive" className={cx("relative flex min-h-full flex-col gap-5 px-3 py-4", className)}>
      <span ref={pill} aria-hidden className="pointer-events-none absolute rounded-lg bg-accent-soft opacity-0" />

      <div className="flex flex-col gap-0.5">
        <RailLink k="files" href="/dashboard" active={active} onNavigate={onNavigate}>
          <Icon name="home" size={18} /> <span className="truncate">My files</span>
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
      </div>

      <section aria-labelledby={`${uid}-ws`} className="flex flex-col gap-0.5">
        <h2 id={`${uid}-ws`} className="text-eyebrow uppercase mb-1.5 px-2.5 text-text-muted">Workspaces</h2>
        {nodes.length > 0 && (
          <TreeView
            label="Workspaces"
            nodes={nodes}
            expanded={expanded}
            onToggle={onToggle}
            current={active}
            onNavigate={onNavigate}
            itemClassName={cx(ITEM, "gap-1.5 pr-2")}
            activeClassName={ACTIVE}
          />
        )}
        <RailLink k="ws:new" href="/settings/workspaces" active={active} onNavigate={onNavigate} className="text-text-muted">
          <Icon name="plus" size={16} /> <span className="truncate">New workspace</span>
        </RailLink>
      </section>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
        <RailLink k="int:vscode" href="/settings/tokens" active={active} onNavigate={onNavigate}>
          <span className="inline-flex text-cat-sync"><VSCodeIcon size={16} className="size-4" /></span>
          <span className="truncate">VS Code</span>
          {tokens !== undefined && (
            <span className="ml-auto shrink-0 text-caption text-text-muted">{tokens === 1 ? "1 token" : `${tokens} tokens`}</span>
          )}
        </RailLink>
        <RailLink k="int:apps" href="/settings/connections" active={active} onNavigate={onNavigate}>
          <Icon name="sparkle" size={16} /> <span className="truncate">Connected apps</span>
        </RailLink>
        <RailLink k="settings" href="/settings/account" active={active} onNavigate={onNavigate}>
          <Icon name="settings" size={16} /> <span className="truncate">Settings</span>
        </RailLink>
        <RailLink k="docs" href={DOCS_URL} active={active} onNavigate={onNavigate}>
          <Icon name="doc" size={16} /> <span className="truncate">Docs</span>
        </RailLink>
        <button type="button" className={cx(ITEM, "w-full cursor-pointer bg-transparent text-left")} onClick={onFeedback}>
          <Icon name="message" size={16} /> <span className="truncate">Send feedback</span>
        </button>
        {footer}
      </div>
    </nav>
  );
}

export default SideNav;
