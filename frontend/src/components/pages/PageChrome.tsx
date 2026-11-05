"use client";

/**
 * A page's chrome, the same for editors and readers (so nothing moves when the editor takes over):
 *
 *   PageFrame    the page on its paper surface: the sticky top bar, the head (cover, icon, title),
 *                the 720 px column (or full width) and what goes under the body;
 *   PageTopBar   the page's one bar (no app header above it), 48 px, sticky and translucent: the
 *                rail toggle (⌘\), the logo (Markdrop's, or the workspace's on its domain), the
 *                breadcrumbs (workspace › folders › ancestors › this page, the middle folded into
 *                "…"; "… / Title" on phones), then who's viewing, Saved / Saving…, Share, ⋯, and
 *                search, Create and the avatar menu (or Sign in); a hairline once the page has
 *                scrolled; a calm banner under it when someone else is editing. A classic
 *                document's framed view has the same bar (app/[slug]/doc/DocumentTopBar), and
 *                so does a file's (app/[slug]/artifact/ArtifactTopBar);
 *   PageRailHead the rail's top row (the logo, level with the bar) while the rail is open;
 *   PageMenu     the ⋯ menu: a dropdown, a bottom sheet with drag-to-dismiss on phones (PageSheet);
 *   SubPages     "Pages inside" (with "Add a sub-page"), Backlinks ("N backlinks").
 *
 * The page tree in the rail is PageTree.tsx (loaded lazily: it carries drag and drop). Every list
 * comes from the API already filtered to what this reader can open.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { Anchor, Button, CopyButton, Dropdown, Icon, IconButton, Skeleton, SkipLink, Spinner, cx, type MenuEntry } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import { useAuth } from "@/contexts/AuthContext";
import { LIGHT_ENABLED } from "@/lib/theme";
import { useWorkspaceTree } from "@/lib/workspaceStore";
import { listBacklinks, type ChildPage, type Crumb } from "@/lib/pages";
import { fetchChildren } from "@/lib/navStore";
import { pagePath } from "@/lib/pageBlocks.mjs";
import type { SaveState } from "./usePageEditSession";
import { AssistantButton } from "@/components/assistant/AssistantButton";
import { PageAccount, PageBrand } from "./PageBarEnds";
import { RAIL_SCRIPT, RAIL_WIDE, closeRailDrawer, setRailPeek, toggleRail, useRail, useRailControls } from "./railState";
import "./pages.css";

export interface PageAddressing {
  /** A workspace's own domain: pages live under their folders and ancestors. */
  tenant: boolean;
  folderPath: string[];
  /** The page's workspace: its name and folders lead the breadcrumbs for members (markdrop.in). */
  workspaceId?: string | null;
}

/** A breadcrumb before the pages: the workspace, then its folders. */
interface PlaceCrumb {
  key: string;
  title: string;
  href: string;
  icon: "users" | "folder";
}

/**
 * The workspace and folders above a page, for someone who can see the workspace's tree (members,
 * on markdrop.in). Everyone else gets the pages alone; on a workspace's own domain its logo is
 * the way home.
 */
function usePlaceCrumbs(a: PageAddressing): PlaceCrumb[] {
  const { user } = useAuth();
  const id = !a.tenant && user && a.workspaceId ? a.workspaceId : null;
  const { tree } = useWorkspaceTree(id);
  if (!id || !tree) return [];
  const out: PlaceCrumb[] = [{ key: `ws:${id}`, title: tree.workspace.name, href: `/w/${encodeURIComponent(id)}`, icon: "users" }];
  for (let i = 1; i <= a.folderPath.length; i++) {
    const path = a.folderPath.slice(0, i).join("/");
    const f = tree.folders.find((x) => x.path === path);
    if (!f) break;
    out.push({ key: `f:${f.id}`, title: f.name, href: `/w/${encodeURIComponent(id)}/f/${encodeURIComponent(f.id)}`, icon: "folder" });
  }
  return out;
}

