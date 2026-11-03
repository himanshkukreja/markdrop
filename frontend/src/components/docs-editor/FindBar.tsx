"use client";

/**
 * Find and replace inside the page, in both modes: match case, whole word, next / previous
 * (Enter / Shift+Enter), replace one, replace all. In the visual editor the matches are painted by
 * the annotations plugin and edits are ordinary transactions (one undo step each); in Markdown mode
 * they are painted behind the text (MarkdownSource) and edits go through onChange.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Icon } from "@/components/ui";
import { nextIndex, textMatches, type FindOptions, type Match } from "./core/find.mjs";
import { annotationState, refreshAnnotations, type AnnotationSource } from "./menus/annotations";
import type { EditorMode } from "./types";

export interface VisualHandle {
  editor: Editor;
  source: AnnotationSource;
  /** The suggestion card's store (the host's own suggestions: DocsEditorApi.suggest). */
  assist?: import("./menus/assist").AssistStore;
  /** Writes a change still waiting (typing is debounced) to onChange now. */
  flush?: () => void;
}

/** Scrolls the window so that viewport y `top` sits a third of the way down below the sticky bars. */
export function scrollToY(top: number, covered: number) {
  const room = window.innerHeight - covered;
  if (top >= covered + 24 && top <= window.innerHeight - 80) return;
  window.scrollTo({ top: Math.max(0, window.scrollY + top - covered - room / 3), behavior: "smooth" });
}

/** Where offset `at` of a textarea's text sits, in px below the textarea's top (wrapping included). */
export function textareaOffsetTop(ta: HTMLTextAreaElement, at: number): number {
  const cs = getComputedStyle(ta);
  const div = document.createElement("div");
  // A copy of the text, added and removed at once; blocked anyway should a recorder see it.
  div.className = "ph-no-capture";
  for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingLeft", "paddingRight", "borderTopWidth", "borderLeftWidth", "borderRightWidth", "boxSizing", "tabSize"] as const) {
    (div.style as unknown as Record<string, string>)[p] = cs[p] as string;
  }
  Object.assign(div.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", width: `${ta.offsetWidth}px`, whiteSpace: "pre-wrap", overflowWrap: "break-word", borderStyle: "solid" });
  div.textContent = ta.value.slice(0, at);
  const mark = document.createElement("span");
  mark.textContent = "​";
  div.append(mark);
  document.body.append(div);
  const top = mark.offsetTop;
  div.remove();
  return top;
}

