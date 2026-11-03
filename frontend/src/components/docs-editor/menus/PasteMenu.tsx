"use client";

/**
 * Paste, the editor side (the rules are in paste.ts):
 *
 *  - a link pasted on its own, in a page, goes in as a link right away and a small menu opens at
 *    it: Link (keep it), Mention, Bookmark, Embed. Focus stays in the page: arrows and Enter pick,
 *    Esc closes, and typing, clicking elsewhere or leaving the page keeps the link and closes it;
 *  - HTML from other apps is normalised before ProseMirror reads it (`html`);
 *  - Markdown from other tools (VS Code, Notion when its HTML lost the to-dos) is read as Markdown;
 *  - images pasted inside HTML or Markdown are uploaded (pasteImages.ts).
 *
 * VisualEditor creates one PasteController and hooks it into `transformPastedHTML`,
 * `transformPastedText`, `handlePaste` and `handleKeyDown`, and renders <PasteMenu>.
 */
import "./paste.css";
import type { Editor } from "@tiptap/core";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon, useToast } from "@/components/ui";
import { parseBlocks } from "../core/markdown.mjs";
import { cx } from "../views/shared";
import type { PageResolvedItem, PagesEditorHost, UploadImage } from "../types";
import { markdownSlice } from "./markdownSlice";
import { bareUrl, normalizePastedHTML, pasteMarkdown, pasteTargets, pickSource, type PasteTarget, type PasteTargetId } from "./paste";
import { watchPastedImages } from "./pasteImages";

interface MenuState {
  open: boolean;
  url: string;
  slug: string | null;
  from: number;
  to: number;
  items: PasteTarget[];
  index: number;
}

const CLOSED: MenuState = { open: false, url: "", slug: null, from: 0, to: 0, items: [], index: 0 };
const OWN = "docsPasteMenu";
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "Hyper", "Super", "OS"]);

const clean = (s: string) => s.replace(/[[\]\\\n\r]+/g, " ").replace(/\s+/g, " ").trim();

/** Whether ProseMirror's own Markdown reads the address back as the same bare link (`https://x.com/a.` doesn't). */
function literalOk(url: string): boolean {
  try {
    const b = parseBlocks(url, { verify: true }) as Array<{ type: string; content?: Array<{ text?: string; marks?: Array<{ type: string; attrs?: { href?: string } }> }> }>;
    const kids = b.length === 1 && b[0].type === "paragraph" ? b[0].content ?? [] : [];
    return kids.length === 1 && kids[0].text === url && kids[0].marks?.some((m) => m.type === "link" && m.attrs?.href === url) === true;
  } catch {
    return false;
  }
}

/**
 * A paste that ends with a block (an image, an embed) leaves that block selected, and the next key
 * would replace it: put the caret on the line after it instead (a new one when there is none).
 * Dispatched right after the paste, so one undo still takes back both.
 */
function caretAfter(editor: Editor) {
  queueMicrotask(() => {
    if (editor.isDestroyed) return;
    const { state } = editor;
    const sel = state.selection;
    if (!(sel instanceof NodeSelection) || !sel.node.isBlock) return;
    const after = sel.to;
    const $after = state.doc.resolve(after);
    const next = $after.nodeAfter;
    const para = state.schema.nodes.paragraph;
    const tr = state.tr;
    if (next && next.isTextblock) tr.setSelection(TextSelection.create(tr.doc, after + 1));
    else if ($after.parent.canReplaceWith($after.index(), $after.index(), para)) {
      tr.insert(after, para.create());
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
    } else return;
    editor.view.dispatch(tr.scrollIntoView());
  });
}

export class PasteController {
  /** Set by the editor on every render. */
  pages?: PagesEditorHost;
  upload?: UploadImage;
  readonly menuId: string;
  private state: MenuState = CLOSED;
  private subs = new Set<() => void>();
  private editor: Editor | null = null;
  private titles = new Map<string, Promise<string | null>>();

