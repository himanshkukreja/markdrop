"use client";

import { useEffect, useState } from "react";
import { Textarea } from "@/components/ui";

export type EditorMode = "visual" | "markdown";

/** The contract of the docs editor component (frontend/src/components/docs-editor, built separately). */
export interface DocsEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  mode: EditorMode;
  onModeChange?: (mode: EditorMode) => void;
  /** Uploads an image or file and resolves to the URL to put in the Markdown. */
  onUploadImage?: (file: File) => Promise<string>;
  readOnly?: boolean;
}

type EditorComponent = React.ComponentType<DocsEditorProps>;
type LazyContext = { keys(): string[]; (key: string): Promise<Record<string, unknown>> };

/**
 * The editor component lives in its own folder and may not be in this build yet. A webpack lazy
 * context is empty when the folder is missing (no build error), and becomes a separate chunk when
 * it's there, so the studio works either way: with it, the visual + Markdown editor; without it, a
 * Markdown textarea.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Require {
      /** webpack's compile-time context (it must be written literally as `require.context(…)`). */
      context(dir: string, deep: boolean, re: RegExp, mode: "lazy"): LazyContext;
    }
  }
}

const editorContext: LazyContext | null = (() => {
  try {
    return require.context("../../docs-editor", false, /^\.\/index\.tsx?$/, "lazy");
  } catch {
    return null;
  }
})();

let loaded: Promise<EditorComponent | null> | null = null;

function loadEditor(): Promise<EditorComponent | null> {
  if (loaded) return loaded;
  const key = editorContext?.keys()[0];
  loaded = key
    ? editorContext!(key)
        .then((m) => ((m.DocsEditor ?? m.default) as EditorComponent | undefined) ?? null)
        .catch(() => null)
    : Promise.resolve(null);
  return loaded;
}

/** Whether the visual editor exists in this build (null while that's being found out). */
export function useEditorAvailable(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void loadEditor().then((C) => live && setOk(!!C));
    return () => { live = false; };
  }, []);
  return ok;
}

/** The fallback: plain Markdown in a textarea that grows with the text. */
function MarkdownTextarea({ value, onChange, readOnly, label }: { value: string; onChange: (v: string) => void; readOnly?: boolean; label: string }) {
  return (
    <Textarea
      mono
      aria-label={label}
      value={value}
      readOnly={readOnly}
      spellCheck
      onChange={(e) => onChange(e.target.value)}
      className="min-h-[60vh] w-full resize-y text-[13.5px] leading-[22px]"
    />
  );
}

export function EditorMount(props: DocsEditorProps & { label: string }) {
  const [Editor, setEditor] = useState<EditorComponent | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadEditor().then((C) => live && setEditor(() => C));
    return () => { live = false; };
  }, []);

  if (Editor === undefined) return <div className="min-h-[60vh]" aria-busy="true" />;
  if (!Editor) return <MarkdownTextarea value={props.value} onChange={props.onChange} readOnly={props.readOnly} label={props.label} />;
  const { label: _label, ...rest } = props;
  return <Editor {...rest} />;
}

export default EditorMount;
