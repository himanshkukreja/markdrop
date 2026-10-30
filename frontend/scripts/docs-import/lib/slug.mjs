/**
 * Heading ids exactly as the docs engine makes them. A copy of the slugger in
 * scripts/docs-check.mjs (which mirrors src/components/reading/slug.ts); keep the three in step.
 */
export function slugify(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

export function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text) || "section";
    let slug = base;
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

export function inlineText(src) {
  const keep = [];
  const stash = (s) => `\u0000${keep.push(s) - 1}\u0001`;
  let s = src
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => stash(c))
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, c) => stash(c.replace(/^ (.*) $/, "$1")))
    .replace(/(\${1,2})([^$]+?)\1/g, (_, _d, c) => stash(c));
  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/~~?(?=\S)([\s\S]*?\S)~~?/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  s = s.replace(/\u0000(\d+)\u0001/g, (_, i) => keep[+i] ?? "");
  return s.replace(/\s+/g, " ").trim();
}

export const headingText = (line) => inlineText(line.replace(/^\s{0,3}#{1,6}(?=\s|$)/, "").replace(/(?:^|\s+)#+\s*$/, ""));

/** Heading ids of a page body (h1–h4, fenced code and $$ math skipped), in document order. */
export function headingIds(body) {
  const slug = createSlugger();
  const ids = [];
  let fence = null;
  let math = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^\s{0,3}(?:>\s?)+/, "");
    if (fence) {
      const c = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      continue;
    }
    if (math) {
      if (/^\s{0,3}\$\$\s*$/.test(line)) math = false;
      continue;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { ch: open[1][0], len: open[1].length };
      continue;
    }
    if (/^\s{0,3}\$\$(?!.*\$\$)/.test(line)) {
      math = true;
      continue;
    }
    const h = /^\s{0,3}(#{1,6})(?:\s|$)/.exec(line);
    if (h && h[1].length <= 4) ids.push({ id: slug(headingText(line)), text: headingText(line), depth: h[1].length });
  }
  return ids;
}

/** Letters and digits only: "step-1--define" and "step-1-define" compare equal. */
export const looseId = (id) => String(id).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
