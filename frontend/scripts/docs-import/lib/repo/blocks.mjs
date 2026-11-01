/**
 * The block tree every repo format's components become, and its rendering into the engine's
 * directives (frontend/src/docs/render/plugins.ts). Rendering counts levels, so a container always
 * has more colons than what it holds, however the source nested it:
 *
 *   note | tip | warning | danger   :::note[label]          details   :::details[label]
 *   tabs > tab                      ::::tabs / :::tab[label]
 *   steps > step                    ::::steps / ### title (a step's own headings go below it)
 *   cards > card                    ::::cards{cols} / :::card[title]{href icon cover}
 *   video / embed                   ::video{id title} / ::embed{src title}
 *   plain                           its children, no wrapper
 *   section                         ### label + its children
 *   field                           **name** `type` line + its children
 *
 * Nodes: { type: "text", lines: [string] } | { type: "block", kind, label?, attrs?, children: [] }.
 *
 * Fidelity: text is never reflowed. Blank lines this module adds (around a directive) and lines a
 * conversion removes (an import, a comment, the duplicate H1) are written as SENT, a blank line
 * that `settle` merges into the blank lines the source already has, so the source's own spacing
 * stays byte for byte.
 */

/** A blank line the converter added or left behind (merged away by `settle`). U+2028 counts as whitespace for trim() and \s. */
export const SENT = " ";

export const CALLOUT_KINDS = new Set(["note", "tip", "warning", "danger"]);

export const text = (lines) => ({ type: "text", lines: Array.isArray(lines) ? lines : String(lines).split("\n") });
export const block = (kind, props = {}, children = []) => ({ type: "block", kind, ...props, children });

const isBlank = (n) => n.type === "text" && n.lines.every((l) => !l.trim());

/** Smallest indent of the non-blank lines. */
export function minIndent(lines) {
  let m = Infinity;
  for (const l of lines) if (l.trim()) m = Math.min(m, /^[ \t]*/.exec(l)[0].replace(/\t/g, "    ").length);
  return m === Infinity ? 0 : m;
}

/** Removes `n` columns of leading spaces (tabs count as 4). */
export function dedentLines(lines, n) {
  if (!n) return lines;
  return lines.map((l) => {
    let i = 0;
    let col = 0;
    while (i < l.length && col < n && (l[i] === " " || l[i] === "\t")) {
      col += l[i] === "\t" ? 4 : 1;
      i++;
    }
    return l.slice(i);
  });
}

