"use client";

/**
 * The "/" menu: type a slash at the start of a line or after a space, filter by typing (fuzzy:
 * labels, aliases, descriptions), pick with ↑/↓ and Enter or Tab (or the mouse), Escape closes it.
 * Before any typing the blocks come in sections (Basic blocks, Media, Markdrop, Advanced, Inline);
 * typing ranks them. Nothing matching offers "Turn into text" (keep what was typed). Each row has
 * a tile, the label, a one-line description and its Markdown shortcut; on wide screens hovering a
 * row shows a preview card beside the menu. Focus stays in the document; the list is a listbox the
 * editor points at with aria-activedescendant.
 */
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui";
import { AI_ITEMS, BLOCK_ITEMS, GROUP_LABEL, cellItems, filterItems, type BlockItem } from "../blocks";
import { aiHooks } from "./aiKeys";
import { cx } from "../views/shared";
import { reducedMotion, usePresence } from "./motion";
import { SlashPreview } from "./slashPreview";

interface SlashState {
  open: boolean;
  items: BlockItem[];
  index: number;
  getRect: (() => DOMRect | null) | null;
  query: string;
  pick: ((item: BlockItem) => void) | null;
  /** Closes the menu and keeps what was typed (the "Turn into text" row). */
  dismiss: (() => void) | null;
}

const CLOSED: SlashState = { open: false, items: [], index: 0, getRect: null, query: "", pick: null, dismiss: null };

/** A tiny store per editor: the suggestion plugin writes, the React menu reads. */
export class SlashStore {
  state: SlashState = CLOSED;
  /** Set by a command that opens the menu with nothing typed yet (the "/emoji" block). */
  force = false;
  private subs = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  get = () => this.state;
  set(patch: Partial<SlashState>) {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((f) => f());
  }
}

export const slashKey = new PluginKey("docsSlash");
export const LISTBOX_ID_SUFFIX = "-slash";

/** The caret is in a table cell (a cell holds one line of inline content). */
export function inTableCell(editor: Editor): boolean {
  const name = editor.state.selection.$from.parent.type.name;
  return name === "tableCell" || name === "tableHeader";
}

export function SlashCommand(store: SlashStore, listboxId: string, items: BlockItem[] = BLOCK_ITEMS) {
  // AI's commands lead the menu while the editor has AI it can use (menus/aiKeys.ts). In a table
  // cell only the inline items (mentions, date, emoji…): a cell can't hold blocks.
  return SuggestMenu({
    name: "docsSlash",
    key: slashKey,
    char: "/",
    store,
    listboxId,
    find: (q, e) => {
      // Items that need a host service (e.g. "/meetings") only while it is there.
      const here = e ? items.filter((it) => !it.available || it.available(e)) : items.filter((it) => !it.available);
      if (e && inTableCell(e)) return filterItems(q, cellItems(here));
      return filterItems(q, e && aiHooks(e)?.on ? [...AI_ITEMS, ...here] : here);
    },
  });
}

export const emojiKey = new PluginKey("docsEmoji");

/**
 * A "/"-style menu for another trigger (`:` for emoji). `find` lists the items for the typed query;
 * with `minQuery`, the menu waits for that many characters (so "10:30" or "Note:" never open it)
 * unless `store.force` says a command opened it on purpose.
 */
