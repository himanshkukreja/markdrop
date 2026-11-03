"use client";

/**
 * AI in the editor: one suggestion at a time, shown in a card; nothing in the page changes until
 * Accept (one undo step). What can be asked:
 *
 *   transform  the selection (Ask AI ✦: improve, shorten, fix, tone, translate, checklist, table,
 *              explain): the passage stays highlighted, the answer replaces it (or goes below it);
 *   write      "/ai", Space on an empty line, ⌘/Ctrl J: a prompt, then a draft for that line;
 *   actions    Find action items: to-dos with person and date chips, under the selection (or for
 *              the line "/" was typed on);
 *   summary    a `:::note[Summary]` callout for the top of the page;
 *   offer      a suggestion the host already has (a drafted fix from the guide's Fix list).
 *
 * Answers stream in: deltas are gathered and drawn once a frame (rAF), the card's preview draws
 * them as blocks with the page's own views (aiPreview), Stop aborts the request and keeps what was
 * written. The target (a range, or a point between blocks) lives in the annotations plugin, so it
 * follows edits made meanwhile.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Button, Icon } from "@/components/ui";
import { cleanAiMarkdown } from "@/lib/pages-ai/sseCore.mjs";
import type { AiAction, AiStreamOptions, AiTone, AssistAction, AssistFn, EditorAi } from "../types";
import { annotationState, flashRange, setAnchor, setPending } from "./annotations";
import { selectionMarkdown } from "./markdownSlice";
import { acceptTr, afterBlock, type AiTarget } from "./aiAccept";
import { AI_ACTIONS, TONES } from "./aiMenu";
import { AiPreview } from "./aiPreview";
import { reducedMotion } from "./motion";
import { cx } from "../views/shared";

/** Kept for hosts that import it (the older Ask AI's labels). */
export const ASSIST_LABEL: Record<AssistAction, string> = {
  improve: "Improve the writing",
  shorten: "Make it shorter",
  fix: "Fix spelling and grammar",
  translate: "Translate",
};

/** A suggestion the host offered (not asked of AI here): its card's title, what Accept also does. */
export interface Offered {
  title: string;
  note?: string;
  onAccept?: () => void;
}

/** Where Accept puts the answer: over the target range (replace / block) or at the anchor (insert). */
type Place = "replace" | "block" | "insert";

interface Job {
  kind: "transform" | "write" | "actions" | "summary" | "offer";
  title: string;
  icon: string;
  place: Place;
  /** Explain: an answer to read, not a rewrite (Insert below, Copy; no Accept). */
  explain?: boolean;
  run?: (o: AiStreamOptions) => Promise<string>;
}

export type AssistState =
  | { phase: "idle" }
  | { phase: "prompt"; seq: number; place: Place }
  | { phase: "streaming" | "ready" | "error"; seq: number; job: Job; text: string; message?: string; stopped?: boolean; offered?: Offered };

const CONTEXT = 1500;
const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";

/** About 1500 characters of text on each side of [from, to) (the model's context). */
function around(editor: Editor, from: number, to: number) {
  const { doc } = editor.state;
  const before = doc.textBetween(Math.max(0, from - CONTEXT * 3), Math.max(0, from), "\n\n", " ").slice(-CONTEXT);
  const after = doc.textBetween(Math.min(to, doc.content.size), Math.min(doc.content.size, to + CONTEXT * 3), "\n\n", " ").slice(0, CONTEXT);
  return { before: before.trim() ? before : undefined, after: after.trim() ? after : undefined };
}

/** A caret at (or next to) `pos`: a text selection or a selection of blocks collapses there. */
function collapseTo(editor: Editor, pos: number) {
  const { doc } = editor.state;
  const sel = TextSelection.near(doc.resolve(Math.max(0, Math.min(pos, doc.content.size))), -1);
  editor.view.dispatch(editor.state.tr.setSelection(sel).setMeta("addToHistory", false));
}