const hrefFor = (slug: string, ancestors: string[], a: PageAddressing) => pagePath(slug, { tenant: a.tenant, folderPath: a.folderPath, ancestors });
const isImageIcon = (icon: string | null | undefined) => !!icon && /^(asset:|https?:|blob:|data:image\/)/.test(icon);
/** A /children row's icon (the API sends it; the type doesn't say so yet). */
const iconOf = (k: ChildPage) => (k as ChildPage & { icon?: string | null }).icon ?? null;

/** An icon for a crumb: the page's emoji, its image, or a quiet page glyph. */
function CrumbIcon({ icon, resolve }: { icon?: string | null; resolve?: (src: string) => string }) {
  if (icon && !isImageIcon(icon)) return <span className="pb-crumb__emoji" aria-hidden>{icon}</span>;
  const src = icon && resolve ? resolve(icon) : "";
  // eslint-disable-next-line @next/next/no-img-element
  if (src) return <img className="pb-crumb__img" src={src} alt="" aria-hidden />;
  return <Icon name="lines" size={16} className="pb-crumb__glyph" aria-hidden />;
}

/** Is the window scrolled past `px`? (false on the server and the first render) */
export function useScrolled(px = 2): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setPast(window.scrollY > px));
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on);
    };
  }, [px]);
  return past;
}

export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** A touch screen (phones and tablets, no mouse or trackpad): the editor's bottom toolbar rides the keyboard. */
export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";
export function useTouch(): boolean {
  return useMediaQuery(TOUCH_QUERY);
}

/**
 * Breadcrumbs: the workspace and folders (members), every readable ancestor, then this page. More
 * than three before this page fold the middle into "…" (a menu); on phones it's "… / this page".
 */
export function PageBreadcrumbs({
  crumbs,
  title,
  icon,
  resolve,
  addressing,
  place = [],
  tile,
  className,
}: {
  crumbs: Crumb[];
  title: string | null;
  /** This page's icon. */
  icon?: string | null;
  /** In place of the icon: a node (a file's type icon). */
  tile?: ReactNode;
  resolve?: (src: string) => string;
  addressing: PageAddressing;
  /** The workspace and folders before the pages. */
  place?: PlaceCrumb[];
  className?: string;
}) {
  const steps = [
    ...place.map((p) => ({ key: p.key, title: p.title, href: p.href, tile: <Icon name={p.icon} size={15} className="pb-crumb__glyph" aria-hidden /> })),
    ...crumbs.map((c, i) => ({
      key: c.slug,
      title: c.title || "Untitled",
      href: hrefFor(c.slug, crumbs.slice(0, i).map((x) => x.slug), addressing),
      tile: <CrumbIcon icon={c.icon} resolve={resolve} />,
    })),
  ];
  const n = steps.length;
  const link = (i: number, cls?: string) => {
    const st = steps[i]!;
    return (
      <li key={st.key} className={cx("pb-crumb", cls)}>
        <Anchor href={st.href} className="pb-crumb__link md-focus">
          {st.tile}
          <span className="pb-crumb__text ph-sensitive ph-mask" dir="auto">{st.title}</span>
        </Anchor>
        <span className="pb-crumb__sep" aria-hidden>/</span>
      </li>
    );
  };
  const folded = (from: number, to: number, cls: string) => (
    <li key={`fold-${cls}`} className={cx("pb-crumb", cls)}>
      <Dropdown
        aria-label="More pages above this one"
        align="left"
        minWidth={220}
        trigger={<button type="button" className="pb-crumb__link pb-crumb__more md-focus" aria-label="Show the pages above">…</button>}
        items={steps.slice(from, to).map((st) => ({
          label: <span className="ph-sensitive ph-mask" dir="auto">{st.title}</span>,
          tile: st.tile,
          href: st.href,
        }))}
        menuClassName="ph-no-capture"
      />
      <span className="pb-crumb__sep" aria-hidden>/</span>
    </li>
  );
  const items: ReactNode[] = [];
  if (n) {
    // Wide: the first, "…" for the middle, the last; phones: "…" for all of them.
    if (n <= 3) for (let i = 0; i < n; i++) items.push(link(i, "pb-crumb--wide"));
    else items.push(link(0, "pb-crumb--wide"), folded(1, n - 1, "pb-crumb--wide"), link(n - 1, "pb-crumb--wide"));
    items.push(folded(0, n, "pb-crumb--narrow"));
  }
  return (
    <nav aria-label="Breadcrumb" className={cx("pb-crumbs-nav no-print", className)}>
      <ol className="pb-crumbs">
        {items}
        <li className="pb-crumb pb-crumb--current">
          <span aria-current="page" className="pb-crumb__link">
            {tile ?? <CrumbIcon icon={icon} resolve={resolve} />}
            <span className="pb-crumb__text ph-sensitive ph-mask" dir="auto">{title || "Untitled"}</span>
          </span>
        </li>
      </ol>
    </nav>
  );
}