export function SuggestMenu({ name, key, char, store, listboxId, find, minQuery = 0, allowInTables = true }: {
  name: string;
  key: PluginKey;
  char: string;
  store: SlashStore;
  listboxId: string;
  find: (query: string, editor?: Editor) => BlockItem[];
  minQuery?: number;
  allowInTables?: boolean;
}) {
  const items = { find };
  const blockMenu = char === "/";
  return Extension.create({
    name,
    // Before the keymaps, so Enter / arrows reach the menu while it is open.
    priority: 1000,
    addProseMirrorPlugins() {
      const editor = this.editor;
      const aria = (on: boolean, index = 0) => {
        const el = editor.view.dom;
        if (on) {
          el.setAttribute("aria-controls", listboxId);
          el.setAttribute("aria-expanded", "true");
          el.setAttribute("aria-activedescendant", `${listboxId}-${index}`);
        } else {
          el.removeAttribute("aria-controls");
          el.removeAttribute("aria-activedescendant");
          el.setAttribute("aria-expanded", "false");
        }
      };
      const dismiss = () => {
        store.set(CLOSED);
        aria(false);
        exitSuggestion(editor.view, key);
      };
      const show = (p: SuggestionProps<BlockItem, BlockItem>) => {
        const prev = store.get();
        // Same list (another keystroke that matched the same blocks): keep the row the reader is on.
        const same = prev.open && prev.items.length === p.items.length && prev.items.every((it, i) => it.id === p.items[i]?.id);
        const index = same ? prev.index : 0;
        store.set({ open: blockMenu || p.items.length > 0, items: p.items, index, getRect: p.clientRect ?? null, query: p.query, pick: (it) => p.command(it), dismiss });
        aria(p.items.length > 0, index);
      };
      return [
        Suggestion<BlockItem, BlockItem>({
          editor,
          pluginKey: key,
          char,
          allowSpaces: false,
          startOfLine: false,
          allowedPrefixes: [" ", " "],
          items: ({ query, editor: e }) => (query.length < minQuery && !store.force ? [] : items.find(query, e)),
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.spec.code) return false;
            return allowInTables || ($from.parent.type.name !== "tableCell" && $from.parent.type.name !== "tableHeader");
          },
          command: ({ editor: e, range, props }) => props.run(e, range),
          render: () => ({
            onStart: show,
            onUpdate: show,
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              const s = store.get();
              if (!s.open) return false;
              if (event.key === "Escape") {
                dismiss();
                return true;
              }
              if (!s.items.length) {
                // Nothing matches: Enter / Tab keep the text as typed ("Turn into text").
                if (blockMenu && (event.key === "Enter" || event.key === "Tab")) {
                  dismiss();
                  return true;
                }
                return false;
              }
              const n = s.items.length;
              const go = (index: number) => {
                store.set({ index });
                aria(true, index);
                return true;
              };
              if (event.key === "ArrowDown" || event.key === "ArrowUp") return go((s.index + (event.key === "ArrowDown" ? 1 : -1) + n) % n);
              if (event.key === "PageDown" || event.key === "PageUp") return go(Math.max(0, Math.min(n - 1, s.index + (event.key === "PageDown" ? 6 : -6))));
              if (event.key === "Enter" || event.key === "Tab") {
                const it = s.items[s.index];
                if (it) s.pick?.(it);
                return true;
              }
              return false;
            },
            onExit: () => {
              store.force = false;
              store.set(CLOSED);
              aria(false);
            },
          }),
        }),
      ];
    },
  });
}

/** Runs a block item at the cursor (the "+" button next to a block uses this). */
export function openSlashAt(editor: Editor, pos: number) {
  editor.chain().focus().insertContentAt(pos, { type: "paragraph" }).setTextSelection(pos + 1).insertContent("/").run();
}

const MAX_H = 360; // .dxe-slash__scroll max-height
const PREVIEW_W = 248;

/** One row: tile, label, description, shortcut. Moving the pointer picks it (a row scrolled under a still pointer doesn't). */
const Row = memo(function Row({ it, i, on, id, onHover, onPick }: { it: BlockItem; i: number; on: boolean; id?: string; onHover: (i: number, id: string) => void; onPick: (it: BlockItem) => void }) {
  return (
    <div id={id} role="option" aria-selected={on} className={cx("dxe-slash__opt", on && "dxe-slash__opt--on")} onMouseMove={() => onHover(i, it.id)} onClick={() => onPick(it)}>
      <Tile it={it} />
      <span className="dxe-slash__text">
        <span className="dxe-slash__label">{it.label}</span>
        <span className="dxe-slash__hint">{it.hint}</span>
      </span>
      {it.shortcut && <kbd className="dxe-slash__kbd">{it.shortcut}</kbd>}
    </div>
  );
});

function Tile({ it }: { it: BlockItem }) {
  return (
    <span className={cx("dxe-slash__icon", it.tile && "dxe-slash__icon--text")} aria-hidden>
      {it.glyph ? <span className="dxe-slash__glyph">{it.glyph}</span> : it.tile ? it.tile : <Icon name={it.icon} />}
    </span>
  );
}

