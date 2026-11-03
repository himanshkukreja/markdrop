"use client";

/**
 * Version history of a page: a full-screen panel (the page's ⋯ menu → "Version history").
 *
 *  - Left: the versions, newest first, grouped by day: time, who (a person's avatar, an AI app via
 *    MCP, "Earlier version"), "Restored from …", the current one marked. ↑/↓ move through them.
 *  - Right: the version rendered as the page, with "Show changes" against the page as it is now
 *    (green: only in this version; red, struck through: only in the page now).
 *  - "Restore this version" (with a confirmation) makes it the page again, as a new version: the
 *    page as it was stays in the history, so a restore can be undone. 423 while someone else has
 *    the page open in the editor.
 *  - Phones: the list, then a version on its own screen (back returns to the list).
 *
 * Editors only (the API refuses everyone else). Encrypted documents have no history: it says so.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Alert, Avatar, Button, ConfirmDialog, Icon, IconButton, Skeleton, Switch, useToast, cx } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { PagesApiError, type Crumb } from "@/lib/pages";
import { pageRefs } from "@/lib/pageRefs.mjs";
import { PageRenderer } from "../PageRenderer";
import { usePageEmbeds } from "../usePageEmbeds";
import { diffBlocks, diffStats, type DiffSegment } from "./diff.mjs";
import { getVersion, listVersions, restoreVersion, type VersionDetail, type VersionSummary } from "./api";
import "./history.css";

/** Sent on `window` after a restore, so the page's editor loads the restored text even without the live socket. */
export const RESTORED_EVENT = "markdrop:page-restored";

export interface PageHistoryProps {
  open: boolean;
  slug: string;
  /** The page's title now (the panel's heading). */
  title: string | null;
  onClose: () => void;
  /** After a restore (the editor reloads on its own; the reading view may re-read). */
  onRestored?: () => void;
  signInHref?: string | null;
  crumbs?: Crumb[];
  href?: (slug: string, ancestors: string[]) => string;
  viewer?: string | null;
}