  constructor(menuId: string) {
    this.menuId = menuId;
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  get = () => this.state;
  private set(s: MenuState) {
    this.state = s;
    this.aria();
    this.subs.forEach((f) => f());
  }

  private aria() {
    const ed = this.editor;
    if (!ed || ed.isDestroyed) return;
    const el = ed.view.dom;
    if (this.state.open) {
      el.setAttribute("aria-controls", this.menuId);
      el.setAttribute("aria-expanded", "true");
      el.setAttribute("aria-haspopup", "menu");
      el.setAttribute("aria-activedescendant", `${this.menuId}-${this.state.index}`);
    } else if (el.getAttribute("aria-controls") === this.menuId) {
      el.removeAttribute("aria-controls");
      el.removeAttribute("aria-activedescendant");
      el.setAttribute("aria-expanded", "false");
      el.setAttribute("aria-haspopup", "listbox");
    }
  }

  close = () => {
    if (this.state.open) this.set(CLOSED);
  };

  /* ── editorProps hooks ─────────────────────────────────────────────────── */

  /** transformPastedHTML. */
  html = (html: string) => {
    try {
      return normalizePastedHTML(html, { page: !!this.pages });
    } catch {
      return html;
    }
  };

  /** transformPastedText: Markdown other tools write (Notion's callouts, GitHub's alerts, details). */
  text = (text: string, plain: boolean) => (plain ? text : pasteMarkdown(text, { page: !!this.pages }));

  /** handlePaste: true when the paste was handled here. */
  handle = (view: EditorView, event: ClipboardEvent): boolean => {
    const dt = event.clipboardData;
    if (!dt) return false;
    const { state } = view;
    const { selection } = state;
    const $from = selection.$from;
    if ($from.parent.type.spec.code) return false;
    // ⇧ (paste as plain text): ProseMirror's own.
    if ((view as unknown as { input?: { shiftKey?: boolean } }).input?.shiftKey) return false;
    this.close();
    const text = dt.getData("text/plain");
    const html = dt.getData("text/html");
    const types = Array.from(dt.types ?? []);

    // A link on its own (a page): a link now, and the menu.
    const url = this.pages ? bareUrl(text, html) : null;
    const link = state.schema.marks.link;
    if (url && link && selection.empty && $from.parent.isTextblock && $from.parent.type.allowsMarkType(link)) {
      this.insertLink(view, url);
      return true;
    }

    const src = pickSource({ types, html, text, vscode: types.includes("vscode-editor-data") ? dt.getData("vscode-editor-data") : null });
    if (src.kind === "markdown" && text.trim()) {
      const slice = markdownSlice(pasteMarkdown(text, { page: !!this.pages }), state.schema, false);
      view.dispatch(state.tr.replaceSelection(slice).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
      return true;
    }
    if (src.kind === "code" && /\n/.test(text.trim())) {
      const code = state.schema.nodes.codeBlock;
      if (!code) return false;
      const body = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
      const node = code.create({ language: src.language }, state.schema.text(body));
      view.dispatch(state.tr.replaceSelectionWith(node, false).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
      return true;
    }
    if (src.kind === "code") {
      // One line of code: its text, not the editor's coloured spans.
      view.dispatch(state.tr.insertText(text.trim()).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
      return true;
    }
    return false;
  };

  /** handleKeyDown: the menu's keys while it's open (the editor keeps focus). */
  keyDown = (view: EditorView, e: KeyboardEvent): boolean => {
    const s = this.state;
    if (!s.open) return false;
    if (e.isComposing) return false;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const n = s.items.length;
      this.set({ ...s, index: (s.index + (e.key === "ArrowDown" ? 1 : -1) + n) % n });
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const it = s.items[s.index];
      if (it) this.pick(it.id);
      return true;
    }
    if (e.key === "Escape") {
      this.unlinkTyping(view);
      this.close();
      return true;
    }
    if (MODIFIERS.has(e.key)) return false;
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) this.unlinkTyping(view);
    this.close(); // anything else: the link stays, and the key does what it does
    return false;
  };

  /** What's typed right after the pasted link isn't part of it (links extend as you type). */
  private unlinkTyping(view: EditorView) {
    const { state } = view;
    const sel = state.selection;
    const link = state.schema.marks.link;
    if (!link || !sel.empty || sel.from !== this.state.to) return;
    const marks = (state.storedMarks ?? sel.$from.marks()).filter((m: Mark) => m.type !== link);
    view.dispatch(state.tr.setStoredMarks(marks).setMeta(OWN, true));
  }

  hover = (index: number) => {
    if (this.state.open && index !== this.state.index) this.set({ ...this.state, index });
  };

  /* ── the link and the menu ─────────────────────────────────────────────── */

  private insertLink(view: EditorView, url: string) {
    const { state } = view;
    const { schema } = state;
    const link = schema.marks.link;
    const around = (state.storedMarks ?? state.selection.$from.marks()).filter((m: Mark) => m.type !== link && m.type.name !== "code");
    const mark = link.create({ href: url, kind: literalOk(url) ? "literal" : "auto" });
    const from = state.selection.from;
    const tr = state.tr.replaceSelectionWith(schema.text(url, [...around, mark]), false);
    const to = from + url.length;
    tr.setSelection(TextSelection.create(tr.doc, to));
    // Typing on after it isn't part of the link.
    tr.setStoredMarks(around);
    // Not `uiEvent: paste`: the link's paste rule and autolink would make it again, as a `[text](url)` link.
    tr.scrollIntoView().setMeta("paste", true).setMeta("preventAutolink", true).setMeta(OWN, true);
    view.dispatch(tr);

    const $at = view.state.doc.resolve(from);
    const leaf = schema.nodes.directiveLeaf;
    let blockOk = false;
    if (leaf && $at.depth >= 1 && !/^table(Cell|Header)$/.test($at.parent.type.name)) {
      const parent = $at.node($at.depth - 1);
      const i = $at.index($at.depth - 1);
      blockOk = parent.canReplaceWith(i + 1, i + 1, leaf) || parent.canReplaceWith(i, i + 1, leaf);
    }
    const ownHost = typeof window !== "undefined" ? window.location.host : null;
    const { slug, items } = pasteTargets(url, { ownHost, blockOk });
    if (slug) void this.titleOf(slug);
    this.set({ open: true, url, slug, from, to, items, index: 0 });
  }

  private titleOf(slug: string): Promise<string | null> {
    let p = this.titles.get(slug);
    if (!p) {
      p = (this.pages?.resolve([slug]) ?? Promise.resolve({} as Record<string, PageResolvedItem>))
        .then((r) => {
          const it = r?.[slug];
          return it && it.state === "ok" && it.title ? clean(it.title) || null : null;
        })
        .catch(() => null);
      this.titles.set(slug, p);
    }
    return p;
  }

  /** Runs a menu item on the pasted link. */
  pick = (id: PasteTargetId) => {
    const s = this.state;
    const ed = this.editor;
    this.close();
    if (!s.open || !ed || ed.isDestroyed || id === "link") return;
    const { state } = ed;
    if (state.doc.textBetween(s.from, s.to) !== s.url) return;
    const { schema } = state;
    const tr = state.tr;
    if (id === "mention" && s.slug) {
      const slug = s.slug;
      const node = schema.nodes.mention.create({ name: "markdrop", label: slug, attributes: { src: slug } });
      tr.replaceWith(s.from, s.to, node);
      tr.setSelection(TextSelection.create(tr.doc, s.from + node.nodeSize));
      ed.view.dispatch(tr.scrollIntoView());
      // The label is the item's title (the chip itself always shows the live one).
      void this.titleOf(slug).then((title) => {
        if (title) this.updateNodes(ed, (n) => n.type.name === "mention" && n.attrs.attributes?.src === slug && n.attrs.label === slug, (n) => ({ ...n.attrs, label: title }));
      });
      return;
    }
    const leafType = schema.nodes.directiveLeaf;
    let attrs: Record<string, unknown> | null = null;
    if (id === "bookmark") attrs = { name: "bookmark", attributes: { url: s.url } };
    else if (id === "embed") attrs = s.slug ? { name: "markdrop", attributes: { src: s.slug } } : { name: "embed", attributes: { src: s.url } };
    if (!attrs || !leafType) return;
    const leaf = leafType.create(attrs);
    if (!this.placeBlock(tr, s, leaf)) return;
    ed.view.dispatch(tr.scrollIntoView());
    if (id === "bookmark") {
      const url = s.url;
      void this.pages?.linkPreview?.(url)
        .then((m) => {
          const next: Record<string, string> = { url };
          if (m?.title) next.title = m.title;
          if (m?.description) next.description = m.description.slice(0, 300);
          if (m?.image_url) next.image = m.image_url;
          if (m?.site_name) next.site = m.site_name;
          if (Object.keys(next).length > 1)
            this.updateNodes(ed, (n) => n.type.name === "directiveLeaf" && n.attrs.name === "bookmark" && n.attrs.attributes?.url === url && !n.attrs.attributes?.title, (n) => ({ ...n.attrs, attributes: next }));
        })
        .catch(() => {});
    }
  };

  /**
   * Puts a block where the link was: in place of its line when the line is only the link, else
   * just below the line (the link's text goes). The caret goes to the line after a new block.
   */
  private placeBlock(tr: Transaction, s: MenuState, leaf: PMNode): boolean {
    const $from = tr.doc.resolve(s.from);
    const d = $from.depth;
    if (d < 1) return false;
    const line = $from.parent;
    const start = $from.before(d);
    const end = $from.after(d);
    const parent = $from.node(d - 1);
    const i = $from.index(d - 1);
    const only = line.textContent.trim() === s.url && line.childCount <= 1;
    if (only && parent.canReplaceWith(i, i + 1, leaf.type)) {
      tr.replaceWith(start, end, leaf);
      const after = start + leaf.nodeSize;
      const next = tr.doc.resolve(after).nodeAfter;
      const para = tr.doc.type.schema.nodes.paragraph;
      if (next && next.type === para && next.content.size === 0) tr.setSelection(TextSelection.create(tr.doc, after + 1));
      else if (tr.doc.resolve(after).parent.canReplaceWith(tr.doc.resolve(after).index(), tr.doc.resolve(after).index(), para)) {
        tr.insert(after, para.create());
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
      }
      return true;
    }
    if (!parent.canReplaceWith(i + 1, i + 1, leaf.type)) return false;
    tr.delete(s.from, s.to);
    tr.insert(tr.mapping.map(end), leaf);
    return true;
  }

  /** Changes nodes in place, outside the undo history (a title or a preview arriving). */
  private updateNodes(ed: Editor, match: (n: PMNode) => boolean, attrs: (n: PMNode) => Record<string, unknown>) {
    if (ed.isDestroyed) return;
    const tr = ed.state.tr;
    ed.state.doc.descendants((n, pos) => {
      if (match(n)) tr.setNodeMarkup(pos, undefined, attrs(n));
      return !n.isLeaf;
    });
    if (tr.docChanged) ed.view.dispatch(tr.setMeta("addToHistory", false));
  }

  /* ── following the editor ──────────────────────────────────────────────── */

  /** Follows the editor while the menu is open, and uploads pasted images. Returns the cleanup. */
  attach(editor: Editor, onDataFailed: (n: number) => void): () => void {
    this.editor = editor;
    const onTr = ({ transaction: tr }: { transaction: Transaction }) => {
      if (tr.getMeta("uiEvent") === "paste" && tr.selection instanceof NodeSelection && tr.selection.node.isBlock) caretAfter(editor);
      const s = this.state;
      if (!s.open || tr.getMeta(OWN)) return;
      if (tr.docChanged) {
        this.close();
        return;
      }
      const sel = tr.selection;
      if (!sel.empty || sel.from < s.from || sel.from > s.to) this.close();
    };
    const onBlur = () => this.close();
    editor.on("transaction", onTr);
    editor.on("blur", onBlur);
    const stop = watchPastedImages(editor, () => this.upload, onDataFailed);
    return () => {
      editor.off("transaction", onTr);
      editor.off("blur", onBlur);
      stop();
      this.close();
      if (this.editor === editor) this.editor = null;
    };
  }
}

/** The menu at a pasted link, and the upload watcher. Render while the editor is editable. */
export function PasteMenu({ editor, paste, stickyTop }: { editor: Editor; paste: PasteController; stickyTop?: () => number }) {
  const s = useSyncExternalStore(paste.subscribe, paste.get, paste.get);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [tick, setTick] = useState(0);
  const pointer = useRef<string | null>(null);
  if (!s.open) pointer.current = null;

  useEffect(
    () =>
      paste.attach(editor, (n) =>
        toastRef.current.error(n === 1 ? "A pasted image couldn't be uploaded, so it stays in the page as data." : `${n} pasted images couldn't be uploaded, so they stay in the page as data.`),
      ),
    [editor, paste],
  );

  // Under the end of the link (above it when there's more room there), following it on scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!s.open || !el || editor.isDestroyed) {
      setPos(null);
      return;
    }
    let rect: { left: number; top: number; bottom: number };
    try {
      rect = editor.view.coordsAtPos(Math.min(s.to, editor.state.doc.content.size));
    } catch {
      return;
    }
    const h = el.offsetHeight, w = el.offsetWidth;
    const below = window.innerHeight - 8 - (rect.bottom + 6);
    const above = rect.top - 6 - ((stickyTop?.() ?? 0) + 8);
    const down = below >= h || below >= above;
    setPos({ left: Math.max(8, Math.min(rect.left - 12, window.innerWidth - w - 8)), top: down ? rect.bottom + 6 : rect.top - 6 - h });
  }, [s, tick, editor, stickyTop]);

  // Follow the link while the menu is open: scrolling, resizing, and the page moving under it
  // (a helper above the text going away once the page has content). Checked once a frame.
  useEffect(() => {
    if (!s.open) return;
    let raf = 0;
    let last = "";
    const loop = () => {
      try {
        const r = editor.view.coordsAtPos(Math.min(paste.get().to, editor.state.doc.content.size));
        const key = `${Math.round(r.left)},${Math.round(r.top)},${window.innerWidth},${window.innerHeight}`;
        if (key !== last) {
          last = key;
          setTick((t) => t + 1);
        }
      } catch {
        /* the editor is going away */
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [s.open, editor, paste]);

  if (!s.open || typeof document === "undefined") return null;
  const labelId = `${paste.menuId}-label`;
  return createPortal(
    <div
      ref={ref}
      className="dxe-paste"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}
      onMouseDown={(e) => e.preventDefault()} // keep focus (and the caret) in the page
    >
      <div className="dxe-paste__head" id={labelId}>
        Paste as
      </div>
      <div id={paste.menuId} role="menu" aria-labelledby={labelId} className="dxe-paste__list">
        {s.items.map((it, i) => (
          <div
            key={it.id}
            id={`${paste.menuId}-${i}`}
            role="menuitem"
            tabIndex={-1}
            aria-label={`${it.label}: ${it.hint}`}
            className={cx("dxe-paste__item", i === s.index && "dxe-paste__item--on")}
            onMouseMove={(e) => {
              // Only a pointer that moves picks: a menu opening under a still one (WebKit sends a
              // mousemove then) keeps its choice.
              const at = `${e.screenX},${e.screenY}`;
              if (pointer.current === null) pointer.current = at;
              else if (pointer.current !== at) paste.hover(i);
            }}
            onClick={() => paste.pick(it.id)}
          >
            <span className="dxe-paste__icon" aria-hidden>
              <Icon name={it.icon} size={15} />
            </span>
            <span className="dxe-paste__text">
              <span className="dxe-paste__label">{it.label}</span>
              <span className="dxe-paste__hint">{it.hint}</span>
            </span>
            {it.id === "link" && (
              <kbd className="dxe-paste__key" aria-hidden>
                Esc
              </kbd>
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
