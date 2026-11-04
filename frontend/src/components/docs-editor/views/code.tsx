"use client";

/**
 * Code-like blocks: fenced code (language, title and wrap edit the fence's meta, nothing else in
 * it; a ```mermaid fence shows its diagram unless it's being edited), math with a live KaTeX
 * preview, inline math, and raw blocks (Markdown the visual editor keeps verbatim).
 */
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Badge, Button, Icon, Skeleton } from "@/components/ui";
import { readMeta, setMetaTitle, setMetaWrap } from "../core/fence.mjs";
import { useHost } from "../host";
import { cx } from "./shared";
import { cleanAttrs } from "../core/attrs.mjs";

export function CodeBlockView({ node, updateAttributes, editor, getPos, selectionInside, selected }: ReactNodeViewProps) {
  const host = useHost();
  const language = (node.attrs.language as string | null) ?? "";
  const meta = node.attrs.meta as string | null;
  const { title, wrap } = readMeta(meta);
  const ro = host.readOnly || !editor.isEditable;
  const battrs = node.attrs.battrs as Record<string, string> | null;
  const caption = battrs?.caption ?? "";
  // A ```mermaid fence (the reader's test, PageRenderer `Pre`): the diagram, and the code only while
  // it's being edited (the caret is in it and the editor has focus). Read only: always the diagram.
  const mermaid = language === MERMAID;
  const wrapRef = useRef<HTMLDivElement>(null);
  const focused = useFocusWithin(editor, wrapRef, mermaid && !ro);
  const [opening, setOpening] = useState(false);
  const editing = mermaid && !ro && (opening || (!!selectionInside && focused));
  useEffect(() => {
    if (!opening) return;
    // The caret is in the code, or the block itself is selected (Esc): done opening.
    if ((selectionInside && focused) || selected) return setOpening(false);
    const t = setTimeout(() => setOpening(false), 600);
    return () => clearTimeout(t);
  }, [opening, selectionInside, focused, selected]);
  const code = node.textContent;
  // While typing, the preview follows the code once it settles; otherwise it is the code itself.
  const settled = useSettled(code, editing ? 350 : 0);
  const showDiagram = mermaid && !editing;

  const edit = () => {
    if (ro) return;
    setOpening(true);
    // A frame later (the click's own selection lands first). When the selection went elsewhere in
    // that frame (Esc showed the diagram again, a click or a key moved on), that wins: pulling the
    // caret back into the code here reopened it right after Esc (a busy main thread runs the frame late).
    const at = editor.state.selection;
    requestAnimationFrame(() => {
      const pos = getPos();
      const now = editor.state.selection;
      if (now.eq(at)) openMermaid(editor, pos);
      else if (!caretIn(editor, pos)) setOpening(false);
    });
  };
  const done = () => closeMermaid(editor, getPos());
  // A click on the diagram edits it (not on its buttons, nor inside its "Open larger" dialog).
  const onDiagramClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const t = e.target as Element;
    if (ro || !e.currentTarget.contains(t) || t.closest("button, a, input, [role=dialog]")) return;
    edit();
  };

  return (
    <NodeViewWrapper
      ref={wrapRef}
      className={cx(showDiagram ? "not-prose dxe-code dxe-mermaid" : "md-codeblock not-prose dxe-code", mermaid && editing && "dxe-mermaid--editing", title && "dx-code--titled", wrap && "dx-code--wrap")}
      data-lang={language || undefined}
    >
      <div contentEditable={false} className="md-codeblock__head dxe-code__head" hidden={showDiagram}>
        <input
          className="dxe-code__title"
          value={title}
          placeholder={language ? `${language} (add a title)` : "Title (optional)"}
          aria-label="Code block title"
          readOnly={ro}
          onChange={(e) => updateAttributes({ meta: setMetaTitle(meta, e.target.value) })}
        />
        <input
          className="dxe-code__lang"
          value={language}
          placeholder="language"
          aria-label="Code language"
          list="dxe-code-langs"
          readOnly={ro}
          size={Math.max(8, language.length + 1)}
          onChange={(e) => updateAttributes({ language: e.target.value.trim() || null })}
        />
        <button type="button" className={cx("dxe-code__wrap", wrap && "dxe-code__wrap--on")} aria-pressed={wrap} disabled={ro} onClick={() => updateAttributes({ meta: setMetaWrap(meta, !wrap) })} title="Wrap long lines">
          <Icon name="wrap" />
          <span className="dxe-sr">Wrap long lines</span>
        </button>
      </div>
      <div className="md-codeblock__body" hidden={showDiagram}>
        <pre className="md-codeblock__pre">
          <NodeViewContent<"code"> as="code" className={language ? `language-${language}` : undefined} />
        </pre>
      </div>
      {mermaid && (
        <div
          contentEditable={false}
          className={cx("dxe-mermaid__view", editing && "dxe-mermaid__view--live", showDiagram && !ro && "dxe-mermaid__view--edit")}
          onClick={showDiagram ? onDiagramClick : undefined}
          title={showDiagram && !ro ? "Click to edit the diagram" : undefined}
        >
          {!settled.trim() ? (
            <div className="dxe-mermaid__empty dxe-muted">{editing ? "Type a Mermaid diagram, e.g. graph TD then A --> B" : ro ? "An empty Mermaid diagram" : "An empty Mermaid diagram. Click to write it."}</div>
          ) : (
            <Suspense fallback={<DiagramLoading />}>
              <LazyDiagram
                code={settled}
                // The same frame (renderer, config, theme) as the reader. Read only, it's the reader's
                // exactly; editing, the code is right above it, so no "View source".
                viewSource={ro}
                errorDetail={!ro}
                errorSource={!editing}
                tools={
                  ro ? undefined : editing ? (
                    <Button variant="ghost" size="sm" iconLeft="check" onClick={done} title="Show the diagram (Esc)">
                      <span className="md-diagram__btn-label">Done</span>
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" iconLeft="edit" onClick={edit}>
                      <span className="md-diagram__btn-label">Edit diagram</span>
                    </Button>
                  )
                }
              />
            </Suspense>
          )}
        </div>
      )}
      {host.pages && (!ro || caption) && (
        // A page's code caption (`{caption="…"}` on the line after the fence).
        <input
          contentEditable={false}
          className="dxe-codecap"
          value={caption}
          placeholder="Add a caption"
          aria-label="Code caption"
          readOnly={ro}
          onChange={(e) => updateAttributes({ battrs: cleanAttrs({ ...(battrs ?? {}), caption: e.target.value.replace(/"/g, "”").replace(/[\r\n]+/g, " ") || null }) })}
        />
      )}
    </NodeViewWrapper>
  );
}

/* ── mermaid ─────────────────────────────────────────────────────────────── */

const MERMAID = "mermaid";

// The reader's DiagramFrame (lazy mermaid inside): its own chunk, loaded only when a page has a
// mermaid block, so neither it nor mermaid is in the editor's first load.
const LazyDiagram = lazy(() => import("@/components/reading/DiagramFrame").then((m) => ({ default: m.DiagramFrame })));

function DiagramLoading() {
  return (
    <div className="md-diagram__loading">
      <Skeleton variant="rect" width="100%" height={180} />
      <span className="md-diagram__loading-text">Rendering diagram</span>
    </div>
  );
}

/** `value`, or with `ms` > 0 the value once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!ms) return setSettled(value);
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return ms ? settled : value;
}

/**
 * Whether the editor (or a field inside this node view, like the code's title) has focus. Only
 * listens while `on`, and only re-renders when the answer changes (not on keystrokes).
 */
function useFocusWithin(editor: Editor, ref: React.RefObject<HTMLElement | null>, on: boolean): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!on) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const active = document.activeElement;
      setFocused(editor.view.hasFocus() || !!(active && ref.current?.contains(active)));
    };
    // On blur, activeElement is the body until the next element takes focus.
    const later = () => {
      clearTimeout(t);
      t = setTimeout(update, 0);
    };
    update();
    const el = ref.current;
    editor.on("focus", update);
    editor.on("blur", later);
    el?.addEventListener("focusin", update);
    el?.addEventListener("focusout", later);
    return () => {
      clearTimeout(t);
      editor.off("focus", update);
      editor.off("blur", later);
      el?.removeEventListener("focusin", update);
      el?.removeEventListener("focusout", later);
    };
  }, [editor, ref, on]);
  return on && focused;
}

