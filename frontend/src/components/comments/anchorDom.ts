/**
 * Anchors ↔ the rendered page (CONTRACT §2). A selection becomes a W3C TextQuoteSelector (the exact text,
 * 32 characters either side, the block it's in); a stored anchor becomes a DOM Range again by searching the
 * page's text. Whitespace is normalised on both sides (every run is one space), as on the server.
 *
 * Pure DOM: works in the reader (Markdown rendered by React) and in the editor (ProseMirror's DOM).
 */
import type { Anchor, AnchorIn } from "@/lib/comments";

const CONTEXT = 32;
const MAX_QUOTE = 1000;
const BLOCK_TEXT = 280;
/** Elements whose text never counts (code copy buttons, our own UI, math source). */
const BLOCKS = "li, p, h1, h2, h3, h4, h5, h6, blockquote, pre, tr, summary, figure, dt, dd";
const SKIP = "[data-comments-skip], .katex-mathml, button, [aria-hidden='true'], script, style, .pb-comment-gutter";

export const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

interface Seg {
  node: Text;
  /** Offset of this node's first kept character in the normalised text. */
  start: number;
  /** For each normalised character from `start`, the offset in node.data. */
  map: number[];
}

export interface TextIndex {
  text: string;
  segs: Seg[];
}

function skipped(node: Node, root: Element): boolean {
  const el = node.parentElement;
  if (!el) return true;
  const hit = el.closest(SKIP);
  return !!hit && root.contains(hit);
}

/** The normalised text under `root` and where each character came from. */
export function indexText(root: Element): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segs: Seg[] = [];
  let text = "";
  let lastSpace = true;
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data || skipped(t, root)) continue;
    // Text in a different block than the previous one is separated by a space (blocks don't run together).
    const block = t.parentElement?.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, summary, figcaption, [data-bid]") ?? null;
    if (block !== lastBlock && !lastSpace && text.length) {
      text += " ";
      lastSpace = true;
    }
    lastBlock = block;
    const map: number[] = [];
    const start = text.length;
    for (let i = 0; i < t.data.length; i++) {
      const ch = t.data[i]!;
      if (/\s/.test(ch)) {
        if (lastSpace) continue;
        text += " ";
        map.push(i);
        lastSpace = true;
      } else {
        text += ch;
        map.push(i);
        lastSpace = false;
      }
    }
    if (map.length) segs.push({ node: t, start, map });
  }
  return { text, segs };
}

function locate(idx: TextIndex, pos: number, end: boolean): { node: Text; offset: number } | null {
  for (const s of idx.segs) {
    if (pos >= s.start && pos < s.start + s.map.length) return { node: s.node, offset: s.map[pos - s.start]! };
    if (end && pos === s.start + s.map.length) return { node: s.node, offset: s.map[pos - s.start - 1]! + 1 };
  }
  // A position between segments (the separating space): the start of the next one / end of the previous.
  if (end) {
    const prev = [...idx.segs].reverse().find((s) => s.start + s.map.length <= pos);
    if (prev) return { node: prev.node, offset: prev.map[prev.map.length - 1]! + 1 };
  } else {
    const next = idx.segs.find((s) => s.start >= pos);
    if (next) return { node: next.node, offset: next.map[0]! };
  }
  return null;
}

/** A Range over normalised positions [from, to). */
export function rangeOf(idx: TextIndex, from: number, to: number): Range | null {
  const a = locate(idx, from, false);
  const b = locate(idx, Math.max(from, to - 1), false);
  if (!a || !b) return null;
  const r = document.createRange();
  try {
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, Math.min(b.node.data.length, b.offset + 1));
  } catch {
    return null;
  }
  return r;
}

function offsetOf(idx: TextIndex, node: Node, offset: number): number | null {
  if (node.nodeType !== Node.TEXT_NODE) {
    // An element boundary: the first text inside / after it.
    const child = node.childNodes[offset] ?? null;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let first: Node | null = null;
    if (child) {
      walker.currentNode = child;
      first = child.nodeType === Node.TEXT_NODE ? child : walker.nextNode();
    }
    if (!first) return null;
    node = first;
    offset = 0;
  }
  const seg = idx.segs.find((s) => s.node === node);
  if (!seg) return null;
  let k = 0;
  while (k < seg.map.length && seg.map[k]! < offset) k++;
  return seg.start + k;
}

