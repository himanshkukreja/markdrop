/**
 * Admonitions and content tabs from Markdown dialects, as block-tree nodes (lib/repo/blocks.mjs):
 *
 *   Docusaurus   :::note[Title] / :::note Title … :::   (info → note, caution/warning → warning)
 *   MkDocs       !!! note "Title" + a 4-space indented body → callout
 *                ??? note "Title" / ???+ → details;  === "Tab" + indented body → tabs
 *   GitHub       > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION] → callout
 *
 * `convertAdmonitions(src, {flavor})` renders a page's admonitions on their own (the converter
 * parses them together with MDX components in lib/repo/mdx.mjs).
 */
import { block, renderTree, settle, text } from "./blocks.mjs";

/** Docusaurus admonition types → the engine's callouts. */
export const DOCUSAURUS_KINDS = { note: "note", info: "note", important: "note", secondary: "note", tip: "tip", success: "tip", caution: "warning", warning: "warning", danger: "danger" };

/** Material for MkDocs admonition types → the engine's callouts. */
export const MKDOCS_KINDS = {
  note: "note", abstract: "note", summary: "note", tldr: "note", info: "note", todo: "note", question: "note", help: "note", faq: "note",
  tip: "tip", hint: "tip", important: "tip", success: "tip", check: "tip", done: "tip",
  warning: "warning", caution: "warning", attention: "warning",
  danger: "danger", error: "danger", failure: "danger", fail: "danger", missing: "danger", bug: "danger",
  example: "note", quote: "note", cite: "note",
};

/** GitHub alert types → callouts. */
export const GITHUB_ALERTS = { NOTE: "note", TIP: "tip", IMPORTANT: "note", WARNING: "warning", CAUTION: "danger" };

/** A Docusaurus admonition opening line → { colons, kind, type, title } or null. */
export function docusaurusOpen(line) {
  const m = /^\s*(:{3,})([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{[^}]*\})?[ \t]*(.*?)\s*$/.exec(line);
  if (!m) return null;
  const type = m[2].toLowerCase();
  return { colons: m[1].length, type, kind: DOCUSAURUS_KINDS[type] ?? null, title: (m[3] ?? m[4] ?? "").trim() };
}
export const docusaurusClose = (line) => {
  const m = /^\s*(:{3,})\s*$/.exec(line);
  return m ? m[1].length : 0;
};

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const indentOf = (l) => /^[ \t]*/.exec(l)[0].replace(/\t/g, "    ").length;

/**
 * GitHub alerts (`> [!NOTE]` blockquotes) → `<Note>`-style lines the component parser reads
 * (Note, Tip, Warning, Danger), outside code fences.
 */
export function githubAlertsToTags(lines, count = () => {}) {
  const out = [];
  let fence = null;
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
    const m = /^(\s{0,3})>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(l);
    if (!m) {
      out.push(l);
      continue;
    }
    const kind = GITHUB_ALERTS[m[2].toUpperCase()];
    const tag = { note: "Note", tip: "Tip", warning: "Warning", danger: "Danger" }[kind];
    const body = m[3].trim() ? [m[3]] : [];
    let j = i + 1;
    while (j < lines.length && /^\s{0,3}>/.test(lines[j])) body.push(lines[j++].replace(/^\s{0,3}>\s?/, ""));
    count("GitHub alert", `:::${kind}`);
    out.push(`${m[1]}<${tag}>`, ...body, `${m[1]}</${tag}>`);
    i = j - 1;
  }
  return out;
}

/**
 * MkDocs (Material) blocks in `lines` → tree nodes. `issue(kind, line, message)` for unknown types;
 * `line0` is the source line of lines[0].
 */