/** "Saved" / "Saving…" / "Offline, retrying" / "Not saved", cross-faded in one fixed-size slot. */
export function SaveIndicator({ save, online, opening }: { save: SaveState; online: boolean; opening?: boolean }) {
  const state = !online ? "offline" : save.state === "error" ? "error" : save.state === "saved" ? (opening ? "opening" : "saved") : "saving";
  const label: Record<string, ReactNode> = {
    saved: "Saved",
    saving: <><Spinner size={10} /> Saving…</>,
    opening: "Saved",
    offline: <><Icon name="wifiOff" size={12} aria-hidden /> Offline, retrying</>,
    error: "Not saved",
  };
  const shown = state === "opening" ? "saved" : state;
  // Saved and Saving… share one slot and cross-fade (they alternate all the time); the rare
  // Offline / Not saved fade in in their place.
  const rare = shown === "offline" || shown === "error";
  return (
    <span className="pb-save" data-state={shown}>
      {rare ? (
        <span key={shown} className="pb-save__l pb-save__l--solo" data-on="">
          {label[shown]}
        </span>
      ) : (
        (["saved", "saving"] as const).map((k) => (
          <span key={k} className="pb-save__l" data-on={k === shown ? "" : undefined} aria-hidden={k !== shown}>
            {label[k]}
          </span>
        ))
      )}
      <span className="md-visually-hidden" role="status">{shown === "saved" ? "" : shown === "saving" ? "Saving" : shown === "offline" ? "Offline, retrying" : "Not saved"}</span>
    </span>
  );
}

/** The calm notice under the bar: someone else is editing, the page is locked, … */
export function PageBanner({ icon = "edit", children, actions, tone = "calm" }: { icon?: string; children: ReactNode; actions?: ReactNode; tone?: "calm" | "warn" }) {
  return (
    <div className="pb-banner" data-tone={tone} role="status">
      <div className="pb-banner__in">
        <Icon name={icon} size={14} className="pb-banner__icon" aria-hidden />
        <span className="pb-banner__text">{children}</span>
        {actions && <span className="pb-banner__actions">{actions}</span>}
      </div>
    </div>
  );
}

/* ── The ⋯ menu: a dropdown, or a bottom sheet on phones ─────────────────────────────── */

const isHeader = (e: MenuEntry): e is Extract<MenuEntry, { header: ReactNode }> => "header" in e;
const isCustom = (e: MenuEntry): e is Extract<MenuEntry, { custom: ReactNode }> => "custom" in e;

/**
 * A bottom sheet (phones): slides up, a grab handle, drag down to dismiss (or tap the scrim, or
 * Escape). Only transform and opacity move; reduced motion makes it instant.
 */