const isMermaid = (n: { type: { name: string }; attrs: Record<string, unknown> } | null | undefined) => n?.type.name === "codeBlock" && n.attrs.language === MERMAID;

/** Whether the caret (a text selection) is in the code of the block at `pos`. */
function caretIn(editor: Editor, pos: number | undefined): boolean {
  if (typeof pos !== "number") return false;
  const node = editor.state.doc.nodeAt(pos);
  const sel = editor.state.selection;
  return !!node && sel instanceof TextSelection && sel.from > pos && sel.to < pos + node.nodeSize;
}

/** Puts the caret at the end of the mermaid block at `pos` (its code shows). */
function openMermaid(editor: Editor, pos: number | undefined): boolean {
  if (typeof pos !== "number" || !editor.isEditable) return false;
  const node = editor.state.doc.nodeAt(pos);
  if (!isMermaid(node)) return false;
  const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + node!.nodeSize - 1)).scrollIntoView();
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** Selects the mermaid block at `pos` as a block (its diagram shows; Enter edits it again). */
function closeMermaid(editor: Editor, pos: number | undefined): boolean {
  if (typeof pos !== "number") return false;
  if (!isMermaid(editor.state.doc.nodeAt(pos))) return false;
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
  editor.view.focus();
  return true;
}

/**
 * Mermaid keys (ahead of the page's own Escape): Esc in a mermaid block's code shows the diagram
 * (the block stays selected); Enter on a selected mermaid block edits it again.
 */
