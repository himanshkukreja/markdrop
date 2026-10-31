/**
 * Find and replace, without React or a view: the same matching for the visual editor (over the
 * ProseMirror document) and for Markdown mode (over the text), so "match case" and "whole word"
 * mean the same thing in both.
 *
 * In the document, every textblock is searched on its own (a match never spans two paragraphs),
 * and an inline node that isn't text (an image, inline math) counts as one character that matches
 * nothing, so a string index inside a textblock is also its offset into the block's content:
 * `pos = blockPos + 1 + index`.
 */

/** At most this many matches are reported (and replaced by Replace all in one go). */
export const MAX_MATCHES = 2000;

const OBJECT = "￼";

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The search as a global RegExp, or null for an empty query. */
export function searchRegExp(query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return null;
  let src = escape(query);
  // A word boundary that knows letters beyond ASCII (é, ß, ü…): no letter, digit or _ either side.
  if (wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, `gu${matchCase ? "" : "i"}`);
}

/** Matches in a string, as [from, to) offsets. */
export function textMatches(text, query, opts = {}) {
  const re = searchRegExp(query, opts);
  if (!re) return [];
  const out = [];
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    out.push({ from: m.index, to: m.index + m[0].length });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

/** A textblock's content as a string in which index i is content offset i. */
export function blockText(node) {
  let s = "";
  node.forEach((child) => {
    s += child.isText ? child.text : OBJECT.repeat(child.nodeSize);
  });
  return s;
}

/** Matches in a ProseMirror document, as document positions. */
export function docMatches(doc, query, opts = {}) {
  const re = searchRegExp(query, opts);
  if (!re) return [];
  const out = [];
  doc.descendants((node, pos) => {
    if (out.length >= MAX_MATCHES) return false;
    if (!node.isTextblock) return true;
    const text = blockText(node);
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0]) break;
      if (m[0].includes(OBJECT)) continue;
      out.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
      if (out.length >= MAX_MATCHES) break;
    }
    return false;
  });
  return out;
}

/** The match to show after `pos` (wrapping), or -1. */
export function nextIndex(matches, pos, dir = 1) {
  if (!matches.length) return -1;
  if (dir > 0) {
    const i = matches.findIndex((m) => m.from >= pos);
    return i < 0 ? 0 : i;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].to <= pos) return i;
  return matches.length - 1;
}

/** Markdown mode's Replace all: the new text and how many were replaced. */
export function replaceAllText(text, query, replacement, opts = {}) {
  const ms = textMatches(text, query, opts);
  if (!ms.length) return { text, count: 0 };
  let out = "";
  let at = 0;
  for (const m of ms) {
    out += text.slice(at, m.from) + replacement;
    at = m.to;
  }
  return { text: out + text.slice(at), count: ms.length };
}