/* ── time ─────────────────────────────────────────────────────────────── */

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function dayLabel(d: Date, now = new Date()): string {
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return "Today";
  if (dayKey(d) === dayKey(y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function whenLabel(ts: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const day = dayLabel(d);
  return `${day === "Today" || day === "Yesterday" ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) })}, ${timeLabel(d)}`;
}

/* ── who ──────────────────────────────────────────────────────────────── */

function Who({ v }: { v: VersionSummary }) {
  const a = v.author;
  if (a.kind === "mcp") return <span className="ph-glyph ph-glyph--ai" aria-hidden><Icon name="sparkle" size={14} /></span>;
  if (a.kind === "system") return <span className="ph-glyph" aria-hidden><Icon name="clock" size={14} /></span>;
  return (
    <span className="ph-who">
      <Avatar name={a.name || a.label || "Someone"} src={a.picture ?? undefined} size="sm" />
      {a.kind === "restore" && <span className="ph-who__badge" aria-hidden><Icon name="rotate" size={10} /></span>}
    </span>
  );
}

function authorLine(v: VersionSummary, byN: Map<number, VersionSummary>): string {
  if (v.author.kind === "restore") {
    const from = v.restored_from != null ? byN.get(v.restored_from) : undefined;
    const what = from?.ts ? whenLabel(from.ts) : v.restored_from != null ? `version ${v.restored_from}` : "an earlier version";
    return `${v.author.name || "Someone"} restored ${what}`;
  }
  return v.author.label;
}

/* ── the panel ────────────────────────────────────────────────────────── */

export function PageHistory(props: PageHistoryProps) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (props.open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, reduce ? 0 : 140);
    return () => window.clearTimeout(t);
  }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(<Panel {...props} closing={closing} />, document.body);
}

function Panel({ slug, title, onClose, onRestored, signInHref, crumbs, href, viewer, closing }: PageHistoryProps & { closing: boolean }) {
  const toast = useToast();
  const phone = useMediaQuery(PHONE_QUERY);
  const headingId = useId();
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<"encrypted" | "file" | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, VersionDetail>>({});
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [phoneView, setPhoneView] = useState<"list" | "detail">("list");
  const [confirming, setConfirming] = useState(false);

  // ── load the list ──
  const loadList = useCallback(async (from: number | null) => {
    try {
      const res = await listVersions(slug, from);
      if (!res.available) {
        setUnavailable(res.reason ?? "encrypted");
        setVersions([]);
        return;
      }
      setVersions((prev) => (from && prev ? [...prev, ...res.versions] : res.versions));
      setCursor(res.next_cursor);
      if (!from) {
        // Start on the newest version that isn't the page as it is now (there's nothing to compare
        // in that one); on phones the list comes first.
        const first = res.versions.find((v) => !v.current) ?? res.versions[0];
        setSelected((s) => s ?? first?.n ?? null);
      }
      setListError(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Couldn't load the history.");
      if (!from) setVersions([]);
    }
  }, [slug]);
  useEffect(() => {
    void loadList(null);
  }, [loadList]);

  // ── load the selected version (briefly debounced, so holding ↓ doesn't fetch every row) ──
  useEffect(() => {
    if (selected == null || details[selected]) return;
    setDetailError(null);
    const n = selected;
    const t = window.setTimeout(() => {
      getVersion(slug, n)
        .then((d) => setDetails((m) => ({ ...m, [n]: d })))
        .catch((e) => setDetailError(e instanceof Error ? e.message : "Couldn't load that version."));
    }, 90);
    return () => window.clearTimeout(t);
  }, [selected, slug, details]);

  // The preview starts at the top for every version.
  useEffect(() => {
    previewRef.current?.scrollTo({ top: 0 });
  }, [selected]);

  // ── focus, Escape, scroll lock ──
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = document.body;
    const saved = body.style.overflow;
    body.style.overflow = "hidden";
    const t = window.setTimeout(() => (listRef.current ?? root.current)?.focus({ preventScroll: true }), 30);
    return () => {
      window.clearTimeout(t);
      body.style.overflow = saved;
      if (prev?.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);
  const confirmingRef = useRef(false);
  confirmingRef.current = confirming;
  const phoneViewRef = useRef(phoneView);
  phoneViewRef.current = phoneView;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirmingRef.current || e.defaultPrevented) return;
      e.preventDefault();
      if (phone && phoneViewRef.current === "detail") setPhoneView("list");
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, phone]);
  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !root.current) return;
    const f = Array.from(root.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ── keyboard: ↑/↓ through the list ──
  const list = useMemo(() => versions ?? [], [versions]);
  const byN = useMemo(() => new Map(list.map((v) => [v.n, v])), [list]);
  const index = list.findIndex((v) => v.n === selected);
  const move = (delta: number) => {
    if (!list.length) return;
    const next = Math.max(0, Math.min(list.length - 1, (index < 0 ? 0 : index) + delta));
    setSelected(list[next]!.n);
    if (next >= list.length - 3 && cursor && !loadingMore) void more();
  };
  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); move(-list.length); }
    else if (e.key === "End") { e.preventDefault(); move(list.length); }
    else if (e.key === "Enter" && phone && selected != null) { e.preventDefault(); setPhoneView("detail"); }
  };
  // Keep the selected row in view.
  useEffect(() => {
    if (selected == null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-n="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    await loadList(cursor);
    setLoadingMore(false);
  };

  // ── grouping by day ──
  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; items: VersionSummary[] }> = [];
    for (const v of list) {
      const d = v.ts ? new Date(v.ts) : new Date(0);
      const key = dayKey(d);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(v);
      else out.push({ key, label: v.ts ? dayLabel(d) : "Earlier", items: [v] });
    }
    return out;
  }, [list]);

  const sel = selected != null ? byN.get(selected) ?? null : null;
  const detail = selected != null ? details[selected] ?? null : null;

  // ── restore ──
  const restore = async () => {
    if (selected == null) return;
    try {
      await restoreVersion(slug, selected);
    } catch (e) {
      if (e instanceof PagesApiError && e.status === 423) {
        const holder = (e.info.holder as { name?: string } | undefined)?.name;
        throw new Error(e.info.code === "page_locked"
          ? "This page is locked. Its owner or a workspace admin can restore it."
          : `${holder || "Someone"} is editing this page. You can restore it when they're done.`);
      }
      throw e;
    }
    window.dispatchEvent(new CustomEvent(RESTORED_EVENT, { detail: { slug } }));
    setConfirming(false);
    toast.success("Version restored. The page as it was is kept in the history.");
    onRestored?.();
    onClose();
  };

  const canRestore = !!sel && !sel.current && !!detail;
  const restoreButton = (
    <Button variant="primary" size="sm" iconLeft="rotate" disabled={!canRestore} onClick={() => setConfirming(true)}>
      Restore this version
    </Button>
  );

  return (
    <div
      ref={root}
      className={cx("ph-layer", closing && "ph-layer--closing", phone && `ph-layer--phone ph-layer--${phoneView}`)}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={trap}
    >
      <header className="ph-head">
        {phone && phoneView === "detail" ? (
          <IconButton icon="arrowLeft" label="Back to versions" size="sm" variant="ghost" onClick={() => setPhoneView("list")} />
        ) : (
          <IconButton icon="x" label="Close version history" size="sm" variant="ghost" onClick={onClose} />
        )}
        <div className="ph-head__title">
          <h2 id={headingId}>{phone && phoneView === "detail" && sel ? whenLabel(sel.ts) : "Version history"}</h2>
          {!(phone && phoneView === "detail") && <span className="ph-head__page">{title?.trim() || "Untitled"}</span>}
        </div>
        {!phone && !unavailable && (
          <div className="ph-head__actions">
            <Switch label="Show changes" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} />
            {restoreButton}
          </div>
        )}
      </header>

      {unavailable ? (
        <div className="ph-empty">
          <span className="ph-empty__icon" aria-hidden><Icon name={unavailable === "encrypted" ? "lock" : "history"} size={22} /></span>
          <h3>{unavailable === "encrypted" ? "No version history for encrypted documents" : "Files keep their own versions"}</h3>
          <p>{unavailable === "encrypted"
            ? "This document is end-to-end encrypted: Markdrop can't read it, so it can't keep earlier versions of it."
            : "Open the file's Details to see and restore its versions."}</p>
        </div>
      ) : (
        <div className="ph-body">
          {/* ── the list ── */}
          <nav className="ph-list" aria-label="Versions">
            <div
              ref={listRef}
              className="ph-list__scroll md-focus"
              role="listbox"
              tabIndex={0}
              aria-label="Versions, newest first"
              aria-activedescendant={selected != null ? `ph-v-${selected}` : undefined}
              onKeyDown={onListKey}
            >
              {versions === null && (
                <div className="ph-list__loading" aria-busy="true">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="ph-row ph-row--skeleton"><Skeleton variant="circle" width={24} height={24} /><div style={{ flex: 1 }}><Skeleton width="40%" /><Skeleton width="70%" /></div></div>
                  ))}
                </div>
              )}
              {listError && <Alert tone="danger" className="ph-list__error">{listError}</Alert>}
              {versions !== null && !list.length && !listError && (
                <div className="ph-list__empty">
                  <Icon name="history" size={20} />
                  <p><strong>No versions yet.</strong> They're saved as the page is edited: one every 10 minutes while someone edits, and before and after every AI edit.</p>
                </div>
              )}
              {groups.map((g) => (
                <div key={g.key} role="group" aria-label={g.label} className="ph-group">
                  <div className="ph-group__label" aria-hidden>{g.label}</div>
                  {g.items.map((v) => (
                    <div
                      key={v.n}
                      id={`ph-v-${v.n}`}
                      data-n={v.n}
                      role="option"
                      aria-selected={v.n === selected}
                      className={cx("ph-row", v.n === selected && "ph-row--on")}
                      onClick={() => {
                        setSelected(v.n);
                        if (phone) setPhoneView("detail");
                        listRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      <Who v={v} />
                      <span className="ph-row__text">
                        <span className="ph-row__time">
                          {v.ts ? timeLabel(new Date(v.ts)) : "Earlier"}
                          {v.current && <span className="ph-chip">Current</span>}
                        </span>
                        <span className="ph-row__who">{authorLine(v, byN)}</span>
                      </span>
                      {phone && <Icon name="chevronRight" size={16} className="ph-row__go" />}
                    </div>
                  ))}
                </div>
              ))}
              {cursor && (
                <div className="ph-list__more">
                  <Button variant="ghost" size="sm" loading={loadingMore} onClick={() => void more()}>Older versions</Button>
                </div>
              )}
            </div>
            {!phone && list.length > 1 && (
              <p className="ph-list__hint" aria-hidden>
                <kbd>↑</kbd><kbd>↓</kbd> to move between versions
              </p>
            )}
          </nav>

          {/* ── the version ── */}
          <section className="ph-preview" aria-label="The selected version" ref={previewRef} tabIndex={-1}>
            {phone && sel && (
              <div className="ph-preview__phonebar">
                <Switch label="Show changes" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} />
              </div>
            )}
            {sel && (
              <Preview
                key={sel.n}
                slug={slug}
                version={sel}
                detail={detail}
                error={detailError}
                showChanges={showChanges}
                byN={byN}
                signInHref={signInHref}
                crumbs={crumbs}
                href={href}
                viewer={viewer ?? null}
              />
            )}
            {!sel && versions !== null && list.length > 0 && <div className="ph-preview__none">Choose a version.</div>}
          </section>
        </div>
      )}

      {phone && phoneView === "detail" && !unavailable && <div className="ph-phonefoot">{restoreButton}</div>}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={restore}
        tone="default"
        title="Restore this version?"
        confirmLabel="Restore"
        body={
          <p>
            The page goes back to how it was {sel?.ts ? <strong>{whenLabel(sel.ts)}</strong> : "then"}. The page as it is now
            is kept in the history, so you can undo this by restoring it.
          </p>
        }
      />
    </div>
  );
}

