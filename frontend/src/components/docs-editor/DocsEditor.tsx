"use client";

/**
 * <DocsEditor>: a docs page as Markdown in, Markdown out, edited visually (blocks, slash menu,
 * format toolbar, drag handles) or as plain Markdown. The visual editor (TipTap + the Markdown
 * converter) is a separate chunk loaded on first use; Markdown mode is a plain textarea.
 */
import "./docs-editor.css";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { SegmentedControl, Skeleton } from "@/components/ui";
import { splitFrontmatter } from "./core/frontmatter.mjs";
import { PageHeader } from "./PageHeader";
import type { DocsEditorProps, EditorMode } from "./types";

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

function MarkdownSource({ value, onChange, readOnly, placeholder, label }: { value: string; onChange: (v: string) => void; readOnly?: boolean; placeholder?: string; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 320)}px`;
  }, [value]);
  return (
    <div className="dxe-source">
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
      <p className="dxe-source__note">The same page as Markdown. Switch back any time; nothing is lost.</p>
    </div>
  );
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
  "aria-label": ariaLabel = "Page content",
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

  return (
    <div className={["dxe-root", className].filter(Boolean).join(" ")} data-mode={mode}>
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
      {mode === "visual" ? (
        <>
          {showHeader && <PageHeader front={front} onFront={onFront} readOnly={readOnly} />}
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
            aria-label={ariaLabel}
          />
        </>
      ) : (
        <MarkdownSource value={value} onChange={onChange} readOnly={readOnly} placeholder={placeholder} label={`${ariaLabel} (Markdown)`} />
      )}
    </div>
  );
}

export default DocsEditor;