export function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/** A directive label: one line, square brackets turned round. */
export const label = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")"));
/** A directive attribute value (double quotes inside become single, braces round). */
export const attrVal = (s) => String(s ?? "").replace(/"/g, "'").replace(/[{}]/g, (c) => (c === "{" ? "(" : ")")).replace(/\s+/g, " ");

const CONTAINER = new Set(["note", "tip", "warning", "danger", "details", "tab", "card"]);
const WRAPPER = new Set(["tabs", "steps", "cards"]);

/** Directive levels a node needs (0 for text). */
export function height(n) {
  if (n.type !== "block") return 0;
  const inner = Math.max(0, ...n.children.map(height));
  if (CONTAINER.has(n.kind)) return inner + 1;
  if (WRAPPER.has(n.kind)) return Math.max(2, inner + 1);
  return inner;
}

const colons = (h) => ":".repeat(2 + Math.max(1, h));

/** Renders a node list (one container's children: their text dedented together). */
export function renderNodes(nodes, { dedent = true } = {}) {
  const textLines = nodes.filter((n) => n.type === "text").flatMap((n) => n.lines);
  const ind = dedent ? minIndent(textLines) : 0;
  const out = [];
  for (const n of nodes) {
    if (n.type === "text") out.push(...dedentLines(n.lines, ind));
    else out.push(...renderBlock(n));
  }
  return out;
}

function attrs(obj) {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${attrVal(v)}"`);
  return parts.length ? `{${parts.join(" ")}}` : "";
}

/** Step body: headings at or above the step heading's depth move below it. */
const stepBody = (lines) => {
  let fence = null;
  return lines.map((l) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence && /^\s*(`{3,}|~{3,})\s*$/.test(l)) fence = null;
      return l;
    }
    if (fence) return l;
    return l.replace(/^(\s{0,3})(#{1,3})(\s)/, (_, s, _h, sp) => `${s}####${sp}`);
  });
};

export function renderBlock(n) {
  const h = height(n);
  const c = colons(h);
  const kids = () => trimBlank(renderNodes(n.children));
  const S = SENT;
  const wrap = (open, lines) => [S, open, ...lines, c, S];
  switch (n.kind) {
    case "note":
    case "tip":
    case "warning":
    case "danger":
      return wrap(`${c}${n.kind}${n.label ? `[${label(n.label)}]` : ""}`, kids());
    case "details":
      return wrap(`${c}details[${label(n.label || "Details")}]`, kids());
    case "tab":
      return [S, `${c}tab[${label(n.label || "Tab")}]`, ...kids(), c];
    case "card":
      return [S, `${c}card[${label(n.label || "Card")}]${attrs(n.attrs ?? {})}`, ...kids(), c];
    case "tabs":
    case "cards": {
      const want = n.kind === "tabs" ? "tab" : "card";
      const own = n.children.filter((k) => k.type === "block" && k.kind === want);
      const rest = n.children.filter((k) => !(k.type === "block" && k.kind === want) && !isBlank(k));
      if (!own.length) return renderNodes(n.children);
      const open = n.kind === "tabs" ? `${c}tabs` : `${c}cards${attrs(n.attrs ?? {})}`;
      // The engine keeps only the tabs/cards inside: anything else goes after the block.
      return [...wrap(open, own.flatMap((k) => renderBlock(k))), ...renderNodes(rest)];
    }
    case "steps": {
      const lines = [];
      let k = 0;
      for (const s of n.children) {
        if (s.type === "block" && s.kind === "step") {
          k++;
          lines.push(S, `### ${label(s.label || `Step ${k}`)}`, ...stepBody(trimBlank(renderNodes(s.children))));
        } else if (!isBlank(s)) lines.push(...renderNodes([s]));
      }
      if (!k) return renderNodes(n.children);
      return wrap(`${c}steps`, trimBlank(lines));
    }
    case "step":
      return [S, `### ${label(n.label || "Step")}`, ...stepBody(kids())];
    case "video":
      return [S, `::video${attrs({ id: n.attrs?.id, title: n.attrs?.title })}`, S];
    case "embed":
      return [S, `::embed${attrs({ src: n.attrs?.src, title: n.attrs?.title })}`, S];
    case "section":
      return [S, `### ${n.label}`, ...(n.description ? [S, n.description] : []), S, ...kids(), S];
    case "field":
      return [S, n.line, ...(n.children.some((k) => !isBlank(k)) ? [S, ...kids()] : []), S];
    case "plain":
    default:
      return [S, ...renderNodes(n.children), S];
  }
}

/** Renders a whole tree (the root's text keeps its indentation). SENT lines stay: see settle(). */
export function renderTree(root) {
  return renderNodes(root.children ?? [root], { dedent: false }).join("\n");
}

const blankLine = (l) => l === SENT || !l.trim();

/**
 * Merges SENT lines into the source's own blank lines: a run of blank lines without SENT stays
 * exactly as written; with SENT, the longest stretch of real blank lines stays (one blank line when
 * there is none); runs at the start or the end go. Code fences are left alone. Ends with one
 * newline. Nothing else changes.
 */
export function settle(md) {
  const out = [];
  let fence = null;
  let run = [];
  // The longest stretch of the source's own blank lines in the run (SENT lines split stretches:
  // blank lines on both sides of a removed line don't add up), else one blank line.
  const flush = () => {
    if (run.length && out.length) {
      let best = [];
      let cur = [];
      for (const l of run) {
        if (l === SENT) cur = [];
        else if ((cur = [...cur, l]).length > best.length) best = cur;
      }
      out.push(...(best.length ? best : [""]));
    }
    run = [];
  };
  for (const l of String(md).split("\n")) {
    if (fence) {
      out.push(l);
      const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (blankLine(l)) {
      run.push(l);
      continue;
    }
    flush();
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) fence = f[1];
    out.push(l.replaceAll(SENT, ""));
  }
  return out.length ? out.join("\n") + "\n" : "";
}

