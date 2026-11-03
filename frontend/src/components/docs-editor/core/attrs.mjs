/**
 * Block attributes on pages: the `{…}` list written after a block, the way Pandoc and kramdown
 * write attributes. Shared by the editor's converter (markdown.mjs) and the page renderer
 * (remarkPageBlocks), so both read a page the same way. Pure: no DOM, no React.
 *
 *   A paragraph or heading         Text of the block {#b-k3x9 color="red"}
 *   A list item / quote line       - Item text {bg="yellow"}
 *   A table cell                   | Cell {bg="blue"} |
 *   An image                       ![alt](asset:abc "Caption"){width="60%" align="center"}
 *   A table, code block, divider   the block, then a line holding only the list:
 *   or equation                      ```js … ```            | a | b | …
 *                                    {caption="Figure 1"}   (blank line)
 *                                                           {widths="120,240" header-column}
 *
 * Only known keys are read (per kind of block); anything else stays the text it was. Values are
 * `key="…"` (quoted) or `key=value`; `#b-…` is the block's anchor; a bare `key` is a flag ("").
 */

/** Notion's colours (text, or background with `bg`). "default" is the absence of one. */
export const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

/** Keys each kind of block carries. */
export const BLOCK_KEYS = {
  paragraph: ["id", "color", "bg"],
  heading: ["id", "color", "bg"],
  cell: ["bg", "color"],
  figure: ["id", "width", "align"],
  table: ["id", "widths", "header-column", "header-row"],
  codeBlock: ["id", "caption"],
  horizontalRule: ["id"],
  mathBlock: ["id"],
};

/** A block anchor: `b-` and 4–12 lowercase letters or digits. */
export const ANCHOR_RE = /^b-[a-z0-9]{4,12}$/;

const VALUE_OK = {
  id: (v) => ANCHOR_RE.test(v),
  color: (v) => COLORS.includes(v),
  bg: (v) => COLORS.includes(v),
  width: (v) => /^(?:100|[1-9]\d?(?:\.\d)?)%$/.test(v),
  align: (v) => v === "left" || v === "center" || v === "right",
  widths: (v) => /^\d{1,4}(?:,\d{0,4})*$/.test(v),
  "header-column": (v) => v === "",
  "header-row": (v) => v === "off",
  caption: (v) => !/[\n\r]/.test(v),
};

/**
 * Reads the inside of `{…}` into an object, or null when it isn't a list of known keys for `kind`
 * (unknown key, bad value, a key twice, a backslash or an entity: then it is just text).
 */
export function parseAttrList(inner, kind) {
  const allowed = BLOCK_KEYS[kind];
  if (!allowed || /[\\&]/.test(inner)) return null;
  const out = {};
  let s = inner.trim();
  if (!s) return null;
  while (s) {
    let m;
    let key;
    let value;
    if ((m = /^#([^\s"'=<>`{}]+)/.exec(s))) {
      key = "id";
      value = m[1];
    } else if ((m = /^([a-z][a-z-]*)="([^"]*)"/.exec(s))) {
      key = m[1];
      value = m[2];
    } else if ((m = /^([a-z][a-z-]*)=([^\s"'=<>`{}]+)/.exec(s))) {
      key = m[1];
      value = m[2];
    } else if ((m = /^([a-z][a-z-]*)(?=\s|$)/.exec(s))) {
      key = m[1];
      value = "";
    } else return null;
    if (!allowed.includes(key) || key in out || !VALUE_OK[key]?.(value)) return null;
    out[key] = value;
    s = s.slice(m[0].length);
    if (s && !/^\s/.test(s)) return null;
    s = s.trimStart();
  }
  return out;
}

/** `{#b-x key="v" flag}` for an attribute object (keys in a stable order), "" when empty. */
export function attrText(attrs) {
  if (!attrs) return "";
  const parts = [];
  if (attrs.id) parts.push(`#${attrs.id}`);
  for (const k of Object.keys(attrs).sort()) {
    if (k === "id") continue;
    const v = attrs[k];
    if (v === undefined || v === null) continue;
    parts.push(v === "" ? k : `${k}="${String(v).replace(/"/g, "'")}"`);
  }
  return parts.length ? `{${parts.join(" ")}}` : "";
}

/** null for an empty object, else a copy without empty values (what nodes store). */
export function cleanAttrs(attrs) {
  if (!attrs || typeof attrs !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && !(v === "" && k !== "header-column")) out[k] = k === "caption" ? captionText(v) : String(v);
  return Object.keys(out).length ? out : null;
}

/** A caption as an attribute value can hold it: no quotes, braces, backslashes or entities. */
export function captionText(v) {
  return String(v).replace(/"/g, "”").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\\/g, "/").replace(/&/g, "and").replace(/[\r\n]+/g, " ");
}

const TRAIL =/([ \t]*)\{([^{}\n]*)\}[ \t]*$/;

/**
 * The trailing `{…}` of a line of source, if it is an attribute list for `kind`:
 * `{ attrs, length }` (`length` = the characters to drop from the end, leading space included).
 * A brace escaped with a backslash is text.
 */
export function trailingAttrs(source, kind) {
  const m = TRAIL.exec(source);
  if (!m) return null;
  const at = source.length - m[0].length + m[1].length;
  if (at > 0 && source[at - 1] === "\\") return null;
  const attrs = parseAttrList(m[2], kind);
  if (!attrs) return null;
  return { attrs, length: m[0].length };
}

/** A whole line that is only an attribute list for `kind` (the line after a table, code block…). */
export function attrLine(source, kind) {
  const m = /^[ \t]*\{([^{}\n]*)\}[ \t]*$/.exec(source);
  return m ? parseAttrList(m[1], kind) : null;
}

/** A new block anchor: `b-` + 6 random base-36 characters, not in `taken`. */
export function newAnchor(taken = new Set(), rand = Math.random) {
  for (;;) {
    let s = "";
    for (let i = 0; i < 6; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)];
    const id = `b-${s}`;
    if (!taken.has(id)) return id;
  }
}

/** Inline colour (`:span[text]{color=red}` / `{bg=yellow}`): the attributes if they are one colour. */
export function spanColor(attributes) {
  if (!attributes) return null;
  const keys = Object.keys(attributes);
  if (keys.length !== 1) return null;
  const k = keys[0];
  if ((k === "color" || k === "bg") && COLORS.includes(attributes[k])) return { [k]: attributes[k] };
  return null;
}