/** The block element a node is in: its `[data-bid]` ancestor, else the root's direct child holding it. */
export function blockOf(root: Element, node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el || !root.contains(el)) return null;
  const bid = el.closest<HTMLElement>("[data-bid]");
  if (bid && root.contains(bid)) return bid;
  // No block ids (a classic markdown document, a page written outside the editor): the nearest block element.
  const blk = el.closest<HTMLElement>(BLOCKS);
  return blk && root.contains(blk) && blk !== root ? blk : null;
}

export function blockText(el: Element | null): string {
  if (!el) return "";
  return normalise(indexText(el).text).slice(0, BLOCK_TEXT);
}

/** The selection under `root` as a text anchor, or null (empty, outside, too long). */
export function selectionAnchor(root: Element, sel: Selection | null): AnchorIn | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const idx = indexText(root);
  const from = offsetOf(idx, range.startContainer, range.startOffset);
  let to = offsetOf(idx, range.endContainer, range.endOffset);
  if (from == null) return null;
  if (to == null) to = idx.text.length;
  let a = from;
  let b = to;
  while (a < b && idx.text[a] === " ") a++;
  while (b > a && idx.text[b - 1] === " ") b--;
  const exact = idx.text.slice(a, b);
  if (!exact.trim() || exact.length > MAX_QUOTE) return null;
  const block = blockOf(root, range.startContainer);
  return {
    type: "text",
    block_id: block?.getAttribute("data-bid") ?? null,
    block_text: blockText(block) || null,
    quote: { exact, prefix: idx.text.slice(Math.max(0, a - CONTEXT), a), suffix: idx.text.slice(b, b + CONTEXT) },
    start: a,
  };
}

/** A whole block (the reader's margin button, the editor's block menu). */
export function blockAnchor(el: Element): AnchorIn {
  return { type: "block", block_id: el.getAttribute("data-bid"), block_text: blockText(el) };
}

function ctxScore(text: string, pos: number, exact: string, prefix: string, suffix: string): number {
  let s = 0;
  for (let k = 1; k <= prefix.length && pos - k >= 0 && text[pos - k] === prefix[prefix.length - k]; k++) s++;
  for (let k = 0; k < suffix.length && text[pos + exact.length + k] === suffix[k]; k++) s++;
  return s;
}

function blockEl(root: Element, anchor: Anchor): HTMLElement | null {
  if (anchor.block_id) {
    const el = root.querySelector<HTMLElement>(`[data-bid="${CSS.escape(anchor.block_id)}"]`);
    if (el) return el;
  }
  if (anchor.block_text) {
    const want = normalise(anchor.block_text);
    const cands = root.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, h5, h6, tr, pre, blockquote, summary");
    for (const c of cands) {
      const t = blockText(c);
      if (t && (t === want || (want.length >= 20 && t.startsWith(want.slice(0, 60))))) return c;
    }
  }
  return null;
}

/** Where a thread's anchor is on the page now: the text range, or the block (as a range over it). */
export function resolveAnchor(root: Element, anchor: Anchor, idx?: TextIndex): Range | null {
  if (anchor.type === "page") return null;
  const block = blockEl(root, anchor);
  if (anchor.type === "block") {
    if (!block) return null;
    const r = document.createRange();
    r.selectNodeContents(block);
    return r;
  }
  const q = anchor.quote;
  if (!q?.exact) return null;
  const exact = normalise(q.exact);
  const index = idx ?? indexText(root);
  const hits: number[] = [];
  for (let i = index.text.indexOf(exact); i !== -1 && hits.length < 200; i = index.text.indexOf(exact, i + 1)) hits.push(i);
  if (!hits.length) {
    if (!block) return null;
    // Rendered differently from what the server saw (math, an embed's label): the block stands in.
    const r = document.createRange();
    r.selectNodeContents(block);
    return r;
  }
  let pool = hits;
  if (block) {
    const inside = hits.filter((h) => {
      const r = rangeOf(index, h, h + exact.length);
      return !!r && block.contains(r.startContainer);
    });
    if (inside.length) pool = inside;
  }
  const prefix = q.prefix ?? "";
  const suffix = q.suffix ?? "";
  const hint = anchor.start ?? 0;
  pool.sort((x, y) => ctxScore(index.text, y, exact, prefix, suffix) - ctxScore(index.text, x, exact, prefix, suffix) || Math.abs(x - hint) - Math.abs(y - hint));
  return rangeOf(index, pool[0]!, pool[0]! + exact.length);
}
