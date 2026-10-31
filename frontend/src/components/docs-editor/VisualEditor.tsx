"use client";

/**
 * The visual (block) editor: TipTap over the docs Markdown. Loaded lazily by DocsEditor, so pages
 * that only show Markdown never download it.
 *
 * Markdown in, Markdown out: `value` is parsed once (core/markdown.mjs) and the document is written
 * back on every change. Unchanged blocks keep their exact source, so opening and saving a page
 * changes nothing, and an edit only rewrites the block it touched.
 */
import "@/docs/docs.css";
import "katex/dist/katex.min.css";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { Fragment, Slice, type Schema } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { useToast } from "@/components/ui";
import { parseBlocks, parseMarkdown, serializeFlow, serializeMarkdown, type DocState } from "./core/markdown.mjs";
import { splitFrontmatter } from "./core/frontmatter.mjs";
import { buildExtensions } from "./extensions";
import { EditorHostContext, uploadUrl, type EditorHost } from "./host";
import { SlashMenu, SlashStore } from "./menus/slash";
import { FormatToolbar } from "./menus/FormatToolbar";
import { BlockHandle } from "./menus/BlockHandle";
import { TableBar } from "./menus/TableBar";
import { CODE_LANGS } from "./views/code";
import type { ApiOperationOption, UploadImage } from "./types";

export interface VisualEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  onUploadImage?: UploadImage;
  operations?: ApiOperationOption[];
  resolveAssetUrl?: (src: string) => string;
  autoFocus?: boolean;
  /** Switches the host to Markdown mode (raw blocks offer it). */
  onRequestMarkdown?: () => void;
  "aria-label"?: string;
  /** Receives the editor once it exists (tests, host toolbars). */
  onReady?: (editor: Editor) => void;
  /** See DocsEditorProps.stickyTop. */
  stickyTop?: () => number;
}

const EMIT_DELAY = 120;
const identity = (s: string) => s;

/** Pasted plain text is Markdown: callouts, tables and all come in as blocks. */
function markdownSlice(text: string, schema: Schema, plain: boolean): Slice {
  if (plain) {
    const paras = text.split(/\n{2,}/).map((t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : undefined));
    return Slice.maxOpen(Fragment.from(paras));
  }
  try {
    const blocks = parseBlocks(text.replace(/\r\n?/g, "\n"), { verify: true });
    if (!blocks.length) return Slice.empty;
    return Slice.maxOpen(Fragment.fromJSON(schema, blocks));
  } catch {
    return Slice.maxOpen(Fragment.from(schema.nodes.paragraph.create(null, schema.text(text))));
  }
}

/** Copied blocks go to the clipboard's text as docs Markdown. */
function sliceMarkdown(slice: Slice): string {
  const json = slice.content.toJSON() as Array<{ type: string }> | null;
  if (!json?.length) return "";
  const inlineOnly = slice.content.childCount > 0 && slice.content.firstChild!.isInline;
  if (inlineOnly) return slice.content.textBetween(0, slice.content.size, "\n\n");
  return serializeFlow(json as never);
}

