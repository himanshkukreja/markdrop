/**
 * Small, tolerant HTML helpers for the importers (no dependencies): a tokenizer that builds a
 * tree, entity decoding, and HTML → Markdown for the inline/table/figure HTML that GitBook leaves
 * in its Markdown export. The docs engine never renders raw HTML, so everything here ends up as
 * Markdown or plain text.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", times: "×", rarr: "→", larr: "←", bull: "•", middot: "·", zwj: "", zwnj: "", shy: "" };

export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** `a="1" b='2' c=3 d` → {a:"1", b:"2", c:"3", d:""} (values entity-decoded). */
export function parseAttrs(src) {
  const out = {};
  const re = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(src || ""))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

/** HTML → [{tag, attrs, children} | {text}] (unclosed tags are closed at the end). */
export function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w-]*)\s*>|<([A-Za-z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m;
  const top = () => stack[stack.length - 1];
  while ((m = re.exec(html))) {
    if (m.index > last) top().children.push({ text: decodeEntities(html.slice(last, m.index)) });
    last = re.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const name = m[1].toLowerCase();
      const at = stack.map((n) => n.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const el = { tag: m[2].toLowerCase(), attrs: parseAttrs(m[3]), children: [] };
    top().children.push(el);
    if (!m[4] && !VOID.has(el.tag)) stack.push(el);
  }
  if (last < html.length) top().children.push({ text: decodeEntities(html.slice(last)) });
  return root;
}

export function textOf(node) {
  if (!node) return "";
  if (node.text !== undefined) return node.text;
  return (node.children ?? []).map(textOf).join("");
}

export function find(node, pred, out = []) {
  for (const c of node.children ?? []) {
    if (c.tag && pred(c)) out.push(c);
    if (c.children) find(c, pred, out);
  }
  return out;
}
export const findTag = (node, tag) => find(node, (n) => n.tag === tag);

const collapse = (s) => s.replace(/[ \t\r\n ]+/g, " ");

/**
 * Inline HTML → Markdown. `hooks.link(href, text)` rewrites hrefs (null → plain text);
 * `hooks.image(src, alt)` returns the Markdown image; `hooks.note(kind)` counts conversions.
 * Block elements (p, li, div, h1-6) become separate segments joined by `sep`.
 */
export function inlineMarkdown(node, hooks = {}, sep = " ") {
  const note = hooks.note ?? (() => {});
  const walk = (n) => {
    if (n.text !== undefined) return collapse(n.text).replace(/([*_`[\]])/g, "\\$1");
    const kids = () => (n.children ?? []).map(walk).join("");
    switch (n.tag) {
      case "strong":
      case "b": {
        const t = kids().trim();
        return t ? `**${t}**` : "";
      }
      case "em": {
        const t = kids().trim();
        return t ? `*${t}*` : "";
      }
      case "i": {
        // GitBook icons: <i class="fa-bolt">:bolt:</i>
        if (/\bfa-/.test(n.attrs.class ?? "")) {
          note("icon");
          return "";
        }
        const t = kids().trim();
        return t ? `*${t}*` : "";
      }
      case "s":
      case "del":
        return `~~${kids().trim()}~~`;
      case "code":
        return "`" + textOf(n).replace(/`/g, "'") + "`";
      case "kbd":
        return `:kbd[${textOf(n).trim()}]`;
      case "br":
        return sep === " " ? " " : sep;
      case "img": {
        note("img");
        return hooks.image ? hooks.image(n.attrs.src ?? "", n.attrs.alt ?? "") : "";
      }
      case "a": {
        const t = kids().trim() || n.attrs.href || "";
        const isButton = /\bbutton\b/.test(n.attrs.class ?? "");
        if (isButton) note("button");
        const href = hooks.link ? hooks.link(n.attrs.href ?? "", textOf(n)) : n.attrs.href;
        const md = href ? `[${t}](${href})` : t;
        return isButton ? `**${md}**` : md;
      }
      case "mark":
        note("mark");
        return kids();
      case "td":
      case "th":
      case "tr":
      case "thead":
      case "tbody":
      case "table":
      case "summary":
      case "section":
      case "caption":
      case "label":
      case "sup":
      case "sub":
      case "span":
      case "u":
      case "small":
      case "font":
        return kids();
      case "ul":
      case "ol":
        return (n.children ?? []).filter((c) => c.tag === "li").map((li) => `• ${walk(li).trim()}`).join(sep);
      case "p":
      case "div":
      case "li":
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
      case "figcaption":
      case "picture":
      case "figure":
        return `${sep}${kids().trim()}${sep}`;
      default:
        if (n.tag && n.tag !== "#root") note(`<${n.tag}>`);
        return kids();
    }
  };
  return walk(node)
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(sep)
    .trim();
}

/** `rgb(83 80 97)` / `83 80 97` / `83,80,97` → "#535061". */
export function rgbToHex(s) {
  const n = String(s).match(/\d+(\.\d+)?/g)?.map(Number);
  if (!n || n.length < 3) return null;
  return "#" + n.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/** Mixes a hex colour toward white (amount 0..1). */
export function lighten(hex, amount) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return null;
  const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return "#" + c.map((v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, "0")).join("");
}