/* ── one version, rendered ────────────────────────────────────────────── */

function Preview({ slug, version, detail, error, showChanges, byN, signInHref, crumbs, href, viewer }: {
  slug: string;
  version: VersionSummary;
  detail: VersionDetail | null;
  error: string | null;
  showChanges: boolean;
  byN: Map<number, VersionSummary>;
  signInHref?: string | null;
  crumbs?: Crumb[];
  href?: (slug: string, ancestors: string[]) => string;
  viewer: string | null;
}) {
  const markdown = detail?.markdown ?? "";
  const current = detail?.current_doc.markdown ?? "";
  const segments: DiffSegment[] = useMemo(() => (detail ? diffBlocks(current, markdown) : []), [detail, current, markdown]);
  const stats = useMemo(() => diffStats(segments), [segments]);
  // One embed lookup for the whole preview (every run of blocks shares it).
  const refSlugs = useMemo(() => {
    const s = new Set<string>([...pageRefs(markdown).slugs, ...(showChanges ? pageRefs(current).slugs : [])]);
    return Array.from(s).sort();
  }, [markdown, current, showChanges]);
  const embeds = usePageEmbeds(slug, refSlugs, !!detail, viewer);
  const titleChanged = !!detail && (detail.title ?? "") !== (detail.current_doc.title ?? "");
  const same = !!detail && stats.added === 0 && stats.removed === 0;
  const renderer = (content: string, key?: string | number) => (
    <PageRenderer key={key} slug={slug} content={content} assets={detail?.assets ?? null} embeds={embeds} signInHref={signInHref} crumbs={crumbs} title={detail?.title ?? null} href={href} viewer={viewer} />
  );
  const icon = version.icon && !/^(asset:|https?:)/.test(version.icon) ? version.icon : null;

  return (
    <div className="ph-paper">
      <div className="ph-meta">
        <span className="ph-meta__when">{whenLabel(version.ts)}</span>
        <span className="ph-meta__dot" aria-hidden>·</span>
        <span>{authorLine(version, byN)}</span>
        {detail && showChanges && !version.current && (
          same && !titleChanged ? (
            <span className="ph-meta__stats">Same as the page now</span>
          ) : (
            <span className="ph-meta__stats">
              {stats.added > 0 && <span className="ph-stat ph-stat--add">{stats.added} only here</span>}
              {stats.removed > 0 && <span className="ph-stat ph-stat--del">{stats.removed} not in this version</span>}
            </span>
          )
        )}
      </div>
      {error && !detail && <Alert tone="danger">{error}</Alert>}
      {!detail && !error && (
        <div className="ph-loading" aria-busy="true">
          <Skeleton width="55%" height={32} />
          <Skeleton width="92%" /><Skeleton width="86%" /><Skeleton width="70%" />
          <Skeleton width="90%" /><Skeleton width="60%" />
        </div>
      )}
      {detail && (
        <div className="ph-doc ph-fade">
          <h1 className="ph-doc__title">
            {icon && <span className="ph-doc__icon" aria-hidden>{icon}</span>}
            <span className={cx(showChanges && titleChanged && "ph-ins")}>{detail.title?.trim() || "Untitled"}</span>
            {showChanges && titleChanged && <span className="ph-doc__was ph-del-inline">{detail.current_doc.title?.trim() || "Untitled"}</span>}
          </h1>
          {!showChanges || version.current ? (
            markdown.trim() ? renderer(markdown) : <p className="ph-doc__blank">This version is empty.</p>
          ) : segments.length ? (
            segments.map((s, i) => (
              <div key={i} className={cx("ph-seg", `ph-seg--${s.kind}`)}>
                {s.kind !== "same" && <span className="ph-seg__tag">{s.kind === "add" ? "Only in this version" : "Not in this version"}</span>}
                {renderer(s.blocks.join("\n\n"))}
              </div>
            ))
          ) : (
            <p className="ph-doc__blank">This version is empty.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default PageHistory;
