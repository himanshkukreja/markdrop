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
import "./menus/ai.css";
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
import { PeopleMenu, PeopleStore, closePeople, openPeopleAt } from "./menus/people";
import { FormatToolbar } from "./menus/FormatToolbar";
import { BlockHandle } from "./menus/BlockHandle";
import { TableBar } from "./menus/TableBar";
import { markdownSlice, sliceMarkdown } from "./menus/markdownSlice";
import { createAnnotations, refreshAnnotations, type AnnotationSource } from "./menus/annotations";
import { AssistPanel, AssistStore } from "./menus/assist";
import { AiSheet } from "./menus/aiSheet";
import { useAltText } from "./menus/aiAlt";
import type { AiHooks } from "./menus/aiKeys";
import { PasteController, PasteMenu } from "./menus/PasteMenu";
import type { VisualHandle } from "./FindBar";
import { CODE_LANGS } from "./views/code";
import { BlockMarquee, SelectionBar, TouchBar, useEditorAnchor } from "./menus/BlockTools";
import { insertColumns } from "./menus/columns";
import { blockDropAt } from "./menus/dnd";
import { services, uploadMedia } from "./menus/mediaUpload";
import type { ApiOperationOption, AssistFn, CommentMark, EditorAi, TextAnchor, UploadImage, MarkdropFilesHost, PagesEditorHost } from "./types";

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
  ai?: EditorAi | null;
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

// The Markdown goes to the host after a pause in typing (the host re-reads it: refs, autosave, a
// local draft), not after every key; leaving, hiding the tab and blur flush it at once.
const EMIT_DELAY = 300;
const identity = (s: string) => s;