export function SlashMenu({ store, listboxId, stickyTop, label = "Insert a block" }: { store: SlashStore; listboxId: string; stickyTop?: () => number; label?: string }) {
  const live = useSyncExternalStore(store.subscribe, store.get, store.get);
  const { mounted, closing } = usePresence(live.open);
  // While it fades out, the menu shows what it showed last.
  const last = useRef(live);
  if (live.open) last.current = live;
  const s = live.open ? live : last.current;
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number; up: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const block = label === "Insert a block";
  const sections = block && !s.query;

  // Below the "/" (above it when there's more room there), following it when the page scrolls. Never
  // over the host's sticky bars (stickyTop): a taller list than the room scrolls inside.
  useLayoutEffect(() => {
    const rect = live.open ? live.getRect?.() : null;
    const el = ref.current;
    const sc = scroller.current;
    if (!rect || !el || !sc) return;
    const cap = Math.min(MAX_H, window.innerHeight * 0.6);
    const h = Math.min(sc.scrollHeight + 2, cap), w = el.offsetWidth;
    const below = window.innerHeight - 8 - (rect.bottom + 6);
    const above = rect.top - 6 - ((stickyTop?.() ?? 0) + 8);
    const down = below >= h || below >= above;
    const room = Math.max(120, down ? below : above);
    const height = Math.min(h, room);
    const next = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)),
      top: down ? rect.bottom + 6 : rect.top - 6 - height,
      maxHeight: height < h ? height : undefined,
      up: !down,
    };
    setPos((p) => (p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight && p.up === next.up ? p : next));
  }, [live, tick, stickyTop]);

  useEffect(() => {
    if (!live.open) return;
    const on = () => setTick((t) => t + 1);
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
    };
  }, [live.open]);

  // A new menu: no preview until the pointer is on a row.
  useEffect(() => {
    if (!live.open) setHovered(null);
  }, [live.open]);

  // The chosen row stays in view (below the sticky section header), scrolling smoothly. Not when the
  // pointer chose it: the list doesn't move under the pointer.
  const prevIndex = useRef(-1);
  const byPointer = useRef(false);
  useEffect(() => {
    if (byPointer.current) {
      byPointer.current = false;
      prevIndex.current = s.index;
      return;
    }
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`#${CSS.escape(`${listboxId}-${s.index}`)}`);
    if (!sc || !el || !live.open) return;
    const head = sections ? 30 : 0;
    const top = el.offsetTop - head - 6;
    const bottom = el.offsetTop + el.offsetHeight + 6;
    let to: number | null = null;
    if (s.index === 0) to = 0;
    else if (top < sc.scrollTop) to = top;
    else if (bottom > sc.scrollTop + sc.clientHeight) to = bottom - sc.clientHeight;
    // A wrap from the last row to the first (or back) jumps; a step glides.
    const far = Math.abs(s.index - prevIndex.current) > 1;
    prevIndex.current = s.index;
    if (to !== null) sc.scrollTo({ top: to, behavior: far || reducedMotion() ? "auto" : "smooth" });
  }, [s.index, listboxId, live.open, sections]);

  // Stable handlers for the rows (memo: moving the highlight redraws two rows, not forty).
  const act = useRef({ hover: (_i: number, _id: string) => {}, pick: (_it: BlockItem) => {} });
  act.current = {
    hover: (i, id) => {
      if (store.get().index !== i) {
        byPointer.current = true;
        store.set({ index: i });
      }
      setHovered((h) => (h === id ? h : id));
    },
    pick: (it) => s.pick?.(it),
  };
  const onHover = useCallback((i: number, id: string) => act.current.hover(i, id), []);
  const onPick = useCallback((it: BlockItem) => act.current.pick(it), []);

  if (!mounted || typeof document === "undefined") return null;
  const active = s.items[s.index];
  const preview = hovered && active && block && typeof window !== "undefined" && window.innerWidth >= 1280 ? active : null;
  // Beside the menu where there's room: right, else left.
  const side = pos && ref.current ? (pos.left + ref.current.offsetWidth + 8 + PREVIEW_W <= window.innerWidth - 8 ? "right" : pos.left - 8 - PREVIEW_W >= 8 ? "left" : null) : null;

  let lastGroup: string | undefined;
  return createPortal(
    <div
      ref={ref}
      className={cx("dxe-slash dxe-pop", pos?.up && "dxe-pop--up")}
      data-closing={closing ? "" : undefined}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={(e) => e.preventDefault()} // keep focus (and the selection) in the editor
    >
      <div ref={scroller} className="dxe-slash__scroll" style={{ maxHeight: pos?.maxHeight }} onMouseLeave={() => setHovered(null)}>
        {s.items.length ? (
          <div id={live.open ? listboxId : undefined} role="listbox" aria-label={label} className="dxe-slash__list">
            {s.items.map((it, i) => {
              const group = it.group ?? "basic";
              const header = sections && group !== lastGroup ? GROUP_LABEL[group] : null;
              lastGroup = group;
              return (
                <Fragment key={it.id}>
                  {header && (
                    <div className="dxe-slash__head" role="presentation">
                      {header}
                    </div>
                  )}
                  <Row it={it} i={i} on={i === s.index} id={live.open ? `${listboxId}-${i}` : undefined} onHover={onHover} onPick={onPick} />
                </Fragment>
              );
            })}
          </div>
        ) : (
          <div className="dxe-slash__none">
            <div className="dxe-slash__head" role="status">
              No results
            </div>
            <div role="listbox" aria-label={label} className="dxe-slash__list">
              <div role="option" aria-selected className="dxe-slash__opt dxe-slash__opt--on" onClick={() => s.dismiss?.()}>
                <span className="dxe-slash__icon dxe-slash__icon--text" aria-hidden>
                  Aa
                </span>
                <span className="dxe-slash__text">
                  <span className="dxe-slash__label">Turn into text</span>
                  <span className="dxe-slash__hint">Keep “/{s.query}” as typed</span>
                </span>
                <kbd className="dxe-slash__kbd">↵</kbd>
              </div>
            </div>
          </div>
        )}
      </div>
      {preview && side && <div className={cx("dxe-slash__side", `dxe-slash__side--${side}`)}><SlashPreview item={preview} /></div>}
    </div>,
    document.body,
  );
}

export type { Range };
