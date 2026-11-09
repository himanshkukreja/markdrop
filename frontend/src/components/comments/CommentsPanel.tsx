"use client";

/**
 * The comments panel: Open / Resolved / Mine, sorted by position on the page or by recent activity, a
 * "Comment on the page" box (the page's Discussion), and the threads.
 *
 * Layout: on wide screens (≥ 1400 px) each thread sits beside its highlight in the right margin, pushed
 * down so cards never overlap (Google Docs); from 768 px it's a scrolling list in a right-hand panel; on
 * phones a bottom sheet.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Dropdown, Icon, IconButton, SegmentedControl, type MenuEntry } from "@/components/ui";
import type { AnchorIn, Thread } from "@/lib/comments";
import { Composer } from "./Composer";
import { subscribePositions, type ThreadPositions } from "./CommentLayer";
import { useComments, type CommentsCtx } from "./context";
import { slots } from "./slots";
import { ThreadCard } from "./ThreadCard";
import "./comments.css";

const WIDE = "(min-width: 1400px)";
const PHONE = "(max-width: 767px)";
const GAP = 10;

function useMedia(q: string): boolean {
  return useSyncExternalStore(
    (fn) => { const m = window.matchMedia(q); m.addEventListener("change", fn); return () => m.removeEventListener("change", fn); },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

function usePositions(): ThreadPositions {
  const [p, setP] = useState<ThreadPositions>(new Map());
  useEffect(() => subscribePositions(setP), []);
  return p;
}

function draftLabel(a: AnchorIn): string {
  if (a.type === "text") return a.quote.exact;
  if (a.type === "block") return a.block_text || "This block";
  return "";
}

function visibleThreads(c: CommentsCtx): Thread[] {
  const uid = c.user?.id;
  return c.threads.filter((t) => {
    if (c.filter === "resolved") return t.status === "resolved";
    if (t.status !== "open") return false;
    if (c.filter === "mine") {
      return !!uid && (t.created_by.id === uid || t.assignee?.id === uid || t.messages.some((m) => m.author.id === uid || m.mentions.some((x) => x.id === uid)));
    }
    return true;
  });
}

export function CommentsPanel() {
  const c = useComments();
  const wide = useMedia(WIDE);
  const phone = useMedia(PHONE);
  const positions = usePositions();
  const [sort, setSort] = useState<"position" | "recent">("position");
  const [pageDraft, setPageDraft] = useState(false);
  const panelActions = useMemo(() => slots().panelActions, []);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef<Map<string, number>>(new Map());
  const [layoutTick, setLayoutTick] = useState(0);

  // Keyboard: Escape closes the panel (when focus is in it).
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !(e.target as Element).closest("textarea")) c?.closePanel();
  }, [c]);

  // Body class: the page makes room for the panel on desktop.
  useEffect(() => {
    if (!c?.panelOpen || phone) return;
    document.documentElement.classList.add("md-comments-open");
    return () => document.documentElement.classList.remove("md-comments-open");
  }, [c?.panelOpen, phone]);

  const list = c ? visibleThreads(c) : [];
  const placed = list.filter((t) => positions.has(t.id));
  const floating = list.filter((t) => !positions.has(t.id));
  const aligned = wide && !phone && sort === "position" && c?.filter !== "resolved" && placed.length > 0;

  const ordered = useMemo(() => {
    if (sort === "recent") return [...list].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return [...floating, ...[...placed].sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.map((t) => t.id + t.updated_at).join(), sort, positions]);

  // Aligned tops: each card at its highlight's height, pushed down past the one above.
  const [tops, setTops] = useState<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    if (!aligned || !bodyRef.current) return;
    const base = bodyRef.current.getBoundingClientRect().top;
    const next = new Map<string, number>();
    let y = 0;
    for (const t of floating) {
      next.set(t.id, y);
      y += (heights.current.get(t.id) ?? 120) + GAP;
    }
    const sortedPlaced = [...placed].sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
    // The active card wins its spot; cards above it move up when there's room.
    for (const t of sortedPlaced) {
      const want = (positions.get(t.id) ?? 0) - base;
      const top = Math.max(want, y);
      next.set(t.id, top);
      y = top + (heights.current.get(t.id) ?? 120) + GAP;
    }
    const act = c?.activeId;
    if (act && next.has(act) && positions.has(act)) {
      const want = (positions.get(act) ?? 0) - base;
      const shift = (next.get(act) ?? 0) - want;
      if (shift > 0) {
        // Pull the active card (and the ones above it) up by the overlap.
        const idx = sortedPlaced.findIndex((t) => t.id === act);
        for (let i = 0; i <= idx; i++) next.set(sortedPlaced[i]!.id, (next.get(sortedPlaced[i]!.id) ?? 0) - shift);
      }
    }
    setTops(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aligned, positions, layoutTick, c?.activeId, list.length]);

  const measure = useCallback((id: string) => (el: HTMLElement | null) => {
    if (!el) return;
    const h = el.offsetHeight;
    if (heights.current.get(id) !== h) {
      heights.current.set(id, h);
      setLayoutTick((n) => n + 1);
    }
  }, []);

  // The active card scrolls into view in list mode.
  useEffect(() => {
    if (!c?.activeId || aligned) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-thread-id="${c.activeId}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [c?.activeId, aligned]);

  if (!c || !c.panelOpen) return null;

  const menu: MenuEntry[] = [
    ...panelActions.filter((a) => a.when(c)).map((a) => ({ label: a.label, icon: a.icon, onClick: () => a.run(c) })),
    ...(c.perms.settings ? [{ label: "Comment settings…", icon: "settings", separated: panelActions.length > 0, onClick: () => window.dispatchEvent(new CustomEvent("md:comments-settings")) }] : []),
  ];
  const empty = !list.length && !c.draftAnchor && !pageDraft;

  return (
    <aside
      className={`mdc-panel${phone ? " mdc-panel--sheet" : ""}${aligned ? " mdc-panel--aligned" : ""}`}
      aria-label="Comments"
      data-comments-skip
      onKeyDown={onKeyDown}
    >
      {phone && <div className="mdc-sheet__grip" aria-hidden />}
      <div className="mdc-panel__head">
        <h2 className="mdc-panel__title"><Icon name="message" /> Comments <span className="mdc-count">{c.counts.open}</span></h2>
        <div className="mdc-panel__headtools">
          {menu.length > 0 && <Dropdown portal trigger={<IconButton icon="more" label="More" size="sm" />} items={menu} />}
          <IconButton icon="x" label="Close comments" size="sm" onClick={c.closePanel} />
        </div>
      </div>
      <div className="mdc-panel__filters">
        <SegmentedControl
          size="sm"
          value={c.filter}
          onChange={(v) => c.setFilter(v as typeof c.filter)}
          options={[
            { value: "open", label: `Open${c.counts.open ? ` ${c.counts.open}` : ""}` },
            { value: "resolved", label: "Resolved" },
            ...(c.user ? [{ value: "mine", label: "Mine" }] : []),
          ]}
          aria-label="Show"
        />
        <button type="button" className="mdc-sort" onClick={() => setSort(sort === "position" ? "recent" : "position")}
          aria-label={`Sorted by ${sort === "position" ? "position on the page" : "recent activity"}`}>
          <Icon name="sort" /> {sort === "position" ? "Position" : "Recent"}
        </button>
      </div>
      {c.perms.comment && !c.draftAnchor && (
        pageDraft ? (
          <div className="mdc-draft">
            <p className="mdc-draft__label"><Icon name="doc" /> On the page</p>
            <Composer ctx={c} threadId={null} autoFocus placeholder="Comment on the whole page…"
              onCancel={() => setPageDraft(false)}
              onSubmit={async (d) => { await c.create({ type: "page" }, d.body, d.mentions, { attachments: d.attachments.map((x) => x.id), suggestion: d.suggestion ?? null }); setPageDraft(false); }} />
          </div>
        ) : (
          <button type="button" className="mdc-pagebtn" onClick={() => setPageDraft(true)}>
            <Icon name="messagePlus" /> Comment on the page
          </button>
        )
      )}
      {!c.user && c.enabled && (
        <p className="mdc-signin"><a href={c.signInHref}>Sign in</a> to comment.</p>
      )}
      {c.draftAnchor && (
        <div className="mdc-draft mdc-thread is-active">
          {c.draftAnchor.type !== "page" && <blockquote className="mdc-anchor">{draftLabel(c.draftAnchor)}</blockquote>}
          <Composer ctx={c} threadId={null} autoFocus
            onCancel={c.cancelDraft}
            onSubmit={async (d) => { await c.create(c.draftAnchor!, d.body, d.mentions, { attachments: d.attachments.map((x) => x.id), suggestion: d.suggestion ?? null }); }} />
        </div>
      )}
      <div className="mdc-panel__body" ref={bodyRef} style={aligned ? { position: "relative" } : undefined}>
        {c.error && <p className="mdc-error">{c.error}</p>}
        {empty && (
          <div className="mdc-empty">
            <Icon name="message" />
            <p>{c.filter === "resolved" ? "No resolved comments." : c.filter === "mine" ? "Nothing of yours here." : c.perms.comment ? "No comments yet. Select text to comment on it." : "No comments yet."}</p>
          </div>
        )}
        {ordered.map((t) => (
          <ThreadCard
            key={t.id}
            ctx={c}
            thread={t}
            active={c.activeId === t.id}
            onMeasure={aligned ? measure(t.id) : undefined}
            style={aligned ? { position: "absolute", left: 12, right: 12, transform: `translateY(${tops.get(t.id) ?? 0}px)` } : undefined}
          />
        ))}
      </div>
    </aside>
  );
}