export default function VisualEditor(props: VisualEditorProps) {
  const { value, readOnly = false, placeholder, onUploadImage, operations, accessRules, resolveAssetUrl, autoFocus, onRequestMarkdown, onReady, stickyTop, onHandle, assist, assistLanguages, ai = null, onComment, comments, onCommentClick, checkLink, flagImages = false, markdrop, blocks, pages, darkImages } = props;
  const toast = useToast();
  const initial = useMemo(() => parseMarkdown(value), []); // eslint-disable-line react-hooks/exhaustive-deps -- parsed once; later values are synced below
  const meta = useRef<DocState>(initial);
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const uploadWithAlt = useMemo<UploadImage | undefined>(() => (onUploadImage ? async (file, info) => {
    const r = await onUploadImage(file, info);
    if (info.variant === "light") altText.uploaded(typeof r === "string" ? r : r.url, file.name);
    return r;
  } : undefined), [onUploadImage]); // eslint-disable-line react-hooks/exhaustive-deps
  const uploadRef = useRef(uploadWithAlt);
  uploadRef.current = uploadWithAlt;
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
  assistStore.ai = ai;
  assistStore.legacy = assist;
  // Images: an upload with AI available gets a suggested description (menus/aiAlt.ts).
  const altText = useAltText(ai?.altText);
  altText.altText = ai && !ai.off ? ai.altText : undefined;
  const paste = useMemo(() => new PasteController(`${listboxId.replace(/-slash$/, "")}-paste`), []); // eslint-disable-line react-hooks/exhaustive-deps
  Object.assign(paste, { pages, upload: uploadWithAlt });
  // A page: Notion-style keys, Markdown shortcuts and the `:emoji` menu.
  const emoji = useMemo(() => (pages ? { store: new SlashStore(), listboxId: `${listboxId.replace(/-slash$/, "")}-emoji` } : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // A page: the `@` people picker; its members are fetched once for this editor and kept.
  const people = useMemo(() => (pages ? { store: new PeopleStore(), listboxId: `${listboxId.replace(/-slash$/, "")}-people` } : null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (people) people.store.fetcher = pages?.mentionable ? () => pages.mentionable!() : null;
  const extensions = useMemo(() => [...buildExtensions({ slash, listboxId, placeholder, blocks, emoji, people }), createAnnotations(source)], []); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Touch screens: the same at the bottom, where the toolbar riding the keyboard (a page's, or the
      // touch "Blocks" bar) would cover a caret ProseMirror thinks is on screen.
      handleScrollToSelection: (view) => {
        const covered = stickyTopRef.current?.() ?? 0;
        let rect: { top: number; bottom: number };
        try { rect = view.coordsAtPos(view.state.selection.head); } catch { return false; }
        const bar = document.querySelector<HTMLElement>(".pb-phonebar[data-on], .dxe-touchbar");
        if (bar) {
          const vv = window.visualViewport;
          const floor = Math.min(bar.getBoundingClientRect().top, vv ? vv.offsetTop + vv.height : window.innerHeight) - 16;
          if (rect.bottom > floor && rect.top > covered + 16) {
            window.scrollBy(0, rect.bottom - floor);
            return true;
          }
        }
        if (!covered) return false;
        const min = covered + 16;
        if (rect.top >= min) return false; // in view, or below it: ProseMirror's own scrolling
        window.scrollBy(0, rect.top - min);
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
        const { clientX: x, clientY: y } = event as DragEvent;
        // Between the blocks the drop line showed (dnd.ts), else at the point.
        const at = blockDropAt(view, x, y)?.pos ?? view.posAtCoords({ left: x, top: y })?.pos;
        void insertImages(files, at ?? view.state.selection.from);
        return true;
      },
    },
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
      onReady?.(e);
      onHandleRef.current?.({ editor: e, source, assist: assistStore, flush: emit });
    },
    onUpdate: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(emit, EMIT_DELAY);
    },
    onBlur: ({ editor: e }) => {
      // The `@` picker closes when the page loses focus (its rows keep focus in the page).
      if (people) closePeople(e);
      emit();
    },
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
    () => ({ upload: uploadWithAlt, resolveAsset: resolveAssetUrl ?? identity, operations: operations ?? [], readOnly, toMarkdown: onRequestMarkdown, assist, assistLanguages, ai, onComment, accessRules, markdrop, pages, darkImages, blocks }),
    [uploadWithAlt, resolveAssetUrl, operations, readOnly, onRequestMarkdown, assist, assistLanguages, ai, onComment, accessRules, markdrop, pages, darkImages, blocks],
  );

  // What blocks need from the host (slash items, uploads), on the editor's storage.
  useEffect(() => {
    if (!editor) return;
    const s = services(editor);
    s.pages = pages;
    s.toast = { success: (m) => toast.success(m), error: (m) => toast.error(m), info: (m) => toast.info?.(m) };
    Object.assign(s, {
      insertColumns: (e: Editor, n: number, r: { from: number; to: number }) => insertColumns(e, n, r),
      uploadMedia,
      // "/emoji": a ":" that opens the emoji menu with its first few before anything is typed.
      openEmoji: (e: Editor, r: { from: number; to: number }) => {
        if (!emoji) return;
        emoji.store.force = true;
        e.chain().focus().deleteRange(r).insertContent(":").run();
      },
      // "/person": an `@` that opens the people picker.
      openPeople: people ? (e: Editor, r: { from: number; to: number }) => openPeopleAt(e, people.store, r) : undefined,
    });
  }, [editor, pages, toast]);
  useEditorAnchor(pages ? editor : null);
  useEffect(() => {
    altText.attach(editor ?? null);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // AI's keys and "/" commands (menus/aiKeys.ts, blocks.ts AI_ITEMS) reach the store through the
  // editor's storage; the empty line's placeholder follows whether AI is on.
  useEffect(() => {
    if (!editor) return;
    const st = editor.storage as unknown as { dxeAi?: AiHooks; docsAiMenu?: { open?: () => boolean } };
    const usable = !!ai || !!assist;
    st.dxeAi = usable
      ? {
          on: !!ai && !ai.off,
          space: !!pages && !!ai?.write,
          menu: () => st.docsAiMenu?.open?.() ?? false,
          prompt: () => {
            if (!ai) return false;
            if (ai.off) return st.docsAiMenu?.open?.() ?? false;
            return assistStore.openPrompt(editor);
          },
          busy: () => assistStore.busy,
          pick: (p) => {
            if ("command" in p) assistStore.actions(editor, "selection");
            else assistStore.start(editor, p.action, { tone: p.tone, lang: p.lang });
          },
        }
      : undefined;
    services(editor).ai = ai && !ai.off
      ? (e: Editor, r: { from: number; to: number }, command: "write" | "actions" | "summary") => {
          if (command === "write") return void assistStore.openPrompt(e, r);
          e.chain().focus().deleteRange(r).run();
          if (command === "actions") assistStore.actions(e, "line");
          else assistStore.summary(e);
        }
      : undefined;
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  }, [editor, ai, assist, pages, assistStore]);

  return (
    <EditorHostContext.Provider value={host}>
      <div ref={wrap} className="dxe-visual" data-readonly={readOnly ? "" : undefined}>
        {/* ph-no-capture: the page being written is never recorded. */}
        <EditorContent editor={editor} className="ph-no-capture dxe-surface" />
        {editor && !readOnly && (
          <>
            <FormatToolbar editor={editor} stickyTop={stickyTop} assist={assistStore} />
            <AssistPanel editor={editor} store={assistStore} container={wrap} />
            {(ai || assist) && <AiSheet editor={editor} store={assistStore} />}
            <BlockHandle editor={editor} container={wrap} />
            {pages && (
              <>
                <SelectionBar editor={editor} />
                <BlockMarquee editor={editor} container={wrap} />
                <TouchBar editor={editor} />
              </>
            )}
            <TableBar editor={editor} container={wrap} />
            <PasteMenu editor={editor} paste={paste} stickyTop={stickyTop} />
            <SlashMenu store={slash} listboxId={listboxId} stickyTop={stickyTop} />
            {emoji && <SlashMenu store={emoji.store} listboxId={emoji.listboxId} stickyTop={stickyTop} label="Insert an emoji" />}
            {people && <PeopleMenu store={people.store} listboxId={people.listboxId} />}
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
