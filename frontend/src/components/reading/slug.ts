/**
 * Heading ids for rendered markdown (REVAMP_PLAN 7.6 "Heading anchors").
 *
 * No new dependency: a github-slugger-like slug (lower-case, punctuation dropped, spaces → "-",
 * duplicates get "-1", "-2"…) with the sanitizer's clobber prefix, so ids read `user-content-<slug>`
 * exactly like the ids rehype-sanitize produces for author-written ids.
 *
 * Two entry points produce the SAME ids by construction, because both derive the slug from the
 * heading's markdown source through `headingSourceText`:
 *  - `rehypeHeadingIds`: the rehype plugin MarkdownPreview runs after sanitize (and before KaTeX).
 *    It reads the source through each heading's `position` offsets.
 *  - `extractHeadings(markdown)`: a cheap line scanner for callers that need the list before (or
 *    without) rendering, e.g. a server-rendered Contents rail. It understands ATX and setext
 *    headings, fenced/indented code, `$$` math blocks, HTML blocks and blockquotes. Headings inside
 *    list items are not seen by the scanner; MarkdownPreview's `onHeadings` gives the exact list.
 */

export interface Heading {
  /** The DOM id, including the `user-content-` prefix. */
  id: string;
  /** Plain text of the heading. */
  text: string;
  /** 1–4 (ids are only added to h1–h4). */
  depth: number;
}

export const HEADING_ID_PREFIX = "user-content-";

/** github-slugger-like: lower-case, keep letters/marks/numbers/connector punctuation, spaces → "-". */
export function slugify(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** A deterministic slugger that dedupes like github-slugger ("a", "a-1", "a-2"…). */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const PH_OPEN = "";
const PH_CLOSE = "";

/** Inline markdown → the text a reader sees (links keep their text, images and footnote refs drop). */
export function inlineText(src: string): string {
  const keep: string[] = [];
  const stash = (s: string) => `${PH_OPEN}${keep.push(s) - 1}${PH_CLOSE}`;
  let s = src
    // Backslash escapes first, so an escaped * or _ never reads as emphasis.
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => stash(c))
    // Code spans and inline math keep their content verbatim.
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, c: string) => stash(c.replace(/^ (.*) $/, "$1")))
    .replace(/(\${1,2})([^$]+?)\1/g, (_, _d, c: string) => stash(c));
  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto|ftp):[^>\s]+)>/gi, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}])_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/~~?(?=\S)([\s\S]*?\S)~~?/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  s = s.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, "g"), (_, i: string) => keep[+i] ?? "");
  return s.replace(/\s+/g, " ").trim();
}

const QUOTE_PREFIX = /^\s{0,3}(?:>\s?)+/;

/** The source of one heading (as positioned by remark) → its plain text. */
export function headingSourceText(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines.length > 1 && /^\s*(?:>\s?)*\s*(=+|-+)\s*$/.test(lines[lines.length - 1])) {
    // Setext: everything but the underline; continuation lines may carry blockquote markers.
    return inlineText(lines.slice(0, -1).map((l, i) => (i === 0 ? l : l.replace(QUOTE_PREFIX, ""))).join(" "));
  }
  const atx = lines[0].replace(/^\s{0,3}#{1,6}(?=\s|$)/, "").replace(/(?:^|\s+)#+\s*$/, "");
  return inlineText(atx);
}

/* ── The rehype plugin ─────────────────────────────────────────────────────── */

interface HPoint { offset?: number }
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  position?: { start: HPoint; end: HPoint };
}