export function parseMkdocsBlocks(lines, { count = () => {}, issue = () => {}, line0 = 0 } = {}) {
  const nodes = [];
  let buf = [];
  const flush = () => {
    if (buf.length) nodes.push(text(buf));
    buf = [];
  };
  let fence = null;
  let i = 0;
  // A block body: the following lines indented 4+ (blank lines inside allowed), dedented by 4.
  const bodyFrom = (start, base) => {
    let j = start;
    let last = start - 1;
    let inFence = null;
    while (j < lines.length) {
      const l = lines[j];
      if (inFence) {
        const f = FENCE.exec(l);
        if (f && f[1][0] === inFence[0] && !f[2].trim()) inFence = null;
        last = j++;
        continue;
      }
      if (!l.trim()) {
        j++;
        continue;
      }
      if (indentOf(l) < base + 4) break;
      const f = FENCE.exec(l);
      if (f && !(f[1][0] === "`" && f[2].includes("`"))) inFence = f[1];
      last = j++;
    }
    const body = lines.slice(start, last + 1).map((l) => {
      let k = 0;
      let col = 0;
      while (k < l.length && col < base + 4 && (l[k] === " " || l[k] === "\t")) {
        col += l[k] === "\t" ? 4 : 1;
        k++;
      }
      return l.slice(k);
    });
    return { body, next: last + 1 };
  };
  while (i < lines.length) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (fence) {
      buf.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      i++;
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      buf.push(l);
      i++;
      continue;
    }
    const adm = /^(\s*)(!!!|\?\?\?\+?)[ \t]+([A-Za-z][\w-]*)((?:[ \t]+(?:inline|end))*)[ \t]*(?:"([^"]*)"|'([^']*)')?[ \t]*$/.exec(l);
    const tab = /^(\s*)===\+?[ \t]+(?:"([^"]*)"|'([^']*)')[ \t]*$/.exec(l);
    if (adm) {
      flush();
      const base = indentOf(adm[1]);
      const { body, next } = bodyFrom(i + 1, base);
      const type = adm[3].toLowerCase();
      const kind = MKDOCS_KINDS[type];
      if (!kind) issue("admonition", line0 + i, `MkDocs admonition type "${type}" has no match: used a note`);
      const title = adm[5] ?? adm[6];
      const inner = parseMkdocsBlocks(body, { count, issue, line0: line0 + i + 1 });
      if (adm[2].startsWith("???")) {
        count("MkDocs collapsible", ":::details[title]");
        nodes.push(block("details", { label: title || type[0].toUpperCase() + type.slice(1) }, inner));
      } else {
        count("MkDocs admonition", `:::${kind ?? "note"}`);
        // `!!! note ""` has no title; without a title, Material shows the type.
        nodes.push(block(kind ?? "note", { label: title === undefined ? "" : title }, inner));
      }
      i = next;
      continue;
    }
    if (tab) {
      flush();
      const tabs = [];
      const base = indentOf(tab[1]);
      let j = i;
      for (;;) {
        const t = /^(\s*)===\+?[ \t]+(?:"([^"]*)"|'([^']*)')[ \t]*$/.exec(lines[j] ?? "");
        if (!t || indentOf(t[1]) !== base) break;
        const { body, next } = bodyFrom(j + 1, base);
        tabs.push(block("tab", { label: t[2] ?? t[3] }, parseMkdocsBlocks(body, { count, issue, line0: line0 + j + 1 })));
        j = next;
        while (j < lines.length && !lines[j].trim()) j++;
        if (!/^(\s*)===/.test(lines[j] ?? "")) break;
      }
      count("MkDocs content tabs", "::::tabs + :::tab[label]");
      nodes.push(block("tabs", {}, tabs));
      i = j;
      continue;
    }
    buf.push(l);
    i++;
  }
  flush();
  return nodes;
}

/**
 * Renders a page's admonitions alone: flavor "docusaurus" (::: fences) or "mkdocs" (!!!, ???, ===);
 * GitHub alerts in both. Everything else is left as written.
 */
export function convertAdmonitions(src, { flavor = "docusaurus", count = () => {}, issue = () => {} } = {}) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (flavor === "mkdocs") return settle(renderTree({ children: parseMkdocsBlocks(lines, { count, issue }) }));
  // Docusaurus: a stack of open admonitions; a closing fence closes the innermost one.
  const root = { children: [] };
  const stack = [root];
  let buf = [];
  const top = () => stack[stack.length - 1];
  const flush = () => {
    if (buf.length) top().children.push(text(buf));
    buf = [];
  };
  let fence = null;
  lines.forEach((l, i) => {
    const f = FENCE.exec(l);
    if (fence) {
      buf.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      return;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      buf.push(l);
      return;
    }
    const open = docusaurusOpen(l);
    if (open) {
      flush();
      if (!open.kind) issue("admonition", i, `admonition type "${open.type}" has no match: used a note`);
      count("admonition", `:::${open.kind ?? "note"}`);
      const node = block(open.kind ?? "note", { label: open.title }, []);
      top().children.push(node);
      stack.push(node);
      return;
    }
    if (docusaurusClose(l) && stack.length > 1) {
      flush();
      stack.pop();
      return;
    }
    buf.push(l);
  });
  flush();
  return settle(renderTree(root));
}
