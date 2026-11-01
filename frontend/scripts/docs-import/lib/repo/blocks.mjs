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
 */

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
  const wrap = (open, lines) => ["", open, ...lines, c, ""];
  switch (n.kind) {
    case "note":
    case "tip":
    case "warning":
    case "danger":
      return wrap(`${c}${n.kind}${n.label ? `[${label(n.label)}]` : ""}`, kids());
    case "details":
      return wrap(`${c}details[${label(n.label || "Details")}]`, kids());
    case "tab":
      return ["", `${c}tab[${label(n.label || "Tab")}]`, ...kids(), c];
    case "card":
      return ["", `${c}card[${label(n.label || "Card")}]${attrs(n.attrs ?? {})}`, ...kids(), c];
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
          lines.push("", `### ${label(s.label || `Step ${k}`)}`, ...stepBody(trimBlank(renderNodes(s.children))));
        } else if (!isBlank(s)) lines.push(...renderNodes([s]));
      }
      if (!k) return renderNodes(n.children);
      return wrap(`${c}steps`, trimBlank(lines));
    }
    case "step":
      return ["", `### ${label(n.label || "Step")}`, ...stepBody(kids())];
    case "video":
      return ["", `::video${attrs({ id: n.attrs?.id, title: n.attrs?.title })}`, ""];
    case "embed":
      return ["", `::embed${attrs({ src: n.attrs?.src, title: n.attrs?.title })}`, ""];
    case "section":
      return ["", `### ${n.label}`, ...(n.description ? ["", n.description] : []), "", ...kids(), ""];
    case "field":
      return ["", n.line, ...(n.children.some((k) => !isBlank(k)) ? ["", ...kids()] : []), ""];
    case "plain":
    default:
      return ["", ...renderNodes(n.children), ""];
  }
}

/** Renders a whole tree (the root's text keeps its indentation) and tidies blank lines. */
export function renderTree(root) {
  const lines = renderNodes(root.children ?? [root], { dedent: false });
  return tidy(lines.join("\n"));
}

/** Collapses runs of blank lines outside code fences. */
export function tidy(md) {
  const out = [];
  let fence = null;
  let blank = 0;
  for (const l of md.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
    if (fence) {
      out.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      blank = 0;
      out.push(l);
      continue;
    }
    if (!l.trim()) {
      if (++blank > 1 || !out.length) continue;
      out.push("");
      continue;
    }
    blank = 0;
    out.push(l.replace(/[ \t]+$/, ""));
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n") + "\n";
}