/** One suggestion at a time, shared by the menus (they start it) and the card (it shows it). */
export class AssistStore {
  private state: AssistState = { phase: "idle" };
  private subs = new Set<() => void>();
  private seq = 0;
  private ctrl: AbortController | null = null;
  private buf = "";
  private raf = 0;
  private last: Job | null = null;
  /** The host's AI (VisualEditor keeps these current). */
  ai: EditorAi | null = null;
  legacy: AssistFn | undefined;
  /** Phones: the Ask AI menu as a bottom sheet. */
  sheet = false;

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  get = () => this.state;
  private set(s: AssistState) {
    this.state = s;
    this.subs.forEach((f) => f());
  }
  get busy() {
    return this.state.phase !== "idle";
  }
  openSheet(on: boolean) {
    this.sheet = on;
    this.set({ ...this.state });
  }

  private cancel() {
    this.ctrl?.abort();
    this.ctrl = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private clearMarks(editor: Editor) {
    setPending(editor, null);
    setAnchor(editor, null);
  }

  /* ── starting ─────────────────────────────────────────────────────────── */

  /** Ask AI on the selection (the toolbar's menu, ⌘J, the phone sheet). */
  start(editor: Editor, action: AiAction | AssistAction, opts: { tone?: AiTone; lang?: string } = {}) {
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = selectionMarkdown(editor, from, to);
    if (!text.trim()) return;
    const ctx = around(editor, from, to);
    const title =
      action === "translate" && opts.lang ? `Translate to ${opts.lang}` : action === "tone" && opts.tone ? `Tone: ${TONES.find((t) => t[0] === opts.tone)?.[1] ?? opts.tone}` : AI_ACTIONS[action as AiAction]?.label ?? "Ask AI";
    const ai = this.ai;
    const legacy = this.legacy;
    const run = ai
      ? (o: AiStreamOptions) => ai.transform({ action: action as AiAction, text, tone: opts.tone, lang: opts.lang, ...ctx }, o)
      : legacy
        ? () => legacy({ action: action as AssistAction, text, language: opts.lang })
        : null;
    if (!run) return;
    this.cancel();
    setPending(editor, { from, to });
    setAnchor(editor, null);
    // The selection collapses to its end: the toolbar goes, the highlight shows what will change.
    collapseTo(editor, to);
    this.run({ kind: "transform", title, icon: AI_ACTIONS[action as AiAction]?.icon ?? "sparkle", place: "replace", explain: action === "explain", run });
  }

  /**
   * The "/ai" prompt at the caret: on an empty line it takes the line's place; anywhere else the
   * draft goes under the caret's block. `range` (the typed "/ai") is removed first.
   */
  openPrompt(editor: Editor, range?: { from: number; to: number }): boolean {
    if (!this.ai?.write && !this.ai?.off) return false;
    this.cancel();
    if (range) editor.chain().focus().deleteRange(range).run();
    const place = this.target(editor);
    this.set({ phase: "prompt", seq: ++this.seq, place });
    return true;
  }

  /** Where a draft for the caret goes: the empty line itself, or a point under its block. */
  private target(editor: Editor): Place {
    const { $from } = editor.state.selection;
    const p = $from.parent;
    if (p.type.name === "paragraph" && !p.content.size && $from.depth >= 1) {
      setPending(editor, { from: $from.before(), to: $from.after() });
      setAnchor(editor, null);
      return "block";
    }
    setPending(editor, null);
    setAnchor(editor, afterBlock(editor.state.doc, $from.pos));
    return "insert";
  }

  /** The prompt was sent. */
  write(editor: Editor, prompt: string) {
    const s = this.state;
    const ai = this.ai;
    if (s.phase !== "prompt" || !ai?.write || !prompt.trim()) return;
    const at = this.where(editor);
    const ctx = at ? around(editor, at.from, at.to) : {};
    this.run({ kind: "write", title: prompt.trim(), icon: "sparkle", place: s.place, run: (o) => ai.write!({ prompt: prompt.trim(), ...ctx }, o) });
  }

  /**
   * Find action items: from the selection (the to-dos go under it), the prompt's line (they take
   * its place), or the whole page (they go where `at` says: the caret's line, the end).
   */
  actions(editor: Editor, from?: "selection" | "line" | "end") {
    const ai = this.ai;
    if (!ai?.actionItems) return;
    const sel = editor.state.selection;
    let text: string | undefined;
    let place: Place = "insert";
    if (this.state.phase === "prompt") {
      place = this.state.place;
    } else if (from === "selection" && !sel.empty) {
      text = selectionMarkdown(editor, sel.from, sel.to);
      setPending(editor, { from: sel.from, to: sel.to });
      setAnchor(editor, afterBlock(editor.state.doc, sel.to));
      collapseTo(editor, sel.to);
    } else if (from === "line") {
      place = this.target(editor);
    } else {
      setPending(editor, null);
      setAnchor(editor, editor.state.doc.content.size);
    }
    this.run({ kind: "actions", title: "Action items", icon: "checkSquare", place, run: (o) => ai.actionItems!({ text }, o) });
  }

  /** Summarize page: a summary callout for the top. */
  summary(editor: Editor) {
    const ai = this.ai;
    if (!ai?.summary) return;
    setPending(editor, null);
    setAnchor(editor, 0);
    this.run({ kind: "summary", title: "Summary", icon: "lines", place: "insert", run: (o) => ai.summary!(o) });
  }

  /** Shows `result` as the suggestion for `range` (a host's own, e.g. a drafted fix). */
  offer(editor: Editor, range: { from: number; to: number }, result: string, offered: Offered) {
    this.cancel();
    setPending(editor, range);
    setAnchor(editor, null);
    editor.chain().setTextSelection(Math.min(range.from + 1, editor.state.doc.content.size)).run();
    this.set({ phase: "ready", job: { kind: "offer", title: offered.title, icon: "sparkle", place: "block" }, text: result.trim(), seq: ++this.seq, offered });
  }

  retry() {
    const s = this.state;
    if ((s.phase === "ready" || s.phase === "error") && !s.offered && s.job.run) this.run(s.job);
  }

  /** Stop: the request ends; what was written so far stays as the suggestion. */
  stop(editor: Editor) {
    const s = this.state;
    if (s.phase !== "streaming") return;
    this.cancel();
    this.seq++;
    const text = cleanAiMarkdown(this.buf);
    if (text) this.set({ ...s, phase: "ready", text, stopped: true, seq: this.seq });
    else this.discard(editor);
  }

  private run(job: Job) {
    this.cancel();
    const seq = ++this.seq;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.buf = "";
    this.last = job;
    this.set({ phase: "streaming", seq, job, text: "" });
    const onDelta = (t: string, reset?: boolean) => {
      if (this.seq !== seq) return;
      this.buf = reset ? t : this.buf + t;
      // Many deltas a frame: one redraw.
      if (!this.raf) {
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          const cur = this.state;
          if (this.seq === seq && cur.phase === "streaming") this.set({ ...cur, text: this.buf });
        });
      }
    };
    Promise.resolve()
      .then(() => job.run!({ signal: ctrl.signal, onDelta }))
      .then(
        (full) => {
          if (this.seq !== seq) return;
          if (this.raf) cancelAnimationFrame(this.raf);
          this.raf = 0;
          this.ctrl = null;
          const text = cleanAiMarkdown(full || this.buf);
          if (!text) this.set({ phase: "error", seq, job, text: "", message: "The suggestion came back empty. Try again." });
          else this.set({ phase: "ready", seq, job, text });
        },
        (e: unknown) => {
          if (this.seq !== seq || isAbort(e)) return;
          if (this.raf) cancelAnimationFrame(this.raf);
          this.raf = 0;
          this.ctrl = null;
          const message = e instanceof Error && e.message ? e.message : "AI couldn't do that just now. Try again.";
          this.set({ phase: "error", seq, job, text: "", message });
        },
      );
  }

  /* ── finishing ────────────────────────────────────────────────────────── */

  /** Where the target is now: its range, or the point (as an empty range). */
  private where(editor: Editor): { from: number; to: number } | null {
    const a = annotationState(editor.state);
    if (a?.pending) return a.pending;
    if (a?.anchor != null) return { from: a.anchor, to: a.anchor };
    return null;
  }

  accept(editor: Editor): boolean {
    const s = this.state;
    if (s.phase !== "ready" || !s.text || s.job.explain) return false;
    const a = annotationState(editor.state);
    const target: AiTarget | null =
      s.job.place === "insert"
        ? a?.anchor != null ? { mode: "insert", at: a.anchor } : null
        : a?.pending ? { mode: s.job.place === "block" ? "block" : "replace", from: a.pending.from, to: a.pending.to } : null;
    const ok = target ? this.put(editor, target, s.text) : false;
    if (ok) s.offered?.onAccept?.();
    return ok;
  }

  /** Insert below: the answer goes under the passage, which stays as it is. */
  insertBelow(editor: Editor): boolean {
    const s = this.state;
    if (s.phase !== "ready" || !s.text) return false;
    const at = this.where(editor);
    if (!at) return false;
    return this.put(editor, { mode: "insert", at: afterBlock(editor.state.doc, at.to) }, s.text);
  }

  private put(editor: Editor, target: AiTarget, markdown: string): boolean {
    this.clearMarks(editor);
    this.seq++;
    this.set({ phase: "idle" });
    const tr = acceptTr(editor.state, target, markdown);
    if (!tr) {
      editor.commands.focus();
      return false;
    }
    // Its own undo step: nothing typed just before or after joins it.
    closeHistory(tr);
    const [from, to] = target.mode === "insert" ? [target.at, target.at] : [target.from, target.to];
    const start = tr.mapping.map(from, -1);
    const end = tr.mapping.map(to, 1);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
    editor.commands.focus();
    if (!reducedMotion() && end > start) {
      flashRange(editor, { from: start, to: end });
      window.setTimeout(() => flashRange(editor, null), 1400);
    }
    return true;
  }

  discard(editor: Editor) {
    this.cancel();
    this.seq++;
    this.clearMarks(editor);
    this.set({ phase: "idle" });
    if (!editor.isDestroyed) editor.commands.focus();
  }

  /** The answer, for Copy. */
  text(): string {
    const s = this.state;
    return s.phase === "ready" || s.phase === "streaming" ? cleanAiMarkdown(s.text) : "";
  }
}

