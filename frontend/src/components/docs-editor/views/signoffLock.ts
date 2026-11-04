/**
 * Signed sign-off blocks in the editor (the server refuses the same edits: services/signoffs.py):
 *   - the signed block itself, and with `lock=above` the section from the previous heading (or the
 *     page's start) down to it, can't be changed: a transaction that would touch them is dropped
 *     and a toast says why;
 *   - the locked section carries a subtle lock rail (`dxe-signoff-locked`), titled with the reason.
 *
 * What's signed comes from the page's sign-off store (`pages.signoffs` on the editor's services),
 * never from the Markdown. Loads (`setContent`, remote updates) and an admin's "Remove sign-off"
 * (`signoffLockKey` meta `{ allow: true }`) pass.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { SignoffState } from "@/lib/signoffs";
import { services } from "../menus/mediaUpload";

export const signoffLockKey = new PluginKey<DecorationSet>("dxeSignoffLock");

export interface LockedRange {
  id: string;
  /** Where the locked section starts (the heading, or the block itself without lock=above). */
  from: number;
  /** The signoff node's position and end. */
  at: number;
  to: number;
  state: SignoffState;
}

function signedOf(editor: Editor): Map<string, SignoffState> | null {
  const store = services(editor).pages?.signoffs;
  if (!store) return null;
  const m = store.signed();
  return m.size ? m : null;
}

/** The locked ranges in `doc` for the signed blocks. */
export function lockedRanges(doc: PMNode, signed: Map<string, SignoffState> | null): LockedRange[] {
  if (!signed) return [];
  const out: LockedRange[] = [];
  let heading = 0;
  doc.descendants((n, pos) => {
    if (n.type.name === "heading") heading = pos;
    if (n.type.name === "signoff") {
      const id = n.attrs.attributes?.id;
      const st = typeof id === "string" ? signed.get(id) : undefined;
      if (st) {
        const lock = st.lock === "above" || n.attrs.attributes?.lock === "above";
        out.push({ id, from: lock ? Math.min(heading, pos) : pos, at: pos, to: pos + n.nodeSize, state: st });
      }
      return false;
    }
    return !n.isTextblock;
  });
  return out;
}

/** Whether `tr` changes a locked range (mapped through its own steps). */
export function touchesLocked(tr: Transaction, ranges: LockedRange[]): LockedRange | null {
  let live = ranges.map((r) => ({ ...r }));
  for (const step of tr.steps) {
    const map = step.getMap();
    let hit: LockedRange | null = null;
    map.forEach((oldStart, oldEnd) => {
      if (hit) return;
      for (const r of live) {
        const inside = oldStart === oldEnd ? oldStart > r.from && oldStart < r.to : oldStart < r.to && oldEnd > r.from;
        if (inside) {
          hit = r;
          return;
        }
      }
    });
    // Attribute-only steps (an anchor added to a block, a colour) have an empty map.
    const s = step as unknown as { pos?: number };
    if (!hit && typeof s.pos === "number") hit = live.find((r) => s.pos! >= r.from && s.pos! < r.to) ?? null;
    if (hit) return hit;
    live = live.map((r) => ({ ...r, from: map.map(r.from, 1), at: map.map(r.at, 1), to: map.map(r.to, -1) }));
  }
  return null;
}

function decorations(doc: PMNode, ranges: LockedRange[]): DecorationSet {
  if (!ranges.length) return DecorationSet.empty;
  const decos: Decoration[] = [];
  for (const r of ranges) {
    const who = r.state.signed_by?.name || r.state.person?.name || "the person named";
    const title = `Locked: ${who} signed off “${r.state.label}”${r.state.option ? ` (${r.state.option})` : ""}`;
    let first = true;
    doc.nodesBetween(r.from, r.at, (n, pos) => {
      if (pos < r.from || !n.isBlock) return true;
      if (pos + n.nodeSize <= r.at) {
        decos.push(Decoration.node(pos, pos + n.nodeSize, { class: `dxe-signoff-locked${first ? " dxe-signoff-locked--first" : ""}`, title, "data-signoff-tone": r.state.tone ?? "neutral" }));
        first = false;
        return false;
      }
      return true;
    });
  }
  return DecorationSet.create(doc, decos);
}

let lastToast = 0;

export function signoffLockPlugin(editor: Editor): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: signoffLockKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old, _prev, next: EditorState) {
        if (!tr.docChanged && !tr.getMeta(signoffLockKey)) return old.map(tr.mapping, tr.doc);
        return decorations(next.doc, lockedRanges(next.doc, signedOf(editor)));
      },
    },
    props: {
      decorations(state) {
        return signoffLockKey.getState(state) ?? DecorationSet.empty;
      },
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged) return true;
      if (tr.getMeta("preventUpdate") || (tr.getMeta(signoffLockKey) as { allow?: boolean } | undefined)?.allow) return true;
      const ranges = lockedRanges(state.doc, signedOf(editor));
      if (!ranges.length) return true;
      const hit = touchesLocked(tr, ranges);
      if (!hit) return true;
      const now = Date.now();
      if (now - lastToast > 2500) {
        lastToast = now;
        const who = hit.state.signed_by?.name || "The person named";
        services(editor).toast?.info?.(
          hit.at === hit.from
            ? `${who} signed off “${hit.state.label}”, so it can't change until they clear their decision.`
            : `This section is locked: ${who} signed off “${hit.state.label}”. They can clear their decision to unlock it.`,
        );
      }
      return false;
    },
    view(view) {
      // Repaint when the page's sign-offs change (someone signed, or cleared).
      let gone = false;
      const repaint = () =>
        window.setTimeout(() => {
          if (!gone) view.dispatch(view.state.tr.setMeta(signoffLockKey, { refresh: true }).setMeta("addToHistory", false));
        }, 0);
      let store = services(editor).pages?.signoffs;
      let off = store?.subscribe(repaint);
      return {
        update() {
          const now = services(editor).pages?.signoffs;
          if (now === store) return;
          off?.();
          store = now;
          off = store?.subscribe(repaint);
          repaint();
        },
        destroy() {
          gone = true;
          off?.();
        },
      };
    },
  });
}
