"use client";

/**
 * "✦ From meetings": meeting memory while writing a page (.work/meeting-memory/SPEC.md).
 *
 * Mounted by PageEditor next to the editor (it only reads the TipTap editor and inserts into it):
 *
 *  - Follows the caret: the page's title, the heading of the section under the caret and the
 *    selection ask POST /meeting-memory/related (debounced, cached per section) for the decisions,
 *    action items, open questions and discussions recorded in the workspace's meetings.
 *  - The pill (bottom right, above Ask) opens a side panel (a bottom sheet on phones): each item with
 *    its date, meeting, series, "Jump to moment" and Insert (a dated, cited line after the caret's
 *    block). A search box looks for anything else.
 *  - Hints, never edits: a related decision the section leaves out (the server's clear matches) or,
 *    when AI is on, contradicts (Haiku, POST /meeting-memory/check, a few per visit) shows as a small
 *    card: Include / Dismiss.
 *  - "/meetings" in the "/" menu opens the panel with its search, inserting where the slash was.
 *  - Each person's switches (on by default): the pill and panel by themselves, and the hints.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Icon, IconButton, Spinner, Switch, useToast } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { services } from "@/components/docs-editor/menus/mediaUpload";
import { KIND_LABEL, checkSection, fmtDay, relatedFacts, setMemoryPrefs, type FactKind, type MemoryFact, type MemoryHint, type MemoryPrefs, type RelatedResult } from "@/lib/meetingMemory";
import { sectionAround, sectionKey, shouldCheck, textHash, type BlockLine } from "./memoryCore.mjs";
import "./memory.css";

export interface MeetingMemoryProps {
  slug: string;
  workspaceId: string | null;
  title: string;
  editor: Editor | null;
  readOnly: boolean;
  /** Page AI is usable here (the AI check runs only then). */
  ai: boolean;
}

interface Ctx {
  heading: string | null;
  selection: string;
  section: string;
  words: number;
  key: string;
}

const CHECK_BUDGET = 10;
const CHECK_IDLE_MS = 4000;
const SIDE_EVENT = "md:sidepanel";
const FILTERS: Array<[FactKind | "all", string]> = [["all", "All"], ["decision", "Decisions"], ["action_item", "Action items"], ["open_question", "Questions"], ["topic", "Discussed"]];

function blocksOf(editor: Editor): { blocks: BlockLine[]; index: number } {
  const blocks: BlockLine[] = [];
  editor.state.doc.forEach((n) => {
    blocks.push({ level: n.type.name === "heading" ? Number(n.attrs.level) || 1 : null, text: n.textContent });
  });
  return { blocks, index: editor.state.selection.$from.index(0) };
}

function readCtx(editor: Editor, title: string): Ctx {
  const { blocks, index } = blocksOf(editor);
  const s = sectionAround(blocks, index);
  const sel = editor.state.selection;
  const selection = sel.empty ? "" : editor.state.doc.textBetween(sel.from, sel.to, " ").slice(0, 600);
  const words = s.text.split(/\s+/).filter((w) => /\w/.test(w)).length;
  return { heading: s.heading, selection, section: s.text.slice(0, 4000), words, key: sectionKey({ title, heading: s.heading, selection }) };
}

const dismissedKey = (slug: string) => `md_mm_dismissed:${slug}`;
function readDismissed(slug: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(dismissedKey(slug)) || "[]"));
  } catch {
    return new Set();
  }
}
function writeDismissed(slug: string, ids: Set<string>) {
  try {
    localStorage.setItem(dismissedKey(slug), JSON.stringify([...ids].slice(-200)));
  } catch { /* storage blocked: dismissed for this visit */ }
}

/** Puts `markdown` in the page as its own block(s) after the caret's top-level block (or in place of
 * an empty line), the caret after it. */
