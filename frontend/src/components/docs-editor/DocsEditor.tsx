"use client";

/**
 * <DocsEditor>: a docs page as Markdown in, Markdown out, edited visually (blocks, slash menu,
 * format toolbar, drag handles) or as plain Markdown. The visual editor (TipTap + the Markdown
 * converter) is a separate chunk loaded on first use; Markdown mode is a plain textarea.
 *
 * Both modes have Find and replace (⌘F / Ctrl+F), and the host gets an API (`apiRef`) to open it,
 * scroll to and select something on the page, and apply the page checks' fixes.
 */
import "./docs-editor.css";
import dynamic from "next/dynamic";
import { Fragment, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { SegmentedControl, Skeleton } from "@/components/ui";
import { splitFrontmatter } from "./core/frontmatter.mjs";
import { docMatches, type Match } from "./core/find.mjs";
import { FindBar, scrollToY, textareaOffsetTop, type VisualHandle } from "./FindBar";
import { PageHeader } from "./PageHeader";
import type { DocsEditorApi, DocsEditorProps, EditorMode, RevealTarget } from "./types";

const VisualEditor = dynamic(() => import("./VisualEditor"), {
  ssr: false,
  loading: () => (
    <div className="dxe-loading" aria-busy="true" aria-label="Loading the editor">
      <Skeleton width="92%" />
      <Skeleton width="78%" />
      <Skeleton width="85%" />
      <Skeleton variant="rect" height={96} />
      <Skeleton width="64%" />
    </div>
  ),
});

/** Warms the visual editor's chunk (e.g. on hover of an "Edit" link) so it opens instantly. */
export function preloadDocsEditor() {
  void import("./VisualEditor");
}

const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => (typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? e.metaKey : e.ctrlKey);

function MarkdownSource({ value, onChange, readOnly, placeholder, label, taRef, marks }: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  label: string;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  marks: { matches: Match[]; current: number } | null;
}) {
  const ref = taRef;
  // Grow with the text. Measuring needs the box at "auto" for a moment; hold the wrapper at its
  // current height meanwhile, or the page gets shorter, the browser clamps the scroll position and
  // typing far down a long page jumps it up.
  useLayoutEffect(() => {
    const el = ref.current;
    const wrap = el?.parentElement;
    if (!el || !wrap) return;
    wrap.style.minHeight = `${wrap.offsetHeight}px`;
    el.style.height = "auto";
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.max(el.scrollHeight + border, 320)}px`;
    wrap.style.minHeight = "";
  }, [value, ref]);
  // Find's matches, painted behind the (transparent) text in a copy of it laid out the same way.
  let backdrop: React.ReactNode = null;
  if (marks?.matches.length) {
    const parts: React.ReactNode[] = [];
    let at = 0;
    marks.matches.forEach((m, i) => {
      parts.push(<Fragment key={`t${i}`}>{value.slice(at, m.from)}</Fragment>);
      parts.push(<mark key={`m${i}`} className={i === marks.current ? "dxe-hit dxe-hit--on" : "dxe-hit"}>{value.slice(m.from, m.to)}</mark>);
      at = m.to;
    });
    parts.push(<Fragment key="end">{value.slice(at)}{"\n"}</Fragment>);
    backdrop = <div className="dxe-source__marks" aria-hidden>{parts}</div>;
  }
  return (
    <div className="dxe-source">
      <div className="dxe-source__box" data-marks={backdrop ? "" : undefined}>
        {backdrop}
        <textarea
          ref={ref}
          className="dxe-source__text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          placeholder={placeholder ?? "Write Markdown…"}
          aria-label={label}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onKeyDown={(e) => {
            // Tab indents (two spaces) instead of leaving the field; Esc then Tab leaves it.
            if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !readOnly && !(e.currentTarget as HTMLTextAreaElement & { _esc?: boolean })._esc) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: s, selectionEnd: t } = el;
              const next = el.value.slice(0, s) + "  " + el.value.slice(t);
              onChange(next);
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            }
            (e.currentTarget as HTMLTextAreaElement & { _esc?: boolean })._esc = e.key === "Escape";
          }}
        />
      </div>
      <p className="dxe-source__note">The same page as Markdown. Switch back any time; nothing is lost.</p>
    </div>
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lines of Markdown outside fenced code, with their offsets (headings live there). */
function proseLines(md: string): Array<{ text: string; from: number }> {
  const out: Array<{ text: string; from: number }> = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of md.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
    } else if (f) {
      fence = f[1]!;
    } else {
      out.push({ text: line, from: at });
    }
    at += line.length + 1;
  }
  return out;
}

const HEADING_LINE = /^\s{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*(?:\{#[^}]*\})?[ \t]*#*[ \t]*$/;

/** Where a target is in the Markdown text: [from, to), or null. */
function locateInMarkdown(md: string, t: RevealTarget): [number, number] | null {
  const find = (re: RegExp): [number, number] | null => {
    const m = re.exec(md);
    return m ? [m.index, m.index + m[0].length] : null;
  };
  if (t.kind === "link") return find(new RegExp(`(?<!!)\\[[^\\]\\n]*\\]\\(\\s*<?${escapeRe(t.href)}>?(?:\\s+"[^"\\n]*")?\\s*\\)`));
  if (t.kind === "image") return find(new RegExp(`!\\[[^\\]\\n]*\\]\\(\\s*<?${escapeRe(t.src)}`));
  if (t.kind === "quote") {
    const line = t.quote.split("\n").find((l) => l.trim()) ?? "";
    const i = line ? md.indexOf(line) : -1;
    return i < 0 ? null : [i, i + line.length];
  }
  let seen = 0;
  for (const l of proseLines(md)) {
    const m = HEADING_LINE.exec(l.text);
    if (!m) continue;
    if (t.level && m[1]!.length !== t.level) continue;
    const text = (m[2] ?? "").trim();
    if (text !== t.text.trim()) continue;
    if (seen++ < (t.nth ?? 0)) continue;
    return [l.from, l.from + l.text.length];
  }
  return null;
}

export function DocsEditor({
  value,
  onChange,
  mode: modeProp,
  onModeChange,
  onUploadImage,
  readOnly,
  placeholder,
  showHeader = true,
  showModeSwitch = true,
  operations,
  resolveAssetUrl,
  autoFocus,
  className,
  stickyTop,
  "aria-label": ariaLabel = "Page content",
  headerIcon = true,
  headerTop,
  apiRef,
  assist,
  assistLanguages,
  onComment,
  comments,
  onCommentClick,
  checkLink,
  flagImages,
  onFindOpen,
}: DocsEditorProps) {
  const [own, setOwn] = useState<EditorMode>("visual");
  const mode = modeProp ?? own;
  const setMode = useCallback(
    (m: EditorMode) => {
      if (modeProp === undefined) setOwn(m);
      onModeChange?.(m);
    },
    [modeProp, onModeChange],
  );
  const toMarkdown = useCallback(() => setMode("markdown"), [setMode]);
  const { front, body } = splitFrontmatter(value);
  const onFront = useCallback((f: string) => onChange(f + (f && body && !/^\r?\n/.test(body) && !front ? "\n" : "") + body), [onChange, body, front]);

  const [visual, setVisual] = useState<VisualHandle | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [find, setFind] = useState<{ text: string; seq: number } | null>(null);
  const [marks, setMarks] = useState<{ matches: Match[]; current: number } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const visualRef = useRef(visual);
  visualRef.current = visual;

  const onReady = useCallback((h: VisualHandle | null) => setVisual(h), []);

  const openFind = useCallback(() => {
    let text = "";
    const v = visualRef.current;
    if (modeRef.current === "visual" && v && !v.editor.isDestroyed) {
      const { from, to } = v.editor.state.selection;
      text = v.editor.state.doc.textBetween(from, to, "\n");
    } else if (textarea.current) {
      const ta = textarea.current;
      text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    }
    if (text.includes("\n") || text.length > 200) text = "";
    setFind((f) => {
      if (!f) onFindOpen?.();
      return { text, seq: (f?.seq ?? 0) + 1 };
    });
  }, [onFindOpen]);

  const covered = () => (stickyTop?.() ?? 0) + 56;

  useImperativeHandle(apiRef, (): DocsEditorApi => ({
    openFind,
    focus() {
      const v = visualRef.current;
      if (modeRef.current === "visual" && v) v.editor.commands.focus();
      else textarea.current?.focus();
    },
    reveal(t) {
      const v = visualRef.current;
      if (modeRef.current === "visual" && v && !v.editor.isDestroyed) {
        const ed = v.editor;
        const { doc } = ed.state;
        let range: { from: number; to: number; node?: boolean } | null = null;
        if (t.kind === "image") {
          doc.descendants((n, pos) => {
            if (range) return false;
            if ((n.type.name === "figure" || n.type.name === "image") && n.attrs.src === t.src) range = { from: pos, to: pos + n.nodeSize, node: true };
            return true;
          });
        } else if (t.kind === "link") {
          doc.descendants((n, pos) => {
            if (range) return false;
            if (!n.isText) return true;
            const mark = n.marks.find((m) => m.type.name === "link" && m.attrs.href === t.href);
            if (mark) {
              // The whole run of text that carries this link.
              const $p = doc.resolve(pos);
              let from = pos;
              let to = pos + n.nodeSize;
              $p.parent.forEach((c, off) => {
                const at = $p.start() + off;
                if (c.marks.some((m) => m.eq(mark)) && (at + c.nodeSize === from || at === to)) {
                  if (at + c.nodeSize === from) from = at;
                  else to = at + c.nodeSize;
                }
              });
              range = { from, to };
            }
            return false;
          });
        } else if (t.kind === "heading") {
          let seen = 0;
          doc.descendants((n, pos) => {
            if (range) return false;
            if (n.type.name !== "heading") return true;
            if ((!t.level || n.attrs.level === t.level) && n.textContent.trim() === t.text.trim() && seen++ >= (t.nth ?? 0)) {
              range = n.content.size ? { from: pos + 1, to: pos + 1 + n.content.size } : { from: pos + 1, to: pos + 1 };
            }
            return false;
          });
        } else {
          const line = t.quote.split("\n").find((l) => l.trim()) ?? "";
          const m = line ? docMatches(doc, line, { matchCase: true })[0] : undefined;
          if (m) range = m;
        }
        if (!range) return false;
        const r = range as { from: number; to: number; node?: boolean };
        const sel = r.node ? NodeSelection.create(doc, r.from) : TextSelection.create(doc, r.from, r.to);
        ed.view.dispatch(ed.state.tr.setSelection(sel));
        ed.view.focus();
        try {
          scrollToY(ed.view.coordsAtPos(r.from).top, covered());
        } catch { /* not rendered */ }
        return true;
      }
      const ta = textarea.current;
      if (!ta) return false;
      const at = locateInMarkdown(ta.value, t);
      if (!at) return false;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(at[0], at[1]);
      scrollToY(ta.getBoundingClientRect().top + textareaOffsetTop(ta, at[0]), covered());
      return true;
    },
    suggest({ heading, level, markdown, title, note, onAccept }) {
      const v = visualRef.current;
      if (modeRef.current !== "visual" || !v || v.editor.isDestroyed || !v.assist) return false;
      const ed = v.editor;
      const { doc } = ed.state;
      // Top-level blocks: a section runs from its heading to the next heading of its level or higher.
      const blocks: { pos: number; level: number | null; text: string }[] = [];
      doc.forEach((n, pos) => blocks.push({ pos, level: n.type.name === "heading" ? Number(n.attrs.level) : null, text: n.textContent.trim() }));
      let from = 0;
      let to = doc.content.size;
      if (heading == null) {
        const first = blocks.find((b) => b.level !== null);
        if (first) to = first.pos;
      } else {
        const at = blocks.findIndex((b) => b.level !== null && (!level || b.level === level) && b.text === heading.trim());
        if (at < 0) return false;
        from = blocks[at].pos;
        const lvl = blocks[at].level!;
        const next = blocks.slice(at + 1).find((b) => b.level !== null && b.level <= lvl);
        if (next) to = next.pos;
      }
      if (to <= from && heading != null) return false;
      v.assist.offer(ed, { from, to }, markdown, { title, note, onAccept });
      try {
        scrollToY(ed.view.coordsAtPos(Math.min(from + 1, doc.content.size)).top, covered());
      } catch { /* not rendered */ }
      return true;
    },
    setImageAlt(src, alt) {
      const v = visualRef.current;
      const clean = alt.replace(/[\n\r\]]/g, " ").trim();
      if (!clean) return 0;
      if (modeRef.current === "visual" && v && !v.editor.isDestroyed) {
        const { state } = v.editor;
        const tr = state.tr;
        let n = 0;
        state.doc.descendants((node, pos) => {
          if ((node.type.name === "figure" || node.type.name === "image") && node.attrs.src === src && !String(node.attrs.alt ?? "").trim()) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: clean });
            n++;
          }
          return true;
        });
        if (n) v.editor.view.dispatch(tr);
        return n;
      }
      let n = 0;
      const next = valueRef.current.replace(new RegExp(`!\\[\\s*\\]\\((\\s*<?${escapeRe(src)})`, "g"), (_m, rest: string) => {
        n++;
        return `![${clean}](${rest}`;
      });
      if (n) onChangeRef.current(next);
      return n;
    },
    removeEmptyHeadings() {
      const v = visualRef.current;
      if (modeRef.current === "visual" && v && !v.editor.isDestroyed) {
        const { state } = v.editor;
        const ranges: Array<[number, number]> = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === "heading") {
            if (!node.textContent.trim()) ranges.push([pos, pos + node.nodeSize]);
            return false;
          }
          return true;
        });
        if (!ranges.length) return 0;
        const tr = state.tr;
        for (const [a, b] of ranges.reverse()) tr.delete(a, b);
        v.editor.view.dispatch(tr);
        return ranges.length;
      }
      const md = valueRef.current;
      const { front: fm } = splitFrontmatter(md);
      const drop = proseLines(md).filter((l) => l.from >= fm.length && /^\s{0,3}#{1,6}[ \t]*#*[ \t]*$/.test(l.text));
      if (!drop.length) return 0;
      let out = md;
      for (const l of drop.reverse()) out = out.slice(0, l.from) + out.slice(Math.min(out.length, l.from + l.text.length + 1));
      onChangeRef.current(out);
      return drop.length;
    },
  }), [openFind]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={["dxe-root", className].filter(Boolean).join(" ")}
      data-mode={mode}
      onKeyDown={(e) => {
        if (isMod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          e.stopPropagation();
          openFind();
        }
      }}
    >
      {showModeSwitch && (
        <div className="dxe-modebar">
          <SegmentedControl<EditorMode>
            aria-label="Editor mode"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: "visual", label: "Visual" },
              { value: "markdown", label: "Markdown" },
            ]}
          />
        </div>
      )}
      {find && (
        <FindBar
          key={mode}
          mode={mode}
          visual={mode === "visual" ? visual : null}
          getTextarea={() => textarea.current}
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          initial={find}
          onClose={() => setFind(null)}
          onMarks={setMarks}
          stickyTop={stickyTop}
        />
      )}
      {mode === "visual" ? (
        <>
          {showHeader && <PageHeader front={front} onFront={onFront} readOnly={readOnly} showIcon={headerIcon} top={headerTop} />}
          {!showHeader && headerTop}
          <VisualEditor
            value={value}
            onChange={onChange}
            readOnly={readOnly}
            placeholder={placeholder}
            onUploadImage={onUploadImage}
            operations={operations}
            resolveAssetUrl={resolveAssetUrl}
            autoFocus={autoFocus}
            onRequestMarkdown={toMarkdown}
            stickyTop={stickyTop}
            aria-label={ariaLabel}
            onHandle={onReady}
            assist={assist}
            assistLanguages={assistLanguages}
            onComment={onComment}
            comments={comments}
            onCommentClick={onCommentClick}
            checkLink={checkLink}
            flagImages={flagImages}
          />
        </>
      ) : (
        <>
          {headerTop}
          <MarkdownSource value={value} onChange={onChange} readOnly={readOnly} placeholder={placeholder} label={`${ariaLabel} (Markdown)`} taRef={textarea} marks={find ? marks : null} />
        </>
      )}
    </div>
  );
}

export default DocsEditor;
