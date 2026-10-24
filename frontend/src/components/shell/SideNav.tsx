"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Anchor, Icon, cx } from "@/components/ui";
import VSCodeIcon from "@/components/VSCodeIcon";
import type { Folder, Workspace } from "@/lib/workspaces";

/** What the rail shows. Every field may be missing: the rail omits what failed to load. */
export interface RailData {
  counts?: { all?: number; documents?: number; artifacts?: number };
  workspaces?: Workspace[];
  /** Per workspace id, loaded when it is expanded. */
  folders: Record<string, Folder[] | undefined>;
  /** Per workspace id: { [folderId | "unfiled"]: n } from the library counts endpoint. */
  libraryCounts: Record<string, Record<string, number> | undefined>;
  tokens?: number;
}

/**
 * Which rail item the URL points at. Keys: "docs:all" | "docs:document" | "docs:artifact" |
 * "ws:<id>:library" | "ws:<id>:folder:<fid>" | "ws:<id>:settings" | "ws:new" | "int:vscode" | "int:apps" | "settings".
 */
export function railKeyFor(pathname: string, search: string): string | null {
  const q = new URLSearchParams(search);
  if (pathname === "/dashboard") {
    const ws = q.get("ws");
    if (ws) {
      const folder = q.get("folder");
      return folder ? `ws:${ws}:folder:${folder}` : `ws:${ws}:library`;
    }
    const kind = q.get("kind");
    if (kind === "document" || kind === "markdown") return "docs:document";
    if (kind === "artifact") return "docs:artifact";
    return "docs:all";
  }
  const m = pathname.match(/^\/settings\/workspaces\/([^/]+)/);
  if (m) return `ws:${m[1]}:settings`;
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

function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return (
    <span className="ml-auto shrink-0 rounded-full bg-surface-active px-1.5 text-micro tabular-nums text-text-secondary">
      {n}
    </span>
  );
}

const ITEM =
  "md-focus relative flex min-h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-body text-text-secondary no-underline transition-colors duration-(--duration-fast) hover:bg-surface-hover hover:text-text max-lg:min-h-11";
const ACTIVE = "font-medium text-accent-text hover:bg-transparent hover:text-accent-text";

function RailLink({ k, href, active, onNavigate, children, style }: { k: string; href: string; active: string | null; onNavigate?: () => void; children: React.ReactNode; style?: React.CSSProperties }) {
  const on = active === k;
  return (
    <Anchor href={href} data-rail-key={k} aria-current={on ? "page" : undefined} className={cx(ITEM, on && ACTIVE)} onClick={onNavigate} style={style}>
      {children}
    </Anchor>
  );
}

/** The 16px workspace tile: the logo on a logo well, or neutral initials. */
function WorkspaceTile({ ws }: { ws: Workspace }) {
  const logo = ws.branding?.logo_url;
  if (logo) {
    return (
      <span className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-xs" style={{ background: "var(--logo-well-light)" }} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" className="size-full object-contain" />
      </span>
    );
  }
  const initial = (ws.branding?.site_name || ws.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded-xs bg-surface-active text-micro leading-none font-bold text-text-secondary" aria-hidden>
      {initial}
    </span>
  );
}

/** Folders depth-first, sorted by name within each parent. */
function flattenFolders(folders: Folder[]): Array<{ folder: Folder; depth: number }> {
  const kids = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const p = f.parent_id ?? null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(f);
  }
  const ids = new Set(folders.map((f) => f.id));
  const out: Array<{ folder: Folder; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const f of (kids.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ folder: f, depth });
      if (depth < 8) walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans (parent not visible) go at the top level rather than vanishing.
  for (const f of folders) if (f.parent_id && !ids.has(f.parent_id) && !out.some((o) => o.folder.id === f.id)) out.push({ folder: f, depth: 0 });
  return out;
}

export interface SideNavProps {
  data: RailData;
  active: string | null;
  expanded: Set<string>;
  onToggle: (workspaceId: string) => void;
  onNavigate?: () => void;
  onFeedback: () => void;
  /** Extra content after the bottom links (the drawer adds theme + identity). */
  footer?: React.ReactNode;
  className?: string;
}

/**
 * The account rail (REVAMP_PLAN 4.3, Dashboard board): Your documents (All · Documents · Artifacts
 * with counts) · Workspaces (tile, name, chevron; expanded: Library, folders by depth, Settings;
 * "New workspace") · Integrations (VS Code, "N tokens"; Connected apps; Google Docs hidden per D7) · Settings ·
 * Send feedback. `nav aria-label="Account"`.
 */
