"use client";

/**
 * Code-like blocks: fenced code (language, title and wrap edit the fence's meta, nothing else in
 * it), math with a live KaTeX preview, inline math, and raw blocks (Markdown the visual editor
 * keeps verbatim).
 */
import { useEffect, useRef, useState } from "react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Badge, Button, Icon } from "@/components/ui";
import { readMeta, setMetaTitle, setMetaWrap } from "../core/fence.mjs";
import { useHost } from "../host";
import { cx } from "./shared";

export function CodeBlockView({ node, updateAttributes }: ReactNodeViewProps) {
  const host = useHost();
  const language = (node.attrs.language as string | null) ?? "";
  const meta = node.attrs.meta as string | null;
  const { title, wrap } = readMeta(meta);
  const ro = host.readOnly;
  return (
    <NodeViewWrapper className={cx("md-codeblock not-prose dxe-code", title && "dx-code--titled", wrap && "dx-code--wrap")} data-lang={language || undefined}>
      <div contentEditable={false} className="md-codeblock__head dxe-code__head">
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
      <div className="md-codeblock__body">
        <pre className="md-codeblock__pre">
          <NodeViewContent<"code"> as="code" className={language ? `language-${language}` : undefined} />
        </pre>
      </div>
    </NodeViewWrapper>
  );
}

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
