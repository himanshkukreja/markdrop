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
import type { EditorView } from "@tiptap/pm/view";
import { useToast } from "@/components/ui";
import { parseMarkdown, serializeMarkdown, type DocState } from "./core/markdown.mjs";
import { splitFrontmatter } from "./core/frontmatter.mjs";
import { buildExtensions } from "./extensions";
import { EditorHostContext, uploadUrl, type EditorHost } from "./host";
import { SlashMenu, SlashStore } from "./menus/slash";
import { FormatToolbar } from "./menus/FormatToolbar";
import { BlockHandle } from "./menus/BlockHandle";
import { TableBar } from "./menus/TableBar";
import { markdownSlice, sliceMarkdown } from "./menus/markdownSlice";
import { createAnnotations, refreshAnnotations, type AnnotationSource } from "./menus/annotations";
import { AssistPanel, AssistStore } from "./menus/assist";
import { PasteController, PasteMenu } from "./menus/PasteMenu";
import type { VisualHandle } from "./FindBar";
import { CODE_LANGS } from "./views/code";
import type { ApiOperationOption, AssistFn, CommentMark, TextAnchor, UploadImage, MarkdropFilesHost, PagesEditorHost } from "./types";

export interface VisualEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  onUploadImage?: UploadImage;
  operations?: ApiOperationOption[];
  accessRules?: Array<{ id: string; name: string; kind: string }>;
  resolveAssetUrl?: (src: string) => string;
  autoFocus?: boolean;
  /** Switches the host to Markdown mode (raw blocks offer it). */
  onRequestMarkdown?: () => void;
  "aria-label"?: string;
  /** Receives the editor once it exists (tests, host toolbars). */
  onReady?: (editor: Editor) => void;
  /** See DocsEditorProps.stickyTop. */
  stickyTop?: () => number;
  /** Receives the editor and its annotation source once both exist (Find, reveal), null on unmount. */
  onHandle?: (h: VisualHandle | null) => void;
  assist?: AssistFn;
  assistLanguages?: string[];
  onComment?: (anchor: TextAnchor) => void;
  comments?: CommentMark[];
  onCommentClick?: (id: string) => void;
  checkLink?: (href: string) => { message: string } | null;
  flagImages?: boolean;
  markdrop?: MarkdropFilesHost;
  blocks?: readonly string[];
  pages?: PagesEditorHost;
  darkImages?: boolean;
}

const EMIT_DELAY = 120;
const identity = (s: string) => s;

export default function VisualEditor(props: VisualEditorProps) {
  const { value, readOnly = false, placeholder, onUploadImage, operations, accessRules, resolveAssetUrl, autoFocus, onRequestMarkdown, onReady, stickyTop, onHandle, assist, assistLanguages, onComment, comments, onCommentClick, checkLink, flagImages = false, markdrop, blocks, pages, darkImages } = props;
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
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const slash = useMemo(() => new SlashStore(), []);
  const listboxId = `dxe${useId().replace(/[^a-zA-Z0-9]/g, "")}-slash`;
  // What the annotations plugin paints (find, problems, comments): read on every recompute.
  const source = useMemo<AnnotationSource>(() => ({ find: null, flagImages, comments: comments ?? [], checkLink, onCommentClick }), []); // eslint-disable-line react-hooks/exhaustive-deps
  source.onCommentClick = onCommentClick;
  const assistStore = useMemo(() => new AssistStore(), []);
  const paste = useMemo(() => new PasteController(`${listboxId.replace(/-slash$/, "")}-paste`), []); // eslint-disable-line react-hooks/exhaustive-deps
  Object.assign(paste, { pages, upload: onUploadImage });
  // A page: Notion-style keys, Markdown shortcuts and the `:emoji` menu.
  const emoji = useMemo(() => (pages ? { store: new SlashStore(), listboxId: `${listboxId.replace(/-slash$/, "")}-emoji` } : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const extensions = useMemo(() => [...buildExtensions({ slash, listboxId, placeholder, blocks, emoji }), createAnnotations(source)], []); // eslint-disable-line react-hooks/exhaustive-deps

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
      transformPastedHTML: (html) => paste.html(html),
      transformPasted: (slice) => paste.slice(slice),
      transformPastedText: (text, plain) => paste.text(text, plain),
      handleKeyDown: (view, event) => paste.keyDown(view, event),
      handlePaste: (view, event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length || !uploadRef.current) return paste.handle(view, event);
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
      onHandleRef.current?.({ editor: e, source, assist: assistStore });
    },
    onUpdate: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(emit, EMIT_DELAY);
    },
    onBlur: () => emit(),
  });

  // Flush on unmount (mode switch, navigation) so nothing typed is lost, and when the tab goes
  // away or is hidden (a reload, a closed tab: the host keeps a local copy of what it's told).
  useEffect(() => () => emit(), [emit]);
  useEffect(() => {
    const flush = () => emit();
    const hidden = () => {
      if (document.visibilityState === "hidden") emit();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [emit]);
  useEffect(() => () => onHandleRef.current?.(null), []);

  // The host's problems and comments changed: repaint.
  useEffect(() => {
    source.checkLink = checkLink;
    source.flagImages = flagImages;
    source.comments = comments ?? [];
    if (editor) refreshAnnotations(editor);
  }, [editor, source, checkLink, flagImages, comments]);

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
    () => ({ upload: onUploadImage, resolveAsset: resolveAssetUrl ?? identity, operations: operations ?? [], readOnly, toMarkdown: onRequestMarkdown, assist, assistLanguages, onComment, accessRules, markdrop, pages, darkImages }),
    [onUploadImage, resolveAssetUrl, operations, readOnly, onRequestMarkdown, assist, assistLanguages, onComment, accessRules, markdrop, pages, darkImages],
  );

  return (
    <EditorHostContext.Provider value={host}>
      <div ref={wrap} className="dxe-visual" data-readonly={readOnly ? "" : undefined}>
        {/* ph-no-capture: the page being written is never recorded. */}
        <EditorContent editor={editor} className="ph-no-capture dxe-surface" />
        {editor && !readOnly && (
          <>
            <FormatToolbar editor={editor} stickyTop={stickyTop} assist={assistStore} />
            <AssistPanel editor={editor} store={assistStore} assist={assist} container={wrap} />
            <BlockHandle editor={editor} container={wrap} />
            <TableBar editor={editor} container={wrap} />
            <PasteMenu editor={editor} paste={paste} stickyTop={stickyTop} />
            <SlashMenu store={slash} listboxId={listboxId} stickyTop={stickyTop} />
            {emoji && <SlashMenu store={emoji.store} listboxId={emoji.listboxId} stickyTop={stickyTop} label="Insert an emoji" />}
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