/* ── the card ──────────────────────────────────────────────────────────────── */

/** Phones: the card sits over the keyboard. */
function useKeyboardInset(on: boolean) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!on || !vv) return;
    let raf = 0;
    const up = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))));
    };
    up();
    vv.addEventListener("resize", up);
    vv.addEventListener("scroll", up);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", up);
      vv.removeEventListener("scroll", up);
    };
  }, [on]);
  return inset;
}

export function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const up = () => setPhone(mq.matches);
    up();
    mq.addEventListener("change", up);
    return () => mq.removeEventListener("change", up);
  }, []);
  return phone;
}

const IDEAS: Array<{ label: string; icon: string; prompt?: string; command?: "actions" | "summary" }> = [
  { label: "Continue writing", icon: "edit", prompt: "Continue writing from where the text stops, in the same voice." },
  { label: "Write an introduction", icon: "lines", prompt: "Write a short introduction for this page." },
  { label: "Brainstorm ideas", icon: "bulb", prompt: "Brainstorm ideas about this page's topic, as a bulleted list." },
  { label: "Draft an outline", icon: "list", prompt: "Draft an outline for this page, with headings and short notes under each." },
  { label: "Find action items", icon: "checkSquare", command: "actions" },
  { label: "Summarize this page", icon: "sparkle", command: "summary" },
];