async function insertAfterCaret(editor: Editor, markdown: string): Promise<boolean> {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { parseBlocks } = await import("@/components/docs-editor/core/markdown.mjs");
  const parsed = parseBlocks(`${markdown}\n`);
  if (!parsed.length) return false;
  const nodes = parsed.map((b: unknown) => editor.schema.nodeFromJSON(b as never));
  const { state } = editor;
  const index = state.selection.$from.index(0);
  let from = state.doc.content.size;
  let to = from;
  let empty = false;
  state.doc.forEach((n, offset, i) => {
    if (i !== index) return;
    empty = n.type.name === "paragraph" && n.content.size === 0;
    from = empty ? offset : offset + n.nodeSize;
    to = empty ? offset + n.nodeSize : from;
  });
  const tr = state.tr.replaceWith(from, to, nodes);
  const end = from + nodes.reduce((a, n) => a + n.nodeSize, 0);
  editor.view.dispatch(tr);
  try {
    editor.chain().focus().setTextSelection(Math.max(1, end - 1)).run();
  } catch { /* a non-text block last: the caret stays */ }
  return true;
}

export function MeetingMemory({ slug, workspaceId, title, editor, readOnly, ai }: MeetingMemoryProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const toast = useToast();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<FactKind | "all">("all");
  const [data, setData] = useState<RelatedResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [prefs, setPrefs] = useState<MemoryPrefs | null>(null);
  const [aiHint, setAiHint] = useState<MemoryHint | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [justInserted, setJustInserted] = useState<string | null>(null);
  const cache = useRef(new Map<string, RelatedResult>());
  const checked = useRef(new Set<string>());
  const budget = useRef(CHECK_BUDGET);
  const search = useRef<HTMLInputElement>(null);
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => setDismissed(readDismissed(slug)), [slug]);
  // A new page: nothing carried over.
  useEffect(() => {
    cache.current.clear();
    checked.current.clear();
    budget.current = CHECK_BUDGET;
    setData(null);
    setAiHint(null);
    setQ("");
  }, [slug]);

  // ── Where the caret is ───────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return;
    let t = 0;
    let lastSel = -1;
    const run = () => {
      if (editor.isDestroyed) return;
      setCtx((prev) => {
        const next = readCtx(editor, titleRef.current);
        return prev && prev.key === next.key && prev.section === next.section ? prev : next;
      });
    };
    const onSel = () => {
      const at = editor.state.selection.$from.index(0);
      const sel = editor.state.selection.empty ? 0 : 1;
      const k = at * 2 + sel;
      if (k === lastSel) return;
      lastSel = k;
      window.clearTimeout(t);
      t = window.setTimeout(run, 500);
    };
    const onUpdate = () => {
      window.clearTimeout(t);
      t = window.setTimeout(run, 1200);
    };
    run();
    editor.on("selectionUpdate", onSel);
    editor.on("update", onUpdate);
    return () => {
      window.clearTimeout(t);
      editor.off("selectionUpdate", onSel);
      editor.off("update", onUpdate);
    };
  }, [editor]);
  // A renamed page asks again.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const t = window.setTimeout(() => setCtx(readCtx(editor, title)), 800);
    return () => window.clearTimeout(t);
  }, [title, editor]);

  // ── What the meetings say about it ──────────────────────────────────────
  const query = q.trim();
  const reqKey = query ? `q\u0001${query.toLowerCase()}\u0001${kind}` : ctx ? `${ctx.key}\u0001${textHash(ctx.section)}\u0001${kind}` : null;
  useEffect(() => {
    if (!workspaceId || !reqKey || (!ctx && !query)) return;
    const hit = cache.current.get(reqKey);
    if (hit) {
      setData(hit);
      return;
    }
    const c = new AbortController();
    const t = window.setTimeout(() => {
      setLoading(true);
      const kinds = kind === "all" ? undefined : [kind];
      const body = query
        ? { page: slug, q: query, kinds, limit: 20 }
        : { page: slug, title: titleRef.current, heading: ctx?.heading ?? undefined, selection: ctx?.selection || undefined, section: ctx?.section || undefined, kinds };
      relatedFacts(body, c.signal)
        .then((r) => {
          if (cache.current.size > 60) cache.current.clear();
          cache.current.set(reqKey, r);
          setData(r);
          setPrefs((p) => p ?? r.prefs);
          setFailed(false);
        })
        .catch(() => {
          if (!c.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    }, query ? 250 : 0);
    return () => {
      window.clearTimeout(t);
      c.abort();
    };
  }, [reqKey, workspaceId, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  const facts = useMemo(() => data?.facts ?? [], [data]);
  const hintsOn = prefs?.hints !== false;
  const panelOn = prefs?.panel !== false;

  // ── The AI check: a section that contradicts (or leaves out) a related decision ──
  useEffect(() => {
    setAiHint(null);
    if (!ai || !hintsOn || readOnly || query || !ctx || !data) return;
    const decisions = facts.filter((f) => f.kind === "decision").slice(0, 3);
    const key = `${ctx.key}\u0001${textHash(ctx.section)}`;
    if (!shouldCheck({ words: ctx.words, decisions: decisions.length, key, checked: checked.current, budget: budget.current })) return;
    const c = new AbortController();
    const t = window.setTimeout(() => {
      checked.current.add(key);
      budget.current -= 1;
      checkSection({ page: slug, heading: ctx.heading, section: ctx.section, facts: decisions.map((f) => f.id) }, c.signal)
        .then((r) => {
          const top = decisions[0]?.id;
          const pick = r.results.find((x) => x.verdict === "contradicts") ?? r.results.find((x) => x.verdict === "omits" && x.id === top);
          const f = pick && decisions.find((d) => d.id === pick.id);
          if (!pick || !f) return;
          setAiHint({
            kind: pick.verdict === "contradicts" ? "contradicts" : "omits",
            fact: f.id,
            clear: true,
            message: `On ${fmtDay(f.meeting.date)} the team decided: ${f.text}`,
            question: pick.verdict === "contradicts" ? (pick.note ? `${pick.note} Update this section?` : "This section seems to say otherwise. Update it?") : "Include it here?",
          });
        })
        .catch(() => {});
    }, CHECK_IDLE_MS);
    return () => {
      window.clearTimeout(t);
      c.abort();
    };
  }, [data, ctx?.key, ctx?.section, ai, hintsOn, readOnly, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const hint = useMemo(() => {
    if (!hintsOn || readOnly || query) return null;
    const pick = [aiHint, ...(data?.hints ?? [])].find((h) => h && !dismissed.has(h.fact) && h.fact !== justInserted) ?? null;
    if (!pick) return null;
    const fact = facts.find((f) => f.id === pick.fact);
    return fact ? { hint: pick, fact } : null;
  }, [aiHint, data, dismissed, hintsOn, readOnly, query, facts, justInserted]);

  // ── Opening, the slash command, the other side panel ─────────────────────
  const show = useCallback((focusSearch = false) => {
    setOpen(true);
    window.dispatchEvent(new CustomEvent(SIDE_EVENT, { detail: "memory" }));
    if (!focusSearch && phone) return;
    // The "/" menu hands focus back to the editor as it closes: focus the search after it, and again if lost.
    const focus = () => search.current?.focus({ preventScroll: true });
    window.setTimeout(focus, 60);
    if (focusSearch) window.setTimeout(() => { if (document.activeElement !== search.current) focus(); }, 250);
  }, [phone]);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const other = (e: Event) => {
      if ((e as CustomEvent).detail !== "memory") setOpen(false);
    };
    window.addEventListener(SIDE_EVENT, other);
    return () => window.removeEventListener(SIDE_EVENT, other);
  }, []);
  useEffect(() => {
    if (!editor || !workspaceId) return;
    const s = services(editor as never);
    s.openMeetings = (e, r) => {
      e.chain().deleteRange(r).run();
      show(true);
    };
    return () => {
      if (s.openMeetings) delete s.openMeetings;
    };
  }, [editor, workspaceId, show]);

  const insert = useCallback(async (f: MemoryFact) => {
    if (!editor || readOnly) return;
    const ok = await insertAfterCaret(editor, f.markdown).catch(() => false);
    if (!ok) {
      toast.info("Click in the page where it should go, then Insert again.");
      return;
    }
    setJustInserted(f.id);
    toast.success("Inserted, with a link to the meeting");
    if (phone) setOpen(false);
  }, [editor, readOnly, toast, phone]);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      writeDismissed(slug, next);
      return next;
    });
  }, [slug]);

  const changePrefs = useCallback((patch: Partial<MemoryPrefs>) => {
    setPrefs((p) => ({ panel: true, hints: true, ...(p ?? {}), ...patch }));
    setMemoryPrefs(patch).then(setPrefs).catch(() => toast.error("Couldn't save that. Try again."));
    cache.current.clear();
  }, [toast]);

  if (!workspaceId || failed && !data) return null;
  const meetings = data?.meetings ?? 0;
  const count = facts.length;
  const pill = panelOn && meetings > 0 && !open;
  // The hints have their own switch: with the pill off they still come (and the other way round).
  const dock = !open && (pill || !!hint);
  const where = query ? `“${query}”` : ctx?.heading ? `“${ctx.heading}”` : title.trim() ? `“${title.trim()}”` : "this page";

  return (
    <>
      {dock && (
        <div className="mm-dock no-print">
          {hint && (
            <div className="mm-hint" role="status" data-kind={hint.hint.kind}>
              <span className="mm-hint__glyph" aria-hidden><Icon name={hint.hint.kind === "contradicts" ? "alert" : "sparkle"} /></span>
              <div className="mm-hint__body">
                <p className="mm-hint__msg">{hint.hint.message}</p>
                <p className="mm-hint__q">{hint.hint.question}</p>
                <div className="mm-hint__actions">
                  <button type="button" className="mm-btn mm-btn--primary" onClick={() => void insert(hint.fact)}>Include</button>
                  <button type="button" className="mm-btn" onClick={() => show()}>See more</button>
                  <button type="button" className="mm-btn mm-btn--ghost" onClick={() => dismiss(hint.fact.id)}>Dismiss</button>
                </div>
              </div>
            </div>
          )}
          {pill && (
            <button type="button" className="mm-pill" onClick={() => show()} aria-haspopup="dialog" aria-expanded={open} data-count={count || undefined}>
              <Icon name="mic" className="mm-pill__icon" />
              <span>From meetings</span>
              {count > 0 && <span className="mm-pill__count" aria-label={`${count} related`}>{count}</span>}
            </button>
          )}
        </div>
      )}
      {createPortal(
        <div className="mm" data-open={open ? "" : undefined} data-phone={phone ? "" : undefined} inert={!open}>
          {phone && <div className="mm__scrim" onClick={close} aria-hidden />}
          <section className="mm__panel" role="dialog" aria-modal={phone || undefined} aria-labelledby="mm-title"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.defaultPrevented) {
                e.stopPropagation();
                close();
                editor?.commands.focus();
              }
            }}>
            {phone && <div className="mm__handle" aria-hidden />}
            <header className="mm__head">
              <span className="mm__glyph" aria-hidden><Icon name="sparkle" /></span>
              <div className="mm__titles">
                <h2 id="mm-title">From meetings</h2>
                <p className="ph-mask" title={where}>Related to {where}</p>
              </div>
              {loading && <Spinner size={14} className="mm__spin" />}
              <IconButton icon="x" label="Close" size="sm" onClick={close} />
            </header>
            <div className="mm__search">
              <Icon name="search" className="mm__search-icon" />
              <input ref={search} className="mm__search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search decisions, action items…" aria-label="Search your meetings" maxLength={200} />
              {q && <button type="button" className="mm__search-clear" onClick={() => { setQ(""); search.current?.focus(); }} aria-label="Clear search"><Icon name="x" /></button>}
            </div>
            <div className="mm__filters" role="radiogroup" aria-label="Show">
              {FILTERS.map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className="mm-chip" onClick={() => setKind(k)}>{label}</button>
              ))}
            </div>
            <div className="mm__body ph-no-capture">
              {meetings === 0 && data ? (
                <div className="mm-empty">
                  <p className="mm-empty__title">No meetings here yet</p>
                  <p className="mm-empty__sub">Import your team&apos;s calls in Meetings: their decisions and action items show up here while you write.</p>
                </div>
              ) : count === 0 && data ? (
                <div className="mm-empty">
                  <p className="mm-empty__title">Nothing from meetings about this yet</p>
                  <p className="mm-empty__sub">Search above for a feature, a customer or a decision. Results come from {meetings} meeting{meetings === 1 ? "" : "s"} you can open.</p>
                </div>
              ) : (
                <ol className="mm-list" aria-busy={loading || undefined}>
                  {facts.map((f) => (
                    <FactRow key={f.id} fact={f} canInsert={!readOnly && !!editor} onInsert={() => void insert(f)} inserted={justInserted === f.id} />
                  ))}
                </ol>
              )}
            </div>
            <footer className="mm__foot">
              <Switch label="Show by itself" checked={panelOn} onChange={() => changePrefs({ panel: !panelOn })} />
              <Switch label="Suggest missed decisions" checked={hintsOn} onChange={() => changePrefs({ hints: !hintsOn })} />
            </footer>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