function hastText(node: HNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function isBlank(node: HNode) {
  return node.type === "text" && !(node.value ?? "").trim();
}

/** A paragraph that holds one image (or one link around one image) and nothing else. */
function isImageParagraph(p: HNode): boolean {
  const kids = (p.children ?? []).filter((c) => !isBlank(c));
  if (kids.length !== 1 || kids[0].type !== "element") return false;
  const only = kids[0];
  if (only.tagName === "img") return true;
  if (only.tagName !== "a") return false;
  const inner = (only.children ?? []).filter((c) => !isBlank(c));
  return inner.length === 1 && inner[0].type === "element" && inner[0].tagName === "img";
}

function addClass(node: HNode, cls: string) {
  const props = (node.properties ??= {});
  const current = props.className;
  props.className = Array.isArray(current) ? [...current, cls] : typeof current === "string" ? [current, cls] : [cls];
}

export interface HeadingIdsOptions {
  /** Receives the headings of each processed document, in order. */
  collect?: (headings: Heading[]) => void;
}

/**
 * Sets `id="user-content-<slug>"` on h1–h4 that have no id yet (the GFM footnote label keeps its
 * own), collects the heading list, and marks image-only paragraphs (`md-img-block`) so block
 * images get the frame while inline badges don't. Runs AFTER rehype-sanitize: its output is
 * trusted, generated from the markdown, never author HTML.
 */
export function rehypeHeadingIds(options: HeadingIdsOptions = {}) {
  return (tree: HNode, file?: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : null;
    const slug = createSlugger();
    const out: Heading[] = [];
    const walk = (node: HNode) => {
      if (node.type === "element") {
        const m = /^h([1-4])$/.exec(node.tagName ?? "");
        if (m && !node.properties?.id) {
          const text = hastText(node).replace(/\s+/g, " ").trim();
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          const fromSource = source !== null && start !== undefined && end !== undefined ? headingSourceText(source.slice(start, end)) : null;
          const id = HEADING_ID_PREFIX + slug(fromSource ?? text);
          node.properties = { ...node.properties, id };
          out.push({ id, text: text || fromSource || "", depth: +m[1] });
          return;
        }
        if (node.tagName === "p" && isImageParagraph(node)) addClass(node, "md-img-block");
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    options.collect?.(out);
  };
}

/* ── The scanner ───────────────────────────────────────────────────────────── */

/**
 * Headings (h1–h4) of a markdown string, with the ids MarkdownPreview gives them. Cheap: one pass
 * over the lines, no parser. Safe on the server.
 */
export function extractHeadings(markdown: string): Heading[] {
  const slug = createSlugger();
  const out: Heading[] = [];
  const push = (depth: number, text: string) => {
    if (depth > 4) return;
    out.push({ id: HEADING_ID_PREFIX + slug(text), text, depth });
  };
  let fence: { ch: string; len: number } | null = null;
  let math = false;
  let html = false;
  let para: string[] = [];

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(QUOTE_PREFIX, "");
    if (fence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    if (math) {
      if (/^\s{0,3}\$\$\s*$/.test(line)) math = false;
      continue;
    }
    if (html) {
      if (!line.trim()) html = false;
      continue;
    }
    if (!line.trim()) {
      para = [];
      continue;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { ch: open[1][0], len: open[1].length };
      para = [];
      continue;
    }
    if (/^\s{0,3}\$\$(?!.*\$)/.test(line)) {
      math = true;
      para = [];
      continue;
    }
    const atx = /^\s{0,3}(#{1,6})(?:\s|$)/.exec(line);
    if (atx) {
      push(atx[1].length, headingSourceText(line));
      para = [];
      continue;
    }
    const underline = /^\s{0,3}(=+|-+)\s*$/.exec(line);
    if (underline && para.length) {
      push(underline[1][0] === "=" ? 1 : 2, inlineText(para.join(" ")));
      para = [];
      continue;
    }
    if (!para.length) {
      if (/^ {4,}|^\t/.test(raw)) continue; // indented code
      if (/^\s{0,3}(?:<!--|<\/?[A-Za-z][\w-]*(?:\s|\/?>|$))/.test(line)) {
        html = true;
        continue;
      }
    }
    // List items, table rows and thematic breaks never start a setext paragraph.
    if (/^\s{0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)|^\s{0,3}\||^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
      para = [];
      continue;
    }
    para.push(line);
  }
  return out;
}

/** Headings from the rendered DOM (any container of MarkdownPreview output). */
export function extractHeadingsFromDom(root: ParentNode): Heading[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`h1[id^="${HEADING_ID_PREFIX}"], h2[id^="${HEADING_ID_PREFIX}"], h3[id^="${HEADING_ID_PREFIX}"], h4[id^="${HEADING_ID_PREFIX}"]`))
    .filter((h) => h.id !== `${HEADING_ID_PREFIX}footnote-label`)
    .map((h) => ({ id: h.id, text: (h.textContent ?? "").replace(/\s+/g, " ").trim(), depth: +h.tagName[1] }));
}

/**
 * The entries a Contents list shows: drop a lone leading h1 (the title), then keep the top two
 * heading levels that remain (usually h2 + h3).
 */
export function tocHeadings(all: Heading[]): Heading[] {
  let hs = all.filter((h) => h.depth <= 4);
  if (hs[0]?.depth === 1 && hs.filter((h) => h.depth === 1).length === 1) hs = hs.slice(1);
  if (!hs.length) return [];
  const min = Math.min(...hs.map((h) => h.depth));
  return hs.filter((h) => h.depth <= min + 1);
}
