/**
 * Ask Markdrop's pure helpers (components/ask/AskHome.tsx; tested in askCore.test.mjs).
 *
 * An answer cites `[n]` (item n) or `[n-sK]` (line K of item n's meeting transcript). The server
 * keeps only labels it sent and the asker can still open; the UI numbers sources in the order the
 * answer first cites them, and nests a meeting's moments under it.
 */

const CITE = /\[(\d{1,2})(?:-s(\d{1,5}))?\]/g;

/** The answer as text and citation segments; labels outside `known` stay plain text. */
export function askSegments(answer, known) {
  const ok = new Set(known || []);
  const out = [];
  const s = answer || "";
  let at = 0;
  let m;
  CITE.lastIndex = 0;
  while ((m = CITE.exec(s))) {
    const label = m[0].slice(1, -1);
    if (!ok.has(label)) continue;
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ cite: label, n: Number(m[1]) });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** Sources in first-cited order: [{n, shown, title, url, kind, slug, task, moments: [{label, moment, url}]}]. */
export function sourcesOf(answer, citations) {
  const byLabel = new Map();
  for (const c of citations || []) if (c && c.label) byLabel.set(String(c.label), c);
  const order = [];
  const byN = new Map();
  for (const seg of askSegments(answer, byLabel.keys())) {
    if (seg.cite === undefined) continue;
    const c = byLabel.get(seg.cite);
    let src = byN.get(seg.n);
    if (!src) {
      src = { n: seg.n, shown: order.length + 1, title: null, url: null, kind: null, slug: null, task: null, moments: [] };
      byN.set(seg.n, src);
      order.push(src);
    }
    if (seg.cite.includes("-s")) {
      if (!src.moments.some((x) => x.label === seg.cite)) src.moments.push({ label: seg.cite, moment: c.moment || null, url: c.url || null, slug: c.slug || null });
      if (!src.title) src.title = (c.title || "").split(" · ")[0] || null;
    } else {
      src.title = c.title || src.title;
      src.url = c.url || null;
      src.kind = c.kind || null;
      src.slug = c.slug || null;
      src.task = c.text || null;
    }
  }
  // A moment cited without its item: the item opens at its first moment.
  for (const src of order) if (!src.url && src.moments[0]) { src.url = src.moments[0].url; src.slug = src.moments[0].slug; src.kind = "page"; }
  return order;
}

/** The chip number a label shows (its source's position; a moment shows "2·1", its source and order). */
export function chipOf(sources, label) {
  const n = Number(String(label).split("-")[0]);
  const src = (sources || []).find((s) => s.n === n);
  if (!src) return String(n);
  if (!String(label).includes("-s")) return String(src.shown);
  const i = src.moments.findIndex((x) => x.label === label);
  return i >= 0 ? `${src.shown}·${i + 1}` : String(src.shown);
}

/** Blocks of an answer: paragraphs, and bullet lists (lines starting "- " / "* " / "1. "). */
export function blocksOf(text) {
  const out = [];
  for (const block of (text || "").split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    let para = [];
    let list = null;
    const flush = () => { if (para.length) { out.push({ type: "p", text: para.join(" ") }); para = []; } };
    for (const l of lines) {
      const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l);
      if (m) {
        flush();
        if (!list) { list = { type: "ul", items: [] }; out.push(list); }
        list.items.push(m[1]);
      } else if (list && /^\s{2,}\S/.test(l)) {
        list.items[list.items.length - 1] += ` ${l.trim()}`;
      } else {
        list = null;
        para.push(l.trim());
      }
    }
    flush();
  }
  return out;
}

export const SUGGESTION_ICONS = { catch_up: "calendar", my_actions: "checkSquare", ask: "sparkle" };

export const STAGES = {
  understanding: "Understanding your question…",
  searching: "Looking through everything you can open…",
  answering: "Writing an answer…",
};