function FactRow({ fact: f, canInsert, onInsert, inserted }: { fact: MemoryFact; canInsert: boolean; onInsert: () => void; inserted: boolean }) {
  const m = f.meeting;
  const extra = [f.owner, f.due ? `due ${f.due}` : null].filter(Boolean).join(" · ");
  return (
    <li className="mm-fact" data-kind={f.kind}>
      <div className="mm-fact__top">
        <span className="mm-kind" data-kind={f.kind}>{KIND_LABEL[f.kind]}</span>
        {f.status && <span className="mm-status" data-status={f.status}>{f.status === "done" ? "Done" : "Open"}</span>}
        <span className="mm-fact__date">{fmtDay(m.date)}</span>
      </div>
      <p className="mm-fact__text">{f.kind === "topic" && f.title ? <><strong>{f.title}</strong>{f.gist ? ` — ${f.gist}` : ""}</> : f.text}</p>
      {extra && <p className="mm-fact__extra">{extra}</p>}
      <p className="mm-fact__meta">
        {m.href ? <a href={m.href} className="mm-link">{m.title || "Meeting"}</a> : <span>{m.title || "Meeting"}</span>}
        {m.series && m.series !== m.title && <span className="mm-series">{m.series}</span>}
        {m.restricted && <span className="mm-series" title="Only its attendees can see this meeting">Attendees only</span>}
      </p>
      <div className="mm-fact__actions">
        {f.moment ? (
          <a className="mm-btn" href={f.moment.href} title={`Jump to ${f.moment.label}`}>
            <Icon name="play" /> {f.moment.label.split(", ").pop()}
          </a>
        ) : m.href ? (
          <a className="mm-btn" href={m.href}><Icon name="arrowUpRight" /> Open meeting</a>
        ) : null}
        {canInsert && (
          <button type="button" className="mm-btn mm-btn--primary" onClick={onInsert} disabled={inserted}>
            <Icon name={inserted ? "check" : "plus"} /> {inserted ? "Inserted" : "Insert"}
          </button>
        )}
      </div>
    </li>
  );
}

export default MeetingMemory;