export default function VisualEditor(props: VisualEditorProps) {
  const { value, readOnly = false, placeholder, onUploadImage, operations, resolveAssetUrl, autoFocus, onRequestMarkdown, onReady, stickyTop } = props;
  const toast = useToast();
  const initial = useMemo(() => parseMarkdown(value), []); // eslint-disable-line react-hooks/exhaustive-deps -- parsed once; later values are synced below
  const meta = useRef<DocState>(initial);
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  const stickyTopRef = useRef(stickyTop);
  stickyTopRef.current = stickyTop;
  const editorRef = useRef<Editor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const slash = useMemo(() => new SlashStore(), []);
  const listboxId = `dxe${useId().replace(/[^a-zA-Z0-9]/g, "")}-slash`;
  const extensions = useMemo(() => buildExtensions({ slash, listboxId, placeholder }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const emit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const out = serializeMarkdown({ ...meta.current, doc: ed.getJSON() as never });
    if (out !== lastEmitted.current) {
      lastEmitted.current = out;
      onChangeRef.current(out);
    }
  }, []);

  /** Uploads image files and inserts them as figures at `pos` (drop, paste). */
  const insertImages = useCallback(
    async (files: File[], pos: number) => {
      const up = uploadRef.current;
      const ed = editorRef.current;
      if (!up || !ed) return;
      for (const f of files) {
        try {
          const url = await uploadUrl(up, f, { variant: "light" });
          ed.chain().focus().insertContentAt(pos, { type: "figure", attrs: { src: url, alt: f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ") } }).run();
        } catch (e) {
          toast.error(e instanceof Error && e.message ? e.message : `Couldn't upload ${f.name}.`);
        }
      }
    },
    [toast],
  );

  const imageFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));

  const editor = useEditor({
    extensions,
    content: initial.doc as never,
    editable: !readOnly,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    autofocus: autoFocus ? "start" : false,
    editorProps: {
      attributes: {
        class: "prose md-prose md-prose--reading dx-prose dxe-content",
        "aria-label": props["aria-label"] ?? "Page content",
        role: "textbox",
        "aria-multiline": "true",
        "aria-expanded": "false",
        "aria-haspopup": "listbox",
        spellcheck: "true",
      },
      // Keep the caret clear of the host's sticky bars: ProseMirror only knows the window's edges, so a
      // caret moved up to just under them counted as visible and stayed hidden behind them.
      handleScrollToSelection: (view) => {
        const covered = stickyTopRef.current?.() ?? 0;
        if (!covered) return false;
        let top: number;
        try { top = view.coordsAtPos(view.state.selection.head).top; } catch { return false; }
        const min = covered + 16;
        if (top >= min) return false; // in view, or below it: ProseMirror's own scrolling
        window.scrollBy(0, top - min);
        return true;
      },
      clipboardTextParser: (text, _ctx, plain, view: EditorView) => markdownSlice(text, view.state.schema, plain),
      clipboardTextSerializer: (slice) => sliceMarkdown(slice),
      handlePaste: (view, event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length || !uploadRef.current) return false;
        event.preventDefault();
        void insertImages(files, view.state.selection.from);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = imageFiles((event as DragEvent).dataTransfer?.files);
        if (!files.length || !uploadRef.current) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
        void insertImages(files, at?.pos ?? view.state.selection.from);
        return true;
      },
    },
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
      onReady?.(e);
    },
    onUpdate: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(emit, EMIT_DELAY);
    },
    onBlur: () => emit(),
  });

  // Flush on unmount (mode switch, navigation) so nothing typed is lost.
  useEffect(() => () => emit(), [emit]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  // A new value from outside (another version loaded, Markdown mode, the header editing the
  // frontmatter): re-read it. A frontmatter-only change keeps the document and its undo history.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    const next = parseMarkdown(value);
    const bodyOf = (s: string) => splitFrontmatter(s).body.replace(/^\s*\n/, "");
    if (bodyOf(value) === bodyOf(lastEmitted.current)) {
      meta.current = { ...meta.current, front: next.front, bom: next.bom, eol: next.eol, lead: next.empty ? meta.current.lead : next.lead };
      lastEmitted.current = value;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    meta.current = next;
    lastEmitted.current = value;
    editor.commands.setContent(next.doc as never, { emitUpdate: false });
  }, [editor, value]);

  const host: EditorHost = useMemo(
    () => ({ upload: onUploadImage, resolveAsset: resolveAssetUrl ?? identity, operations: operations ?? [], readOnly, toMarkdown: onRequestMarkdown }),
    [onUploadImage, resolveAssetUrl, operations, readOnly, onRequestMarkdown],
  );

  return (
    <EditorHostContext.Provider value={host}>
      <div ref={wrap} className="dxe-visual" data-readonly={readOnly ? "" : undefined}>
        <EditorContent editor={editor} className="dxe-surface" />
        {editor && !readOnly && (
          <>
            <FormatToolbar editor={editor} />
            <BlockHandle editor={editor} container={wrap} />
            <TableBar editor={editor} container={wrap} />
            <SlashMenu store={slash} listboxId={listboxId} stickyTop={stickyTop} />
          </>
        )}
        <datalist id="dxe-code-langs">
          {CODE_LANGS.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
      </div>
    </EditorHostContext.Provider>
  );
}