export function SideNav({ data, active, expanded, onToggle, onNavigate, onFeedback, footer, className }: SideNavProps) {
  const container = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const uid = useId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const layoutKey = [
    mounted,
    data.workspaces?.length ?? -1,
    [...expanded].join(","),
    Object.entries(data.folders).map(([k, v]) => `${k}:${v?.length ?? -1}`).join(","),
    data.counts ? 1 : 0,
    data.tokens ?? -1,
  ].join("|");
  useActivePill(container, pill, active, layoutKey);

  const counts = data.counts;
  const tokens = data.tokens;

  return (
    <nav ref={container} aria-label="Account" className={cx("relative flex min-h-full flex-col gap-6 px-3 py-5", className)}>
      <span ref={pill} aria-hidden className="pointer-events-none absolute rounded-lg bg-accent-soft opacity-0" />

      <section aria-labelledby={`${uid}-docs`} className="flex flex-col gap-0.5">
        <h2 id={`${uid}-docs`} className="text-eyebrow uppercase mb-1.5 px-2.5 text-text-muted">Your documents</h2>
        <RailLink k="docs:all" href="/dashboard" active={active} onNavigate={onNavigate}>
          <Icon name="list" size={16} /> <span className="truncate">All items</span> <Count n={counts?.all} />
        </RailLink>
        <RailLink k="docs:document" href="/dashboard?kind=document" active={active} onNavigate={onNavigate}>
          <Icon name="lines" size={16} /> <span className="truncate">Documents</span> <Count n={counts?.documents} />
        </RailLink>
        <RailLink k="docs:artifact" href="/dashboard?kind=artifact" active={active} onNavigate={onNavigate}>
          <Icon name="doc" size={16} /> <span className="truncate">Artifacts</span> <Count n={counts?.artifacts} />
        </RailLink>
      </section>

      <section aria-labelledby={`${uid}-ws`} className="flex flex-col gap-0.5">
        <h2 id={`${uid}-ws`} className="text-eyebrow uppercase mb-1.5 px-2.5 text-text-muted">Workspaces</h2>
        {(data.workspaces ?? []).map((ws) => {
          const open = expanded.has(ws.id);
          const panelId = `${uid}-ws-${ws.id}`;
          const folders = data.folders[ws.id];
          const lc = data.libraryCounts[ws.id];
          const libraryTotal = lc ? Object.values(lc).reduce((a, b) => a + b, 0) : undefined;
          return (
            <div key={ws.id} className="flex flex-col gap-0.5">
              <button
                type="button"
                className={cx(ITEM, "w-full cursor-pointer bg-transparent text-left text-text")}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => onToggle(ws.id)}
              >
                <WorkspaceTile ws={ws} />
                <span className="min-w-0 flex-1 truncate" dir="auto">{ws.name}</span>
                <Icon name="chevronDown" size={14} className={cx("shrink-0 text-text-muted transition-transform duration-(--duration-fast) motion-reduce:transition-none", !open && "-rotate-90")} />
              </button>
              <div id={panelId} hidden={!open} className="ml-[1.0625rem] flex flex-col gap-0.5 border-l border-border pl-2">
                <RailLink k={`ws:${ws.id}:library`} href={`/dashboard?ws=${encodeURIComponent(ws.id)}`} active={active} onNavigate={onNavigate}>
                  <Icon name="inbox" size={16} /> <span className="truncate">Library</span> <Count n={libraryTotal} />
                </RailLink>
                {folders &&
                  flattenFolders(folders).map(({ folder, depth }) => (
                    <RailLink
                      key={folder.id}
                      k={`ws:${ws.id}:folder:${folder.id}`}
                      href={`/dashboard?ws=${encodeURIComponent(ws.id)}&folder=${encodeURIComponent(folder.id)}`}
                      active={active}
                      onNavigate={onNavigate}
                      style={depth ? { paddingLeft: `calc(0.625rem + ${depth * 14}px)` } : undefined}
                    >
                      <Icon name="folder" size={16} /> <span className="truncate" dir="auto">{folder.name}</span> <Count n={lc?.[folder.id]} />
                    </RailLink>
                  ))}
                <RailLink k={`ws:${ws.id}:settings`} href={`/settings/workspaces/${encodeURIComponent(ws.id)}`} active={active} onNavigate={onNavigate}>
                  <Icon name="settings" size={16} /> <span className="truncate">Settings</span>
                </RailLink>
              </div>
            </div>
          );
        })}
        <RailLink k="ws:new" href="/settings/workspaces" active={active} onNavigate={onNavigate}>
          <Icon name="plus" size={16} /> <span className="truncate">New workspace</span>
        </RailLink>
      </section>

      <section aria-labelledby={`${uid}-int`} className="flex flex-col gap-0.5">
        <h2 id={`${uid}-int`} className="text-eyebrow uppercase mb-1.5 px-2.5 text-text-muted">Integrations</h2>
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
      </section>

      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
        <RailLink k="settings" href="/settings/account" active={active} onNavigate={onNavigate}>
          <Icon name="settings" size={16} /> <span className="truncate">Settings</span>
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
