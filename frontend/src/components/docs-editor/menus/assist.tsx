"use client";

/**
 * Ask AI on a selection: the request, then the answer as a suggestion under the text. Nothing in
 * the page changes until Accept; Discard (or Esc) drops it. While a suggestion is open the passage
 * it would replace stays highlighted, and that range follows edits made meanwhile (annotations.ts).
 *
 * The host can also offer a suggestion it already has (`offer`: a drafted fix from the guide's Fix
 * list, over the section it rewrites), shown and accepted the same way, with no Try again.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { Button, Icon, Spinner } from "@/components/ui";
import type { AssistAction, AssistFn } from "../types";
import { annotationState, setPending } from "./annotations";
import { replaceWithMarkdown, selectionMarkdown } from "./markdownSlice";

export const ASSIST_LABEL: Record<AssistAction, string> = {
  improve: "Improve the writing",
  shorten: "Make it shorter",
  fix: "Fix spelling and grammar",
  translate: "Translate",
};

/** A suggestion the host offered (not asked of Ask AI here): its card's title, what Accept also does. */
export interface Offered {
  title: string;
  note?: string;
  onAccept?: () => void;
}

type State =
  | { phase: "idle" }
  | { phase: "loading" | "ready" | "error"; action: AssistAction; language?: string; text: string; result?: string; message?: string; seq: number; offered?: Offered };

/** One suggestion at a time, shared by the toolbar (starts it) and the panel (shows it). */
export class AssistStore {
  private state: State = { phase: "idle" };
  private subs = new Set<() => void>();
  private seq = 0;
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  get = () => this.state;
  private set(s: State) {
    this.state = s;
    this.subs.forEach((f) => f());
  }
  get busy() {
    return this.state.phase !== "idle";
  }

  /** Asks for a rewrite of the current selection. */
  start(editor: Editor, assist: AssistFn, action: AssistAction, language?: string) {
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const text = selectionMarkdown(editor, from, to);
    if (!text.trim()) return;
    setPending(editor, { from, to });
    // Collapse the selection to its end: the toolbar goes, the highlight shows what will change.
    editor.chain().setTextSelection(to).run();
    this.run(editor, assist, action, language, text);
  }

  /** Shows `result` as the suggestion for `range` (a host's own, e.g. a drafted fix). */
  offer(editor: Editor, range: { from: number; to: number }, result: string, offered: Offered) {
    setPending(editor, range);
    editor.chain().setTextSelection(range.from).run();
    this.set({ phase: "ready", action: "improve", text: "", seq: ++this.seq, result: result.trim(), offered });
  }

  retry(editor: Editor, assist: AssistFn) {
    const s = this.state;
    if (s.phase === "idle" || s.offered) return;
    this.run(editor, assist, s.action, s.language, s.text);
  }

  private run(editor: Editor, assist: AssistFn, action: AssistAction, language: string | undefined, text: string) {
    const seq = ++this.seq;
    this.set({ phase: "loading", action, language, text, seq });
    assist({ action, text, language }).then(
      (result) => {
        if (this.seq !== seq) return;
        const clean = (result ?? "").trim();
        if (!clean) this.set({ phase: "error", action, language, text, seq, message: "The suggestion came back empty. Try again." });
        else this.set({ phase: "ready", action, language, text, seq, result: clean });
      },
      (e: unknown) => {
        if (this.seq !== seq) return;
        const message = e instanceof Error && e.message ? e.message : "Ask AI couldn't do that just now. Try again.";
        this.set({ phase: "error", action, language, text, seq, message });
      },
    );
    void editor;
  }

  accept(editor: Editor): boolean {
    const s = this.state;
    const range = annotationState(editor.state)?.pending;
    if (s.phase !== "ready" || !s.result || !range) return false;
    setPending(editor, null);
    const ok = replaceWithMarkdown(editor, range.from, range.to, s.result);
    this.seq++;
    this.set({ phase: "idle" });
    editor.commands.focus();
    if (ok) s.offered?.onAccept?.();
    return ok;
  }

  discard(editor: Editor) {
    this.seq++;
    setPending(editor, null);
    this.set({ phase: "idle" });
    if (!editor.isDestroyed) editor.commands.focus();
  }
}

/** The suggestion card, under the passage it would replace. */
export function AssistPanel({ editor, store, assist, container }: { editor: Editor; store: AssistStore; assist?: AssistFn; container: RefObject<HTMLDivElement | null> }) {
  const s = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [top, setTop] = useState<number | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);

  // Below the passage's last line, following it as the text above changes.
  useLayoutEffect(() => {
    if (s.phase === "idle") return;
    const place = () => {
      const range = annotationState(editor.state)?.pending;
      const wrap = container.current;
      if (!range || !wrap) return setTop(null);
      try {
        const c = editor.view.coordsAtPos(range.to);
        setTop(c.bottom - wrap.getBoundingClientRect().top + 8);
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
  }, [editor, container, s.phase]);

  useEffect(() => {
    if (s.phase === "ready") acceptRef.current?.focus({ preventScroll: true });
    if (s.phase !== "idle") card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [s.phase]);

  // The suggestion's range vanished (its text was deleted): nothing to replace any more.
  useEffect(() => {
    if (s.phase === "idle") return;
    const check = () => {
      if (!annotationState(editor.state)?.pending) store.discard(editor);
    };
    editor.on("update", check);
    return () => {
      editor.off("update", check);
    };
  }, [editor, store, s.phase]);

  if (s.phase === "idle" || top === null) return null;
  const title = s.offered?.title ?? (s.action === "translate" && s.language ? `Translate to ${s.language}` : ASSIST_LABEL[s.action]);
  return (
    <div
      ref={card}
      className="dxe-assist"
      style={{ top }}
      role="region"
      aria-label="AI suggestion"
      contentEditable={false}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          store.discard(editor);
        }
      }}
    >
      <div className="dxe-assist__head">
        <Icon name="zap" size={14} />
        <span className="dxe-assist__title">{title}</span>
        {s.phase === "loading" && <span className="dxe-assist__status" aria-live="polite"><Spinner size={12} /> Writing…</span>}
      </div>
      {s.phase === "loading" && (
        <div className="dxe-assist__skeleton" aria-hidden>
          <span /><span /><span />
        </div>
      )}
      {s.phase === "ready" && (
        // The customer's own words: never recorded.
        <div className="dxe-assist__body ph-no-capture" aria-live="polite">{s.result}</div>
      )}
      {s.phase === "error" && <p className="dxe-assist__error" role="alert">{s.message}</p>}
      <div className="dxe-assist__actions">
        {s.phase === "ready" && (
          <Button ref={acceptRef} size="sm" variant="primary" iconLeft="check" onClick={() => store.accept(editor)}>Accept</Button>
        )}
        {s.phase !== "loading" && !s.offered && assist && (
          <Button size="sm" variant="ghost" iconLeft="refresh" onClick={() => store.retry(editor, assist)}>Try again</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => store.discard(editor)}>{s.phase === "loading" ? "Cancel" : "Discard"}</Button>
        <span className="dxe-assist__note">{s.phase === "ready" ? (s.offered?.note ?? "Check it before you accept. AI can make mistakes.") : ""}</span>
      </div>
    </div>
  );
}