export function PageSheet({ open, onClose, title, children, labelledBy }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; labelledBy?: string }) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      if (returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
    }, reduced ? 0 : 160);
    return () => window.clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const first = panel.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]), button, a[href], input');
    (first ?? panel.current)?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", key);
    };
  }, [open, mounted, onClose]);

  // Drag to dismiss: the panel follows the finger (transform only); far or fast enough closes it.
  const drag = useRef<{ y: number; t: number; dy: number; id: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    const el = panel.current;
    if (!el || (e.pointerType === "mouse" && e.button !== 0)) return;
    // From the handle or the head anywhere; from the list only when it's scrolled to the top.
    const list = el.querySelector(".pb-sheet__body");
    if (list && list.contains(e.target as Node) && list.scrollTop > 0) return;
    drag.current = { y: e.clientY, t: performance.now(), dy: 0, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = panel.current;
    if (!d || !el || e.pointerId !== d.id) return;
    d.dy = Math.max(0, e.clientY - d.y);
    if (d.dy > 4) {
      if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
      el.style.transition = "none";
      el.style.transform = `translate3d(0, ${d.dy}px, 0)`;
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = panel.current;
    drag.current = null;
    if (!d || !el) return;
    const v = d.dy / Math.max(1, performance.now() - d.t);
    el.style.transition = "";
    if (d.dy > 96 || (d.dy > 24 && v > 0.6)) {
      el.style.transform = `translate3d(0, 100%, 0)`;
      onClose();
    } else {
      el.style.transform = "";
    }
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    <div className={cx("pb-sheet-layer", closing && "pb-sheet-layer--closing")}>
      <div className="pb-sheet__scrim" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        className="pb-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
        tabIndex={-1}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="pb-sheet__handle" aria-hidden />
        {title && <h2 id={titleId} className="pb-sheet__title">{title}</h2>}
        <div className="pb-sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Menu entries as a sheet's list (44 px rows). */
export function SheetMenu({ items, onDone, label }: { items: MenuEntry[]; onDone: () => void; label?: string }) {
  return (
    <div role="menu" aria-label={label} className="pb-sheetmenu">
      {items.map((it, i) => {
        const sep = it.separated && i > 0 ? <div className="pb-sheetmenu__sep" role="separator" /> : null;
        if (isHeader(it)) return <div key={i}>{sep}<div className="pb-sheetmenu__header">{it.header}</div></div>;
        if (isCustom(it)) return <div key={i}>{sep}<div className="pb-sheetmenu__custom">{it.custom}</div></div>;
        const body = (
          <>
            <span className="pb-sheetmenu__icon">{it.tile ?? (it.icon ? <Icon name={it.icon} size={18} /> : null)}</span>
            <span className="pb-sheetmenu__text">
              <span className="pb-sheetmenu__label">{it.label}</span>
              {it.description && <span className="pb-sheetmenu__desc">{it.description}</span>}
            </span>
            {it.busy && <Spinner size={14} />}
          </>
        );
        const cls = cx("pb-sheetmenu__item md-focus", it.danger && "pb-sheetmenu__item--danger");
        const pick = (e: React.MouseEvent) => {
          if (it.disabled) {
            e.preventDefault();
            return;
          }
          onDone();
          it.onClick?.();
        };
        return (
          <div key={i}>
            {sep}
            {it.href ? (
              <a role="menuitem" href={it.href} target={it.external ? "_blank" : undefined} rel={it.external ? "noopener noreferrer" : undefined} className={cls} aria-disabled={it.disabled || undefined} onClick={pick}>
                {body}
              </a>
            ) : (
              <button role="menuitem" type="button" className={cls} aria-disabled={it.disabled || undefined} onClick={pick}>
                {body}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The page's ⋯ menu. */
export function PageMenu({ items, label = "Page options" }: { items: MenuEntry[]; label?: string }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!items.length) return null;
  if (phone) {
    return (
      <>
        <IconButton icon="more" label={label} size="sm" variant="ghost" className="pb-bar__btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
        <PageSheet open={open} onClose={close} title={label}>
          <SheetMenu items={items} onDone={close} label={label} />
        </PageSheet>
      </>
    );
  }
  return <Dropdown aria-label={label} align="right" minWidth={280} portal trigger={<IconButton icon="more" label={label} size="sm" variant="ghost" className="pb-bar__btn" />} items={items} menuClassName="pb-menu" />;
}

/**
 * The rail's top row while it is open (≥ 1280 px): the logo, level with the bar beside it (the
 * bar shows the logo itself while the rail is collapsed or a drawer).
 */
export function PageRailHead() {
  return (
    <div className="pb-railhead no-print">
      <PageBrand wordmark />
    </div>
  );
}

/** The left edge that peeks a collapsed rail, and the scrim behind the rail's drawer (< 1280 px). */
function RailLayers() {
  const rail = useRail();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // A link in the drawer (or the peek) took the reader elsewhere: put it away.
  useEffect(() => {
    closeRailDrawer();
    setRailPeek(false);
  }, [pathname]);
  // The peek stays while the pointer is over the rail; it goes a moment after it leaves.
  useEffect(() => {
    if (!rail.peek) return;
    const el = document.querySelector<HTMLElement>(".pb-rail");
    if (!el) return;
    let t = 0;
    const leave = () => {
      t = window.setTimeout(() => setRailPeek(false), 180);
    };
    const enter = () => window.clearTimeout(t);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerenter", enter);
    return () => {
      window.clearTimeout(t);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerenter", enter);
    };
  }, [rail.peek]);
  if (!mounted) return null;
  return createPortal(
    <>
      <div className="pb-railedge" aria-hidden onPointerOver={(e) => e.pointerType === "mouse" && setRailPeek(true)} onMouseOver={() => setRailPeek(true)} />
      {rail.drawer && <div className="pb-railscrim" aria-hidden onClick={closeRailDrawer} />}
    </>,
    document.body,
  );
}

/** The sticky top bar: the page's only bar (the app header is folded into it). */
export function PageTopBar({
  crumbs,
  title,
  icon,
  resolve,
  addressing,
  presence,
  status,
  onShare,
  shareUrl,
  onCopied,
  menu,
  menuLabel,
  tools,
  badge,
  tile,
  rail: hasRail = true,
  hideAccount,
  className,
  banner,
  ask,
}: {
  crumbs: Crumb[];
  title: string | null;
  icon?: string | null;
  resolve?: (src: string) => string;
  addressing: PageAddressing;
  presence?: ReactNode;
  /** Saved / Saving… (editors). */
  status?: ReactNode;
  /** Share (owners and resharers); everyone else gets Copy link. */
  onShare?: (() => void) | null;
  shareUrl?: string;
  onCopied?: () => void;
  menu: MenuEntry[];
  /** The ⋯ button's name ("Page options"). */
  menuLabel?: string;
  /** More of the bar's own buttons, before Share (a classic document: Contents, Edit, full screen). */
  tools?: ReactNode;
  /** Beside the title: a classic document's E2E or lock badge, a file's type. */
  badge?: ReactNode;
  /** The title's icon as a node, in place of `icon` (a file's type icon). */
  tile?: ReactNode;
  /** There is a rail (a sidebar) for the bar's toggle to show and hide. */
  rail?: boolean;
  /** No account slot (a gate is showing its own sign-in). */
  hideAccount?: boolean;
  className?: string;
  /** A notice under the bar (someone else is editing). */
  banner?: ReactNode;
  /** ✦ Ask: Ask Markdrop about this (components/assistant), for someone signed in. */
  ask?: boolean;
}) {
  const scrolled = useScrolled();
  const phone = usePhone();
  const { user } = useAuth();
  const rail = useRail();
  const place = usePlaceCrumbs(addressing);
  const pathname = usePathname();
  useRailControls();
  const wide = useMediaQuery(RAIL_WIDE);
  // What the app header had that has no room in the bar: Create on phones, and the theme for
  // someone signed out (signed in, it's in the avatar menu).
  const extra: MenuEntry[] = [
    ...(phone && !addressing.tenant
      ? [
          { label: "New page", icon: "layers", href: "/pages/new", separated: true },
          { label: "New document", icon: "lines", href: "/new" },
        ]
      : []),
    ...(!user && LIGHT_ENABLED && !addressing.tenant
      ? [{
          custom: (
            <div className="flex items-center justify-between gap-3">
              <span className="text-body text-text-secondary" aria-hidden>Theme</span>
              <ThemeSegmented size="sm" iconOnly label="Theme" />
            </div>
          ),
          separated: true,
        }]
      : []),
  ];
  const railOpen = rail.drawer || (wide && !rail.collapsed);
  // Phones: Share leads the ⋯ menu (the bar keeps its room for the title).
  const items = [...(phone && onShare ? [{ label: "Share", icon: "share", onClick: onShare }] : []), ...menu, ...extra];
  return (
    <header className={cx("pb-barwrap no-print", className)} data-scrolled={scrolled ? "" : undefined}>
      <SkipLink />
      {/* A collapsed rail stays collapsed from the first paint (railState). */}
      <script dangerouslySetInnerHTML={{ __html: RAIL_SCRIPT }} />
      <div className="pb-bar" aria-label="Page">
        {hasRail && (
          <IconButton
            icon="sidebar"
            label={railOpen ? "Hide the sidebar" : "Show the sidebar"}
            size="sm"
            variant="ghost"
            className="pb-bar__btn pb-bar__rail"
            aria-keyshortcuts="Meta+Backslash Control+Backslash"
            aria-expanded={railOpen}
            onClick={toggleRail}
          />
        )}
        <PageBrand className="pb-bar__brandslot" />
        <PageBreadcrumbs crumbs={crumbs} title={title} icon={icon} tile={tile} resolve={resolve} addressing={addressing} place={place} className="pb-bar__crumbs" />
        {badge && <span className="pb-bar__badge">{badge}</span>}
        <div className="pb-bar__actions">
          {presence && <span className="pb-bar__presence">{presence}</span>}
          {status}
          {ask && <AssistantButton className="pb-bar__btn pb-bar__ask" />}
          {tools}
          {onShare ? (
            <Button variant="ghost" size="sm" className="pb-bar__btn pb-bar__share" onClick={onShare}>Share</Button>
          ) : shareUrl ? (
            <CopyButton text={shareUrl} label="Copy link" size="sm" variant="ghost" iconOnly className="pb-bar__btn pb-bar__copy" onCopy={onCopied} />
          ) : null}
          <PageMenu items={items} label={menuLabel} />
          {!hideAccount && (
            <>
              <span className="pb-bar__div" aria-hidden />
              <PageAccount returnPath={addressing.tenant ? pathname || undefined : undefined} />
            </>
          )}
        </div>
      </div>
      {banner}
      <RailLayers />
    </header>
  );
}

/**
 * The page on its paper: the bar, the head, the column (720 px, or the full width less 96 px a
 * side) and what goes under the body. Readers and editors get the same frame.
 */
export function PageFrame({
  bar,
  head,
  children,
  footer,
  layout,
  full,
  innerRef,
  frameRef,
  ...rest
}: {
  bar: ReactNode;
  head: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** pb-small, pb-font-serif, … */
  layout?: string;
  full?: boolean;
  innerRef?: React.Ref<HTMLDivElement>;
  frameRef?: React.Ref<HTMLDivElement>;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div {...rest} ref={frameRef} className={cx("pb-frame", layout, rest.className)} data-full={full ? "" : undefined}>
      {bar}
      {head}
      <div ref={innerRef} className="pb-col pb-body">
        {children}
      </div>
      {footer && <div className="pb-col pb-foot">{footer}</div>}
    </div>
  );
}

function ago(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = Math.round((Date.now() - t) / 86400000);
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  return d < 31 ? `${d} days ago` : new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** "Pages inside": the sub-pages this reader can open, and "+ Add a sub-page" for editors. */
export function SubPages({
  slug,
  count,
  ancestors,
  addressing,
  onAdd,
  refreshKey,
}: {
  slug: string;
  /** From the page read: 0 shows nothing unless the reader can add one. */
  count: number;
  ancestors: string[];
  addressing: PageAddressing;
  onAdd?: (() => void) | null;
  refreshKey?: number;
}) {
  const [kids, setKids] = useState<ChildPage[] | null>(null);
  const [error, setError] = useState(false);
  const headId = useId();
  useEffect(() => {
    if (!count) {
      setKids([]);
      return;
    }
    let live = true;
    setError(false);
    // The shared cache (lib/navStore): the page tree asks for the same list as this mounts.
    fetchChildren(slug, refreshKey ? 0 : 5_000)
      .then((k) => live && setKids(k))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [slug, count, refreshKey]);

  if (!count && !onAdd) return null;
  return (
    <section className="pb-children no-print" aria-labelledby={headId}>
      <div className="pb-children__head">
        <h2 id={headId} className="pb-children__h">
          Pages inside
        </h2>
        {onAdd && (
          <Button size="sm" variant="ghost" iconLeft="plus" onClick={onAdd}>
            Add a sub-page
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-caption text-text-muted">Couldn&apos;t load the pages inside.</p>
      ) : kids === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton width="60%" />
          <Skeleton width="45%" />
        </div>
      ) : kids.length === 0 ? (
        onAdd ? <p className="pb-children__empty">No pages inside yet. A sub-page lives with this page and follows who can read it.</p> : null
      ) : (
        <ul className="pb-children__list ph-no-capture">
          {kids.map((k) => (
            <li key={k.slug}>
              <Anchor href={hrefFor(k.slug, [...ancestors, slug], addressing)} className="pb-children__item md-focus">
                {iconOf(k) && !isImageIcon(iconOf(k)) ? <span className="pb-children__emoji" aria-hidden>{iconOf(k)}</span> : <Icon name={k.has_children ? "layers" : "lines"} size={16} aria-hidden />}
                <span className="pb-children__title ph-sensitive ph-mask" dir="auto">{k.title || "Untitled"}</span>
                {k.access_inherit === false && (
                  <span className="pb-children__meta" title="Who can read it is set on this page">
                    <Icon name="lock" size={12} aria-hidden /> Own access
                  </span>
                )}
                {k.updated_at && <span className="pb-children__meta">{ago(k.updated_at)}</span>}
              </Anchor>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "N backlinks": the pages that mention or embed this one, that this reader can open. */
export function Backlinks({ slug, addressing }: { slug: string; addressing: PageAddressing }) {
  const [links, setLinks] = useState<Array<{ slug: string; title: string | null; icon?: string | null }> | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    listBacklinks(slug)
      .then((l) => live && setLinks(l))
      .catch(() => live && setLinks([]));
    return () => {
      live = false;
    };
  }, [slug]);
  if (!links?.length) return null;
  return (
    <div className="pb-backlinks no-print">
      <button type="button" className="pb-backlinks__btn md-focus" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="arrowUpRight" size={14} aria-hidden /> {links.length === 1 ? "1 backlink" : `${links.length} backlinks`}
      </button>
      {open && (
        <ul className="pb-backlinks__list ph-no-capture">
          {links.map((l) => (
            <li key={l.slug}>
              <Anchor href={hrefFor(l.slug, [], addressing)} className="md-focus ph-sensitive ph-mask" dir="auto">
                {l.icon && !isImageIcon(l.icon) ? `${l.icon} ` : ""}
                {l.title || "Untitled"}
              </Anchor>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
