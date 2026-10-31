/**
 * Everything the visual editor paints over the text without changing it, in one ProseMirror plugin:
 *
 * - find matches (and the current one) for the Find and replace bar;
 * - problems the host knows about: a link to a page that doesn't exist or isn't published (wavy
 *   underline + tooltip), an image without a description;
 * - review comments' quoted text (click one to open its thread);
 * - the passage an AI suggestion will replace while the suggestion is open (mapped through edits,
 *   so typing elsewhere meanwhile never sends it to the wrong place).
 *
 * The host's inputs live in a mutable `AnnotationSource`; after changing it, call `refresh(editor)`.
 */
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { blockText, docMatches, type FindOptions, type Match } from "../core/find.mjs";

export interface CommentHighlight {
  id: string;
  quote: string;
  prefix?: string;
  active?: boolean;
}

export interface LinkProblem {
  message: string;
}

export interface AnnotationSource {
  find: { query: string; opts: FindOptions; current: number } | null;
  /** A problem with a link's target (the host knows the pages), or null. */
  checkLink?: (href: string) => LinkProblem | null;
  /** Flag images that have no description (alt text). */
  flagImages: boolean;
  comments: CommentHighlight[];
  onCommentClick?: (id: string) => void;
}

interface PluginStateShape {
  decos: DecorationSet;
  matches: Match[];
  /** The AI suggestion's target range, mapped through every change. */
  pending: { from: number; to: number } | null;
  /** Where each comment's quote is in the document now. */
  anchors: Record<string, { from: number; to: number }>;
}

export const annotationsKey = new PluginKey<PluginStateShape>("docsAnnotations");

type Meta = { refresh?: true; pending?: { from: number; to: number } | null };

export const IMAGE_PROBLEM = "This image has no description. Screen readers and search engines use it.";

/** Where a comment's quote is: its first line, the occurrence whose preceding text ends with `prefix`. */
function anchorOf(doc: PMNode, c: CommentHighlight): { from: number; to: number } | null {
  const line = c.quote.split("\n").find((l) => l.trim()) ?? "";
  if (!line) return null;
  const ms = docMatches(doc, line, { matchCase: true });
  if (!ms.length) return null;
  if (ms.length === 1 || !c.prefix) return ms[0]!;
  // The text just before the quote, as it was when the comment was written (the start of a block
  // has less of it than was recorded: compare what there is).
  const want = c.prefix.slice(-24);
  for (const m of ms) {
    const $p = doc.resolve(m.from);
    const before = blockText($p.parent).slice(0, $p.parentOffset).slice(-24);
    if (before && (before === want || want.endsWith(before))) return m;
  }
  return ms[0]!;
}

function build(doc: PMNode, src: AnnotationSource, pending: PluginStateShape["pending"]): Omit<PluginStateShape, "pending"> {
  const decos: Decoration[] = [];
  // Problems: links and images.
  if (src.checkLink || src.flagImages) {
    doc.descendants((node, pos) => {
      if (src.flagImages && (node.type.name === "figure" || node.type.name === "image") && !String(node.attrs.alt ?? "").trim()) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "dxe-problem-node", title: IMAGE_PROBLEM, "data-problem": "image" }));
      }
      if (!src.checkLink || !node.isTextblock) return true;
      // Link marks over runs of text: one decoration per run with the same address.
      let run: { href: string; from: number; to: number } | null = null;
      const flush = () => {
        if (!run) return;
        const p = src.checkLink!(run.href);
        if (p) decos.push(Decoration.inline(run.from, run.to, { class: "dxe-problem", title: p.message, "data-problem": "link" }));
        run = null;
      };
      node.forEach((child, offset) => {
        const at = pos + 1 + offset;
        const link = child.marks.find((m) => m.type.name === "link");
        const href = link ? String(link.attrs.href ?? "") : "";
        if (run && href === run.href && at === run.to) {
          run.to = at + child.nodeSize;
          return;
        }
        flush();
        if (href) run = { href, from: at, to: at + child.nodeSize };
      });
      flush();
      return false;
    });
  }
  // Comments.
  const anchors: Record<string, { from: number; to: number }> = {};
  for (const c of src.comments) {
    const a = anchorOf(doc, c);
    if (!a) continue;
    anchors[c.id] = a;
    decos.push(Decoration.inline(a.from, a.to, { class: c.active ? "dxe-comment dxe-comment--on" : "dxe-comment", "data-comment": c.id }));
  }
  // Find.
  let matches: Match[] = [];
  if (src.find?.query) {
    matches = docMatches(doc, src.find.query, src.find.opts);
    matches.forEach((m, i) => decos.push(Decoration.inline(m.from, m.to, { class: i === src.find!.current ? "dxe-find dxe-find--on" : "dxe-find" })));
  }
  if (pending && pending.to > pending.from) decos.push(Decoration.inline(pending.from, pending.to, { class: "dxe-pending" }));
  return { decos: DecorationSet.create(doc, decos), matches, anchors };
}

export function createAnnotations(src: AnnotationSource) {
  return Extension.create({
    name: "docsAnnotations",
    addProseMirrorPlugins() {
      return [
        new Plugin<PluginStateShape>({
          key: annotationsKey,
          state: {
            init: (_c, state: EditorState) => ({ ...build(state.doc, src, null), pending: null }),
            apply: (tr: Transaction, prev: PluginStateShape, _old, state: EditorState) => {
              const meta = tr.getMeta(annotationsKey) as Meta | undefined;
              let pending = prev.pending;
              if (pending && tr.docChanged) {
                const from = tr.mapping.map(pending.from, 1);
                const to = tr.mapping.map(pending.to, -1);
                pending = to > from ? { from, to } : null;
              }
              if (meta && "pending" in meta) pending = meta.pending ?? null;
              if (!tr.docChanged && !meta) return prev;
              return { ...build(state.doc, src, pending), pending };
            },
          },
          props: {
            decorations: (state) => annotationsKey.getState(state)?.decos,
            handleClick: (view, pos, event) => {
              const el = (event.target as HTMLElement | null)?.closest?.("[data-comment]");
              const id = el?.getAttribute("data-comment");
              if (id && src.onCommentClick) {
                src.onCommentClick(id);
                return false;
              }
              void view;
              void pos;
              return false;
            },
          },
        }),
      ];
    },
  });
}

/** Recompute the decorations after the host changed the source. */
export function refreshAnnotations(editor: Editor) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(annotationsKey, { refresh: true } satisfies Meta).setMeta("addToHistory", false));
}

export function setPending(editor: Editor, range: { from: number; to: number } | null) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(annotationsKey, { pending: range } satisfies Meta).setMeta("addToHistory", false));
}

export function annotationState(state: EditorState) {
  return annotationsKey.getState(state) ?? null;
}