export function FindBar({ mode, visual, getTextarea, value, onChange, readOnly, initial, onClose, onMarks, stickyTop }: {
  mode: EditorMode;
  visual: VisualHandle | null;
  getTextarea: () => HTMLTextAreaElement | null;
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  /** The search to start with (the selection), and a counter that moves each time Find is asked for. */
  initial: { text: string; seq: number };
  onClose: () => void;
  /** Markdown mode: what to paint behind the text. */
  onMarks: (m: { matches: Match[]; current: number } | null) => void;
  stickyTop?: () => number;
}) {
  const [query, setQuery] = useState(initial.text);
  const [replacement, setReplacement] = useState("");
  const [opts, setOpts] = useState<FindOptions>({ matchCase: false, wholeWord: false });
  const [showReplace, setShowReplace] = useState(false);
  const [current, setCurrent] = useState(0);
  const [, setTick] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);

  // Asked again (⌘F with the bar open): take the new selection and select the field.
  useEffect(() => {
    if (initial.text) setQuery(initial.text);
    findInput.current?.focus();
    findInput.current?.select();
  }, [initial.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const editor = mode === "visual" ? visual?.editor ?? null : null;
  const ta = () => (mode === "markdown" ? getTextarea() : null);

  // Visual: the plugin finds and paints; re-read its matches whenever the document changes.
  useEffect(() => {
    if (!visual || mode !== "visual") return;
    visual.source.find = { query, opts, current };
    refreshAnnotations(visual.editor);
  }, [visual, mode, query, opts, current]);
  useEffect(() => {
    if (!editor) return;
    const on = () => setTick((n) => n + 1);
    editor.on("transaction", on);
    return () => {
      editor.off("transaction", on);
    };
  }, [editor]);
  // Closing: nothing painted any more.
  useEffect(() => () => {
    if (visual && !visual.editor.isDestroyed) {
      visual.source.find = null;
      refreshAnnotations(visual.editor);
    }
    onMarks(null);
  }, [visual]); // eslint-disable-line react-hooks/exhaustive-deps

  const mdMatches = useMemo(() => (mode === "markdown" ? textMatches(value, query, opts) : []), [mode, value, query, opts]);
  const matches: Match[] = mode === "visual" ? (editor ? annotationState(editor.state)?.matches ?? [] : []) : mdMatches;
  const n = matches.length;
  const at = n ? Math.min(current, n - 1) : -1;

  useEffect(() => {
    if (mode === "markdown") onMarks(query ? { matches: mdMatches, current: at } : null);
  }, [mode, mdMatches, at, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const covered = () => (stickyTop?.() ?? 0) + 56;

  /** The matches as they are now (the plugin's state moves between renders). */
  const live = (): Match[] => (editor ? annotationState(editor.state)?.matches ?? [] : ta() ? textMatches(ta()!.value, query, opts) : mdMatches);

  /** Brings match i into view. */
  const show = (i: number) => {
    const m = live()[i];
    if (!m) return;
    if (editor) {
      try {
        scrollToY(editor.view.coordsAtPos(m.from).top, covered());
      } catch { /* not rendered */ }
    } else {
      const t = ta();
      if (t) scrollToY(t.getBoundingClientRect().top + textareaOffsetTop(t, m.from), covered());
    }
  };

  // A new search: start at the first match after the caret.
  useEffect(() => {
    if (!query) return;
    const caret = editor ? editor.state.selection.from : ta()?.selectionStart ?? 0;
    const i = nextIndex(live(), caret, 1);
    setCurrent(Math.max(0, i));
    if (i >= 0) requestAnimationFrame(() => show(i));
  }, [query, opts.matchCase, opts.wholeWord]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (dir: 1 | -1) => {
    if (!n) return;
    const i = (at + dir + n) % n;
    setCurrent(i);
    show(i);
  };

  const replaceOne = () => {
    if (readOnly || at < 0) return;
    const m = matches[at]!;
    if (editor) {
      const tr = editor.state.tr;
      if (replacement) tr.insertText(replacement, m.from, m.to);
      else tr.delete(m.from, m.to);
      editor.view.dispatch(tr);
    } else {
      onChange(value.slice(0, m.from) + replacement + value.slice(m.to));
    }
    // The same index is now the next match.
    requestAnimationFrame(() => show(at));
  };

  const replaceAll = () => {
    if (readOnly || !n) return;
    if (editor) {
      const tr = editor.state.tr;
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i]!;
        if (replacement) tr.insertText(replacement, m.from, m.to);
        else tr.delete(m.from, m.to);
      }
      editor.view.dispatch(tr);
    } else {
      let out = "";
      let pos = 0;
      for (const m of matches) {
        out += value.slice(pos, m.from) + replacement;
        pos = m.to;
      }
      onChange(out + value.slice(pos));
    }
    setCurrent(0);
  };

  useLayoutEffect(() => {
    findInput.current?.focus();
  }, []);

  const close = () => {
    onClose();
    if (editor) editor.commands.focus();
    else ta()?.focus();
  };

  return (
    <div
      className="dxe-find"
      role="search"
      aria-label="Find and replace"
      style={{ top: (stickyTop?.() ?? 0) + 8 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="dxe-find__panel">
      <div className="dxe-find__row">
        <button
          type="button"
          className="dxe-find__btn"
          aria-label={showReplace ? "Hide replace" : "Show replace"}
          aria-expanded={showReplace}
          title={showReplace ? "Hide replace" : "Replace"}
          onClick={() => setShowReplace((v) => !v)}
          disabled={readOnly}
        >
          <Icon name={showReplace ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <label className="dxe-find__field">
          <Icon name="search" size={13} />
          <input
            ref={findInput}
            className="ph-no-capture"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                go(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="dxe-find__count" aria-live="polite">{query ? (n ? `${at + 1} of ${n}` : "No results") : ""}</span>
        </label>
        <button type="button" className="dxe-find__btn dxe-find__btn--glyph" aria-pressed={!!opts.matchCase} title="Match case" aria-label="Match case" onClick={() => setOpts((o) => ({ ...o, matchCase: !o.matchCase }))}>Aa</button>
        <button type="button" className="dxe-find__btn dxe-find__btn--glyph dxe-find__btn--word" aria-pressed={!!opts.wholeWord} title="Whole word" aria-label="Whole word" onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}>ab</button>
        <span className="dxe-find__sep" aria-hidden />
        <button type="button" className="dxe-find__btn" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!n} onClick={() => go(-1)}>
          <Icon name="arrowUp" size={14} />
        </button>
        <button type="button" className="dxe-find__btn" aria-label="Next match" title="Next (Enter)" disabled={!n} onClick={() => go(1)}>
          <Icon name="arrowDown" size={14} />
        </button>
        <button type="button" className="dxe-find__btn" aria-label="Close find" title="Close (Esc)" onClick={close}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {showReplace && !readOnly && (
        <div className="dxe-find__row dxe-find__row--replace">
          <label className="dxe-find__field">
            <Icon name="edit" size={13} />
            <input
              className="ph-no-capture"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="Replace with"
              aria-label="Replace with"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.metaKey || e.ctrlKey) replaceAll();
                  else replaceOne();
                }
              }}
            />
          </label>
          <button type="button" className="dxe-find__text" disabled={!n} onClick={replaceOne}>Replace</button>
          <button type="button" className="dxe-find__text" disabled={!n} onClick={replaceAll}>Replace all</button>
        </div>
      )}
      </div>
    </div>
  );
}