/** The suggestion card (and the "/ai" prompt), at its target. */
export function AssistPanel({ editor, store, container }: { editor: Editor; store: AssistStore; container: RefObject<HTMLDivElement | null> }) {
  const s = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [top, setTop] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const stopBtn = useRef<HTMLButtonElement>(null);
  const stick = useRef(true);
  const phone = usePhoneWidth();
  const open = s.phase !== "idle";
  const inset = useKeyboardInset(open && phone);

  // At the target: over the empty line (the prompt, and the draft that replaces it), under the
  // passage (a selection), under the block before the point, or at the top of the page.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const wrap = container.current;
      const a = annotationState(editor.state);
      if (!wrap) return setTop(null);
      const base = wrap.getBoundingClientRect().top;
      const view = editor.view;
      try {
        const blockMode = s.phase === "prompt" ? s.place === "block" : "job" in s && s.job.place === "block";
        if (a?.pending && blockMode) {
          const dom = view.nodeDOM(a.pending.from) as HTMLElement | null;
          const r = dom?.getBoundingClientRect?.() ?? view.coordsAtPos(Math.min(a.pending.from + 1, editor.state.doc.content.size));
          return setTop(r.top - base - 6);
        }
        if (a?.pending) return setTop(view.coordsAtPos(a.pending.to).bottom - base + 8);
        if (a?.anchor != null) {
          if (a.anchor === 0) return setTop(-6);
          const $a = editor.state.doc.resolve(a.anchor);
          const before = $a.nodeBefore;
          const dom = before ? (view.nodeDOM(a.anchor - before.nodeSize) as HTMLElement | null) : null;
          const bottom = dom?.getBoundingClientRect?.().bottom ?? view.coordsAtPos(Math.max(0, a.anchor - 1)).bottom;
          return setTop(bottom - base + 8);
        }
        setTop(null);
      } catch {
        setTop(null);
      }
    };
    place();
    editor.on("transaction", place);
    window.addEventListener("resize", place);
    return () => {
      editor.off("transaction", place);
      window.removeEventListener("resize", place);
    };
  }, [editor, container, open, s.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus: the prompt's field, Stop while it writes, then Accept (or Insert below).
  useEffect(() => {
    if (s.phase === "prompt") {
      setPrompt("");
      requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    }
    if (s.phase === "streaming") {
      stick.current = true;
      stopBtn.current?.focus({ preventScroll: true });
    }
    if (s.phase === "ready" || s.phase === "error") primary.current?.focus({ preventScroll: true });
    // Done: the answer is read from its start.
    if (s.phase === "ready" && body.current && body.current.scrollTop > 0) body.current.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
    if (open) card.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    setCopied(false);
  }, [s.phase, s.phase !== "idle" ? s.seq : 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // While it writes, the preview follows the newest line (unless you scrolled up to read).
  useLayoutEffect(() => {
    const b = body.current;
    if (s.phase === "streaming" && b && stick.current) b.scrollTop = b.scrollHeight;
  });

  // The target vanished (its text was deleted): nothing to replace any more.
  useEffect(() => {
    if (!open) return;
    const check = () => {
      const a = annotationState(editor.state);
      if (!a?.pending && a?.anchor == null) store.discard(editor);
    };
    editor.on("update", check);
    return () => {
      editor.off("update", check);
    };
  }, [editor, store, open]);

  // Esc anywhere discards; a click outside an empty prompt closes it.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      store.discard(editor);
    };
    const down = (e: PointerEvent) => {
      if (store.get().phase !== "prompt" || input.current?.value.trim()) return;
      if (card.current && !card.current.contains(e.target as Node)) store.discard(editor);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down, true);
    };
  }, [editor, store, open]);

  if (!open || (top === null && !phone)) return null;
  const style = phone ? ({ transform: inset ? `translate3d(0, ${-inset}px, 0)` : undefined } as React.CSSProperties) : { top: top ?? 0 };

  if (s.phase === "prompt") {
    const send = (e?: React.FormEvent) => {
      e?.preventDefault();
      if (prompt.trim()) store.write(editor, prompt);
    };
    return (
      <div ref={card} className="dxe-ai dxe-ai--prompt" style={style} role="dialog" aria-label="Ask AI to write" contentEditable={false}>
        {store.ai?.off ? (
          <p className="dxe-ai__offnote" role="note">
            <span className="dxe-ai__spark" aria-hidden><Icon name="sparkle" size={16} /></span> {store.ai.off}
          </p>
        ) : (
        <form className="dxe-ai__ask" onSubmit={send}>
          <span className="dxe-ai__spark" aria-hidden><Icon name="sparkle" size={16} /></span>
          <input
            ref={input}
            className="dxe-ai__input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask AI to write anything…"
            aria-label="What should AI write?"
            maxLength={2000}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !prompt) {
                e.preventDefault();
                store.discard(editor);
              }
            }}
          />
          <button type="submit" className="dxe-ai__send" aria-label="Send" disabled={!prompt.trim()}>
            <Icon name="arrowUp" size={16} />
          </button>
        </form>
        )}
        {!prompt.trim() && !store.ai?.off && (
          <div className="dxe-ai__ideas" role="menu" aria-label="Suggestions">
            {IDEAS.filter((i) => (i.command === "actions" ? !!store.ai?.actionItems : i.command === "summary" ? !!store.ai?.summary : true)).map((i) => (
              <button
                key={i.label}
                type="button"
                role="menuitem"
                className="dxe-ai__idea"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (i.prompt) store.write(editor, i.prompt);
                  else if (i.command === "actions") store.actions(editor);
                  else {
                    store.discard(editor);
                    store.summary(editor);
                  }
                }}
              >
                <Icon name={i.icon} size={15} aria-hidden />
                <span>{i.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const streaming = s.phase === "streaming";
  const explain = !!s.job.explain;
  const canInsertBelow = s.job.kind === "transform";
  const empty = streaming && !s.text.trim();
  return (
    <div
      ref={card}
      className={cx("dxe-ai", streaming && "dxe-ai--streaming")}
      style={style}
      role="region"
      aria-label="AI suggestion"
      aria-busy={streaming || undefined}
      contentEditable={false}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && s.phase === "ready") {
          e.preventDefault();
          if (explain) store.insertBelow(editor);
          else store.accept(editor);
        }
      }}
    >
      <div className="dxe-ai__head">
        <span className="dxe-ai__spark" aria-hidden><Icon name="sparkle" size={14} /></span>
        <span className="dxe-ai__title ph-no-capture" title={s.job.title}>{s.job.kind === "write" ? `“${s.job.title}”` : s.job.title}</span>
        <span className="dxe-ai__status" aria-live="polite">
          {streaming ? <span className="dxe-ai__writing">Writing</span> : s.phase === "ready" && s.stopped ? "Stopped" : ""}
        </span>
      </div>
      {s.phase !== "error" && (
        // The customer's own words: never recorded.
        <div
          ref={body}
          className="dxe-ai__body ph-no-capture"
          onScroll={(e) => {
            const b = e.currentTarget;
            stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
          }}
        >
          {empty ? (
            <div className="dxe-ai__skeleton" aria-hidden><span /><span /><span /></div>
          ) : (
            <AiPreview markdown={s.text} streaming={streaming} />
          )}
          {streaming && !empty && <span className="dxe-ai__dots" aria-hidden><i /><i /><i /></span>}
        </div>
      )}
      {s.phase === "error" && (
        <p className="dxe-ai__error" role="alert">
          <Icon name="alertCircle" size={15} aria-hidden /> {s.message}
        </p>
      )}
      <div className="dxe-ai__actions">
        {streaming ? (
          <Button ref={stopBtn} size="sm" variant="secondary" iconLeft="stop" onClick={() => store.stop(editor)}>Stop</Button>
        ) : s.phase === "ready" ? (
          <>
            {!explain && (
              <Button ref={primary} size="sm" variant="primary" iconLeft="check" onClick={() => store.accept(editor)}>
                Accept
              </Button>
            )}
            {(canInsertBelow || explain) && (
              <Button ref={explain ? primary : undefined} size="sm" variant={explain ? "primary" : "ghost"} iconLeft="plus" onClick={() => store.insertBelow(editor)}>Insert below</Button>
            )}
            {explain && (
              <Button size="sm" variant="ghost" iconLeft={copied ? "check" : "copy"} onClick={() => void navigator.clipboard?.writeText(store.text()).then(() => setCopied(true), () => {})}>
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
            {!s.offered && s.job.run && <Button size="sm" variant="ghost" iconLeft="refresh" onClick={() => store.retry()}>Retry</Button>}
          </>
        ) : (
          s.job.run && <Button ref={primary} size="sm" variant="secondary" iconLeft="refresh" onClick={() => store.retry()}>Retry</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => store.discard(editor)}>
          Discard <kbd className="dxe-ai__kbd">Esc</kbd>
        </Button>
        <span className="dxe-ai__note">{s.phase === "ready" ? (s.offered?.note ?? "AI can make mistakes. Check it before you accept.") : ""}</span>
      </div>
    </div>
  );
}
