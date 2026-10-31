"use client";

/**
 * The "/" menu: type a slash at the start of a line or after a space, filter by typing, pick with
 * the arrow keys and Enter (or the mouse), Escape closes it. Focus stays in the document; the list
 * is a listbox the editor points at with aria-activedescendant.
 */
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui";
import { filterItems, type BlockItem } from "../blocks";
import { cx } from "../views/shared";

interface SlashState {
  open: boolean;
  items: BlockItem[];
  index: number;
  getRect: (() => DOMRect | null) | null;
  query: string;
  pick: ((item: BlockItem) => void) | null;
}

const CLOSED: SlashState = { open: false, items: [], index: 0, getRect: null, query: "", pick: null };

/** A tiny store per editor: the suggestion plugin writes, the React menu reads. */
export class SlashStore {
  state: SlashState = CLOSED;
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

export function SlashCommand(store: SlashStore, listboxId: string) {
  return Extension.create({
    name: "docsSlash",
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
      return [
        Suggestion<BlockItem, BlockItem>({
          editor,
          pluginKey: slashKey,
          char: "/",
          allowSpaces: false,
          startOfLine: false,
          allowedPrefixes: [" ", " "],
          items: ({ query }) => filterItems(query),
          allow: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            return !$from.parent.type.spec.code && $from.parent.type.name !== "tableCell" && $from.parent.type.name !== "tableHeader";
          },
          command: ({ editor: e, range, props }) => props.run(e, range),
          render: () => ({
            onStart: (p: SuggestionProps<BlockItem, BlockItem>) => {
              store.set({ open: true, items: p.items, index: 0, getRect: p.clientRect ?? null, query: p.query, pick: (it) => p.command(it) });
              aria(p.items.length > 0, 0);
            },
            onUpdate: (p: SuggestionProps<BlockItem, BlockItem>) => {
              store.set({ items: p.items, index: 0, getRect: p.clientRect ?? null, query: p.query, pick: (it) => p.command(it) });
              aria(p.items.length > 0, 0);
            },
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              const s = store.get();
              if (!s.open) return false;
              if (event.key === "Escape") {
                store.set(CLOSED);
                aria(false);
                exitSuggestion(editor.view, slashKey);
                return true;
              }
              if (!s.items.length) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const n = s.items.length;
                const index = (s.index + (event.key === "ArrowDown" ? 1 : -1) + n) % n;
                store.set({ index });
                aria(true, index);
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                const it = s.items[s.index];
                if (it) s.pick?.(it);
                return true;
              }
              return false;
            },
            onExit: () => {
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

export function SlashMenu({ store, listboxId, stickyTop }: { store: SlashStore; listboxId: string; stickyTop?: () => number }) {
  const s = useSyncExternalStore(store.subscribe, store.get, store.get);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  const [tick, setTick] = useState(0);

  // Below the "/" (above it when there's more room there), following it when the page scrolls. Never
  // over the host's sticky bars (stickyTop): a taller list than the room scrolls inside.
  useLayoutEffect(() => {
    const rect = s.open ? s.getRect?.() : null;
    const el = ref.current;
    if (!rect || !el) return;
    const cap = Math.min(380, window.innerHeight * 0.6); // .dxe-slash max-height
    const h = Math.min(el.scrollHeight, cap), w = el.offsetWidth;
    const below = window.innerHeight - 8 - (rect.bottom + 6);
    const above = rect.top - 6 - ((stickyTop?.() ?? 0) + 8);
    const down = below >= h || below >= above;
    const room = Math.max(120, down ? below : above);
    const height = Math.min(h, room);
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)),
      top: down ? rect.bottom + 6 : rect.top - 6 - height,
      maxHeight: height < h ? height : undefined,
    });
  }, [s, tick, stickyTop]);

  useEffect(() => {
    if (!s.open) return;
    const on = () => setTick((t) => t + 1);
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
    };
  }, [s.open]);

  useEffect(() => {
    ref.current?.querySelector(`#${CSS.escape(`${listboxId}-${s.index}`)}`)?.scrollIntoView({ block: "nearest" });
  }, [s.index, listboxId]);

  if (!s.open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      className="dxe-slash"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight }}
      onMouseDown={(e) => e.preventDefault()} // keep focus (and the selection) in the editor
    >
      {s.items.length ? (
        <div id={listboxId} role="listbox" aria-label="Insert a block" className="dxe-slash__list">
          {s.items.map((it, i) => (
            <div
              key={it.id}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={i === s.index}
              className={cx("dxe-slash__opt", i === s.index && "dxe-slash__opt--on")}
              onMouseEnter={() => store.set({ index: i })}
              onClick={() => s.pick?.(it)}
            >
              <span className="dxe-slash__icon" aria-hidden>
                <Icon name={it.icon} />
              </span>
              <span className="dxe-slash__text">
                <span className="dxe-slash__label">{it.label}</span>
                <span className="dxe-slash__hint">{it.hint}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="dxe-slash__none" role="status">
          No block matches “{s.query}”
        </div>
      )}
    </div>,
    document.body,
  );
}

export type { Range };