export const mermaidKeys = (editor: Editor): Record<string, () => boolean> => ({
  Escape: () => {
    const { selection } = editor.state;
    if (!(selection instanceof TextSelection) || !isMermaid(selection.$from.parent) || selection.$from.parent !== selection.$to.parent) return false;
    return closeMermaid(editor, selection.$from.before());
  },
  Enter: () => {
    const { selection } = editor.state;
    if (!(selection instanceof NodeSelection) || !isMermaid(selection.node)) return false;
    return openMermaid(editor, selection.from);
  },
});

/** The language list offered by the code block's language field (any value is allowed). */
export const CODE_LANGS = ["bash", "shell", "powershell", "json", "yaml", "toml", "javascript", "typescript", "jsx", "tsx", "python", "go", "rust", "java", "kotlin", "swift", "ruby", "php", "c", "cpp", "csharp", "sql", "html", "css", "markdown", "diff", "http", "graphql", "mermaid", "text"];

/* ── math ────────────────────────────────────────────────────────────────── */

type Katex = { renderToString: (tex: string, opts: Record<string, unknown>) => string };
let katexP: Promise<Katex> | null = null;
const loadKatex = () => (katexP ??= import("katex").then((m) => (m.default ?? m) as unknown as Katex));

function useKatex(tex: string, display: boolean) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!tex.trim()) {
      setHtml(null);
      return;
    }
    loadKatex()
      .then((k) => {
        if (live) setHtml(k.renderToString(tex, { displayMode: display, throwOnError: false, errorColor: "var(--danger)" }));
      })
      .catch(() => live && setHtml(null));
    return () => {
      live = false;
    };
  }, [tex, display]);
  return html;
}

export function MathBlockView({ node }: ReactNodeViewProps) {
  const html = useKatex(node.textContent, true);
  return (
    <NodeViewWrapper className="dxe-block dxe-math">
      <div contentEditable={false} className="dxe-math__head">
        <Icon name="sigma" /> Math <span className="dxe-muted">LaTeX</span>
      </div>
      <pre className="dxe-math__src">
        <NodeViewContent<"code"> as="code" />
      </pre>
      <div contentEditable={false} className="dxe-math__preview" aria-label="Preview" dangerouslySetInnerHTML={html ? { __html: html } : undefined}>
        {html ? undefined : <span className="dxe-muted">Type a formula, e.g. E = mc^2</span>}
      </div>
    </NodeViewWrapper>
  );
}

export function InlineMathView({ node, updateAttributes, selected }: ReactNodeViewProps) {
  const host = useHost();
  const value = node.attrs.value as string;
  const html = useKatex(value, false);
  const [edit, setEdit] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (edit) ref.current?.focus();
  }, [edit]);
  return (
    <NodeViewWrapper as="span" className={cx("dxe-imath", selected && "dxe-selected")}>
      {edit ? (
        <input
          ref={ref}
          className="dxe-imath__input"
          value={value}
          size={Math.max(4, value.length + 1)}
          aria-label="Inline math (LaTeX)"
          onChange={(e) => updateAttributes({ value: e.target.value })}
          onBlur={() => setEdit(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              setEdit(false);
            }
          }}
        />
      ) : (
        <button type="button" className="dxe-imath__show" onClick={() => !host.readOnly && setEdit(true)} aria-label={`Math: ${value}. Edit`}>
          {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <code>${value}$</code>}
        </button>
      )}
    </NodeViewWrapper>
  );
}

/* ── raw ─────────────────────────────────────────────────────────────────── */

function rawKind(value: string): string {
  const v = value.trimStart();
  if (/^<!--/.test(v)) return "HTML comment";
  if (/^</.test(v)) return "HTML";
  if (/^\[\^[^\]]+\]:/.test(v)) return "Footnote";
  if (/^\[[^\]]+\]:/.test(v)) return "Link definition";
  const d = /^(:{2,})([A-Za-z][\w-]*)/.exec(v);
  if (d) return `${d[1].length === 2 ? "::" : ":::"}${d[2]} block`;
  return "Markdown";
}

export function RawBlockView({ node, selected }: ReactNodeViewProps) {
  const host = useHost();
  const value = node.attrs.value as string;
  return (
    <NodeViewWrapper className={cx("dxe-block dxe-raw", selected && "dxe-selected")} data-drag-handle="">
      <div contentEditable={false} className="dxe-raw__head">
        <Badge size="sm" icon="code">
          {rawKind(value)}
        </Badge>
        <span className="dxe-muted">Kept exactly as written. Edit it in Markdown mode.</span>
        {host.toMarkdown && !host.readOnly && (
          <Button size="sm" variant="ghost" onClick={host.toMarkdown}>
            Edit as Markdown
          </Button>
        )}
      </div>
      <pre contentEditable={false} className="dxe-raw__src">
        {value}
      </pre>
    </NodeViewWrapper>
  );
}
