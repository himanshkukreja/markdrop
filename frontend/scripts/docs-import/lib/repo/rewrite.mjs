/**
 * The last pass over a page body, built for fidelity: a line changes only where it must.
 *
 * - Code fences and inline code: untouched.
 * - Markdown links, images and reference definitions: only their targets change (ctx.link /
 *   ctx.image); text, titles, emphasis, spacing stay as written. An image with no alt text gets one
 *   (reported); a link the ctx drops (outside the repo, GitBook's broken-reference) keeps its text.
 * - Raw HTML (a block like <table>/<figure>/<div>…</div>, or a line with inline tags) and, for
 *   GitBook, `{% … %}` blocks: that span alone goes through lib/convert.mjs convertBody, the GitBook
 *   importer's converter, since the engine never renders raw HTML.
 * Everything else is copied byte for byte.
 */
import { convertBody, mapOutsideCode } from "../convert.mjs";
import { SENT } from "./blocks.mjs";

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const BLOCK_HTML = /^\s*<(figure|table|picture|div|p|blockquote|ul|ol|h[1-6]|iframe|video|center|details|dl|pre)\b[^>]*>/i;
const HTML_TAGS = new Set("a abbr b bdi bdo big blockquote br button caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i iframe img ins kbd label li main mark nav ol p picture pre q s samp section small source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var video wbr".split(" "));
const MAYBE_SELF_CLOSING = new Set(["embed", "file", "include", "openapi", "swagger", "openapi-operation", "openapi-schemas", "openapi-webhook", "content-ref", "code"]);

/** Whether a line holds an HTML tag (autolinks <https://…> and <a@b.c> aside), outside inline code. */
export function hasInlineHtml(line) {
  const masked = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (m) => " ".repeat(m.length)).replace(/<(?:https?:|mailto:)[^>]*>|<[^\s<>@]+@[^\s<>]+>/gi, "");
  for (const m of masked.matchAll(/<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?\/?>/gi)) if (HTML_TAGS.has(m[1].toLowerCase())) return true;
  return false;
}

const TITLE = String.raw`(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?`;
const TARGET = String.raw`(<[^>\n]*>|[^)\s]+)`;
const IMAGE = new RegExp(String.raw`!\[((?:[^\[\]\\]|\\.)*)\]\(\s*${TARGET}${TITLE}\s*\)`, "g");
const LINK = new RegExp(String.raw`(^|[^!\\])\[((?:[^\[\]\\]|\\.|!\[(?:[^\[\]\\]|\\.)*\]\([^)\n]*\))*)\]\(\s*${TARGET}${TITLE}\s*\)`, "g");
const REFDEF = /^(\s{0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)(.*)$/;

const unwrap = (t) => (t.startsWith("<") && t.endsWith(">") ? t.slice(1, -1) : t);
const label = (s) => String(s ?? "").replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")"));

/** One Markdown line's link and image targets (outside inline code). */
export function rewriteLinks(line, ctx, lineNo = 0) {
  const def = REFDEF.exec(line);
  if (def) {
    const href = unwrap(def[2]);
    // A definition may serve links and images alike: resolved as a link (repo images and files
    // still become assets).
    const to = ctx.link(href, { line: lineNo });
    return to && to !== href ? `${def[1]}${to}${def[3]}` : line;
  }
  return mapOutsideCode(line, (seg) =>
    seg
      .replace(IMAGE, (m, alt, target, title) => {
        const src = unwrap(target);
        if (src.startsWith("@@") || src.startsWith("/docs-assets/")) return m;
        const cap = title ? title.trim().slice(1, -1) : "";
        const r = ctx.image(src, { alt, caption: cap, line: lineNo });
        if (!r) return cap ? `*${cap}*` : "";
        const a = alt.trim() ? alt : label(r.alt ?? "");
        if (r.src === src && a === alt) return m;
        return `![${a}](${r.src}${title ?? ""})`;
      })
      .replace(LINK, (m, pre, text, target, title) => {
        const href = unwrap(target);
        if (href.startsWith("@@") || href.startsWith("/docs-assets/")) return m;
        const to = ctx.link(href, { line: lineNo });
        if (to === href) return m;
        return to ? `${pre}[${text}](${to}${title ?? ""})` : `${pre}${text}`;
      }),
  );
}

/** Index of the line closing a span opened at lines[i] (same-name nesting counted), or i. */
function spanEnd(lines, i, open, close, max = 400) {
  let depth = 0;
  let fence = null;
  for (let j = i; j < lines.length && j - i < max; j++) {
    const l = lines[j];
    const f = FENCE.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && !f[2].trim()) fence = null;
      continue;
    }
    if (j > i && f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      continue;
    }
    depth += (l.match(open) ?? []).length - (l.match(close) ?? []).length;
    if (depth <= 0) return j;
  }
  return -1;
}

/**
 * A page body (components already converted) → its final Markdown, changing only targets and raw
 * HTML (and GitBook blocks when `gitbook`). SENT lines pass through for blocks.mjs settle().
 */
export function rewriteBody(md, ctx, { line0 = 0, gitbook = false } = {}) {
  const lines = String(md).split("\n");
  const out = [];
  let fence = null;
  const viaConvert = (from, to) => {
    const seg = lines.slice(from, to + 1).join("\n");
    const conv = convertBody(seg, line0 + from, ctx).replace(/\n+$/, "");
    out.push(SENT, ...(conv.trim() ? conv.split("\n") : []), SENT);
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (fence) {
      out.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      out.push(l);
      continue;
    }
    if (l === SENT || !l.trim()) {
      out.push(l);
      continue;
    }
    if (gitbook) {
      const t = /^\s*\{%\s*(?!end)([a-zA-Z][\w-]*)\b/.exec(l);
      if (t) {
        const name = t[1].toLowerCase();
        const esc = name.replace(/-/g, "\\-");
        const j = spanEnd(lines, i, new RegExp(`\\{%\\s*${esc}\\b`, "gi"), new RegExp(`\\{%\\s*end${esc}\\b`, "gi"));
        const end = j >= 0 ? j : MAYBE_SELF_CLOSING.has(name) ? i : i;
        viaConvert(i, end);
        i = end;
        continue;
      }
      if (/\{%[^%]*%\}/.test(l.replace(/`[^`]*`/g, ""))) {
        viaConvert(i, i);
        continue;
      }
    }
    const b = BLOCK_HTML.exec(l);
    if (b) {
      const tag = b[1].toLowerCase();
      const j = spanEnd(lines, i, new RegExp(`<${tag}\\b`, "gi"), new RegExp(`</${tag}\\s*>`, "gi"));
      const end = j >= 0 ? j : i;
      viaConvert(i, end);
      i = end;
      continue;
    }
    if (hasInlineHtml(l)) {
      const conv = convertBody(l, line0 + i, ctx).replace(/\n+$/, "");
      // convertBody drops a line's leading indent with its leading blank lines: keep the source's.
      const ind = /^[ \t]*/.exec(l)[0];
      out.push(...(conv.trim() ? conv.split("\n").map((x, k) => (k === 0 && !x.startsWith(ind) ? ind + x.trimStart() : x)) : [SENT]));
      continue;
    }
    const r = rewriteLinks(l, ctx, line0 + i);
    // A line that held only a dropped image: a SENT blank, not an extra blank line.
    out.push(r.trim() ? r : SENT);
  }
  return out.join("\n");
}
