/**
 * MDX and HTML components → the engine's directives (pure: no fs, no network; the ctx resolves
 * links, images, icons and videos). Reads components as text, never runs them.
 *
 * Mintlify:   Note/Info → note, Tip/Check → tip, Warning → warning, Danger → danger, Callout → note;
 *             CardGroup/Columns + Card → cards (a lone Card: a one-card grid); Tabs/Tab → tabs;
 *             Steps/Step → steps; AccordionGroup/Accordion, Expandable → details; CodeGroup,
 *             RequestExample, ResponseExample → tabs (one per fence); Frame → its image, the caption
 *             as the image title; ResponseField/ParamField → a **name** `type` line + body;
 *             Update → ### label section; Icon dropped; Tooltip → its text; snippets inlined.
 * Docusaurus: Tabs/TabItem → tabs; Admonition → callout; :::note fences → callouts (lib/repo/
 *             admonitions.mjs); CodeBlock → a fence.
 * Everywhere: <details><summary> → details; <iframe> YouTube/Vimeo/Loom → ::video, other https →
 *             ::embed; GitHub alerts → callouts; a <div>/<section>/<center> alone on its line is
 *             unwrapped; HTML comments dropped; in MDX also {/* comments *\/} and import/export lines.
 *             Any other capitalised component: its content kept, its tags dropped (reported).
 */
import { SENT, block, renderTree, settle, text, trimBlank, minIndent, dedentLines } from "./blocks.mjs";
import { DOCUSAURUS_KINDS, docusaurusClose, docusaurusOpen, githubAlertsToTags, parseMkdocsBlocks } from "./admonitions.mjs";
import { videoProvider } from "../convert.mjs";
import { decodeEntities } from "../html.mjs";

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const MDX_FLAVORS = new Set(["mintlify", "docusaurus"]);
/** Lowercase HTML tags this parser reads (the rest is lib/convert.mjs's). */
const HTML_BLOCKS = new Set(["details", "summary", "iframe", "div", "section", "center", "article", "main"]);
const UNWRAP = new Set(["div", "section", "center", "article", "main", "Fragment", ""]);
/** Components that sit inside a line of text. */
const INLINE = new Set(["Tooltip", "Icon", "Badge", "Kbd", "Tag"]);
/** Components a line of their own (and their content) never belongs to a paragraph. */
const KNOWN_BLOCKS = new Set([
  "Note", "Info", "Tip", "Check", "Warning", "Danger", "Callout", "CardGroup", "Columns", "Card", "Tabs", "Tab", "Steps", "Step",
  "AccordionGroup", "Accordion", "Expandable", "CodeGroup", "RequestExample", "ResponseExample", "Frame", "ResponseField", "ParamField",
  "Update", "Panel", "TabItem", "Admonition", "CodeBlock", "Tree", "Color", "Visibility", "Prompt", "Tile", "View", "Column", "Banner",
]);

/* ── preprocessing ───────────────────────────────────────────────────────── */

/** Applies fn(lines) → lines (same count) to each run of lines outside code fences. */
function outsideFences(lines, fn) {
  const out = [];
  let run = [];
  let fence = null;
  const flush = () => {
    if (run.length) out.push(...fn(run));
    run = [];
  };
  for (const l of lines) {
    const f = FENCE.exec(l);
    if (fence) {
      out.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      flush();
      fence = f[1];
      out.push(l);
      continue;
    }
    run.push(l);
  }
  flush();
  return out;
}

const keepLines = (m) => m.replace(/[^\n]/g, "");

/** HTML comments (and MDX {/* *\/} comments) → blank, keeping line numbers. */
export function stripComments(lines, mdx) {
  return outsideFences(lines, (run) => {
    const src = run.join("\n");
    let s = src.replace(/<!--[\s\S]*?-->/g, keepLines);
    if (mdx) s = s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, keepLines);
    if (s === src) return run;
    // A line the removal emptied is a SENT blank (merged into the blank lines around it).
    return s.split("\n").map((l, i) => (!l.trim() && run[i]?.trim() ? SENT : l));
  });
}

/** MDX import/export statements → blank lines. Returns { lines, imports: Map(name → module) }. */
export function stripModuleLines(lines) {
  const imports = new Map();
  const balanced = (s) => {
    let d = 0;
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === "\\") i++;
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if ("{[(".includes(c)) d++;
      else if ("}])".includes(c)) d--;
    }
    return d <= 0 && !q;
  };
  const out = outsideFences(lines, (run) => {
    const r = [...run];
    for (let i = 0; i < r.length; i++) {
      if (!/^(import|export)\s/.test(r[i])) continue;
      let j = i;
      let stmt = r[i];
      while (j + 1 < r.length && j - i < 60) {
        const t = stmt.trimEnd();
        if (balanced(stmt) && (/[;'"`})\]]$/.test(t) || !r[j + 1].trim())) break;
        stmt += "\n" + r[++j];
      }
      const m = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/.exec(stmt);
      if (m) imports.set(m[1], m[2]);
      for (let k = i; k <= j; k++) r[k] = SENT;
      i = j;
    }
    return r;
  });
  return { lines: out, imports };
}

/* ── tags ────────────────────────────────────────────────────────────────── */

/** JSX attributes → { name: value }: "x", 'x', {2} → "2", {"x"} → "x", bare → "true", {expr} → "{expr}". */
export function parseJsxAttrs(src) {
  const out = {};
  const s = String(src ?? "");
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === "{") {
      // {...spread}
      const e = skipBraces(s, i);
      i = e;
      continue;
    }
    const m = /^[A-Za-z_:][\w:.-]*/.exec(s.slice(i));
    if (!m) {
      i++;
      continue;
    }
    const name = m[0];
    i += name.length;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== "=") {
      out[name] = "true";
      continue;
    }
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    const q = s[i];
    if (q === '"' || q === "'") {
      const e = s.indexOf(q, i + 1);
      out[name] = decodeEntities(s.slice(i + 1, e < 0 ? s.length : e));
      i = e < 0 ? s.length : e + 1;
    } else if (q === "{") {
      const e = skipBraces(s, i);
      const expr = s.slice(i + 1, e - 1).trim();
      const lit = /^(["'`])([\s\S]*)\1$/.exec(expr);
      out[name] = lit ? lit[2] : /^(-?\d+(\.\d+)?|true|false|null)$/.test(expr) ? expr : `{${expr}}`;
      i = e;
    } else {
      const m2 = /^[^\s>]+/.exec(s.slice(i));
      out[name] = m2 ? m2[0] : "";
      i += m2 ? m2[0].length : 1;
    }
  }
  return out;
}

/** Index after the brace group starting at s[i] === "{" (strings inside respected). */
function skipBraces(s, i) {
  let d = 0;
  let q = null;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (c === "\\") k++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") d++;
    else if (c === "}" && --d === 0) return k + 1;
  }
  return s.length;
}

/** The tag starting at s[i] ("<") → { close, name, attrs, self, end } | { incomplete } | null. */
function scanTag(s, i, isTag) {
  const m = /^<(\/?)([A-Za-z][\w.-]*)?/.exec(s.slice(i, i + 80));
  if (!m) return null;
  const close = !!m[1];
  const name = m[2] ?? "";
  if (name ? !isTag(name) : s[i + m[0].length] !== ">") return null; // <> fragments only
  let k = i + m[0].length;
  const a = k;
  let q = null;
  for (; k < s.length; k++) {
    const c = s[k];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === "{") k = skipBraces(s, k) - 1;
    else if (c === ">") {
      const self = s[k - 1] === "/";
      const attrSrc = s.slice(a, self ? k - 1 : k);
      if (name && attrSrc && !/^\s/.test(attrSrc)) return null; // <Foo.bar…> spelled oddly: not a tag
      return { close, name, attrs: close ? {} : parseJsxAttrs(attrSrc), self, end: k + 1 };
    }
  }
  return { incomplete: true };
}

/** Masks `inline code` with spaces so tags inside it aren't read. */
const maskCode = (l) => l.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (m) => " ".repeat(m.length));

/**
 * Lines → a raw tree: { type: "el", name, attrs, children, line } and text nodes. `flavor` decides
 * which tags are components; Docusaurus also reads ::: admonition fences.
 */
export function parseComponents(lines, { flavor = "mintlify", line0 = 0, issue = () => {}, count = () => {} } = {}) {
  const mdx = MDX_FLAVORS.has(flavor);
  const isTag = (name) => (mdx && /^[A-Z]/.test(name)) || HTML_BLOCKS.has(name) || (!mdx && /^(Note|Tip|Warning|Danger)$/.test(name));
  const root = { type: "el", name: "#root", attrs: {}, children: [], line: line0 };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let buf = [];
  const flush = () => {
    if (buf.length) top().children.push(text(buf));
    buf = [];
  };
  const openEl = (name, attrs, line, self) => {
    flush();
    const el = { type: "el", name, attrs, children: [], line };
    top().children.push(el);
    if (!self) stack.push(el);
  };
  const closeEl = (name, line) => {
    flush();
    const at = stack.map((e) => e.name).lastIndexOf(name);
    if (at > 0) {
      for (let k = stack.length - 1; k > at; k--) issue("component", stack[k].line, `<${stack[k].name}> was not closed: closed at </${name}>`);
      stack.length = at;
    } else issue("component", line, `</${name || ""}> without an opening tag: dropped`);
  };

  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    const ln = line0 + i;
    const f = FENCE.exec(l);
    if (fence) {
      buf.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      buf.push(l);
      continue;
    }
    if (flavor === "docusaurus") {
      const open = docusaurusOpen(l);
      if (open) {
        openEl("::admonition", { type: open.type, title: open.title }, ln, false);
        continue;
      }
      if (docusaurusClose(l) && stack.some((e) => e.name === "::admonition")) {
        closeEl("::admonition", ln);
        continue;
      }
    }
    if (!l.includes("<")) {
      buf.push(l);
      continue;
    }
    // Inline components first: Tooltip → its text, Icon dropped, other inline ones unwrapped.
    if (mdx) l = inlineComponents(l, count, issue, ln);
    // A tag split over lines: join until it closes.
    let masked = maskCode(l);
    for (let guard = 0; guard < 60; guard++) {
      const lt = [...masked.matchAll(/</g)].map((m) => m.index);
      const pending = lt.map((p) => scanTag(masked, p, isTag)).find((t) => t?.incomplete);
      if (!pending || i + 1 >= lines.length) break;
      l += "\n" + lines[++i];
      masked = maskCode(l);
    }
    const tags = [];
    for (let p = masked.indexOf("<"); p >= 0; p = masked.indexOf("<", p + 1)) {
      const t = scanTag(masked, p, isTag);
      if (t && !t.incomplete) {
        tags.push({ ...t, at: p });
        p = t.end - 1;
      }
    }
    if (!tags.length) {
      buf.push(...l.split("\n"));
      continue;
    }
    // Unknown capitalised tags with text around them on the line: inline, unwrapped.
    let last = 0;
    const indent = /^[ \t]*/.exec(l)[0];
    for (const t of tags) {
      const before = l.slice(last, t.at);
      if (before.trim()) buf.push((last ? indent : "") + before.replace(/\s+$/, "").replace(/\n\s*/g, " "));
      if (t.close) closeEl(t.name, ln);
      else openEl(t.name, t.attrs, ln, t.self);
      last = t.end;
    }
    const after = l.slice(last);
    if (after.trim()) buf.push(indent + after.trim());
  }
  flush();
  for (let k = stack.length - 1; k > 0; k--) issue("component", stack[k].line, `<${stack[k].name}> was not closed: closed at the end of the page`);
  return root;
}

/** Tooltip, Icon and other inline components in one line of text. */
function inlineComponents(l, count, issue, ln) {
  let s = l;
  s = s.replace(/<Icon\b(?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*\/>(?:\s*<\/Icon>)?/g, () => {
    count("<Icon>", "dropped (no inline icons)");
    return "";
  });
  s = s.replace(/<(Tooltip|Badge|Kbd|Tag)\b(?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*>([\s\S]*?)<\/\1>/g, (_, name, inner) => {
    count(`<${name}>`, "its text kept");
    return name === "Kbd" ? `<kbd>${inner}</kbd>` : inner;
  });
  // An unknown component wrapped around text in the middle of a line: unwrapped.
  s = s.replace(/(\S[^<]*?)<([A-Z][\w.]*)\b(?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*>([^<]*)<\/\2>/g, (m, pre, name, inner) => {
    if (KNOWN_BLOCKS.has(name) || INLINE.has(name)) return m;
    count(`<${name}>`, "unknown inline component: text kept");
    issue("component", ln, `<${name}> isn't supported: its text was kept`);
    return pre + inner;
  });
  return s;
}

/* ── normalising: raw elements → block nodes ─────────────────────────────── */

const MINTLIFY_CALLOUTS = { Note: "note", Info: "note", Tip: "tip", Check: "tip", Warning: "warning", Danger: "danger", Callout: "note" };
const plainText = (nodes) =>
  nodes
    .flatMap((n) => (n.type === "text" ? n.lines : n.children ? [plainText(n.children)] : []))
    .join(" ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
const isBlankNode = (n) => n.type === "text" && n.lines.every((x) => !x.trim());

/** Fences in a code group's text → tabs (one per fence, labelled by title=, the meta word, or the language). */
function codeTabs(nodes, ctx, line) {
  const lines = nodes.flatMap((n) => (n.type === "text" ? n.lines : []));
  const body = dedentLines(lines, minIndent(lines));
  const tabs = [];
  const rest = [];
  for (let i = 0; i < body.length; i++) {
    const f = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/.exec(body[i]);
    if (!f) {
      if (body[i].trim()) rest.push(body[i]);
      continue;
    }
    const [, ind, mark, lang, meta] = f;
    const title = /\btitle=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
    const word = meta.replace(/\b\w+=(?:"[^"]*"|'[^']*'|\S+)/g, "").replace(/[{}]/g, "").trim();
    const name = title?.[1] ?? title?.[2] ?? title?.[3] ?? (word || lang || `Code ${tabs.length + 1}`);
    const code = [`${ind}${mark}${lang}`];
    let j = i + 1;
    for (; j < body.length; j++) {
      code.push(body[j]);
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(body[j]);
      if (c && c[1][0] === mark[0] && c[1].length >= mark.length) break;
    }
    tabs.push(block("tab", { label: name }, [text(code)]));
    i = j;
  }
  if (rest.length) ctx.issue("code group", line, "text outside the code blocks of a code group was moved after it");
  if (!tabs.length) return [text(body)];
  if (tabs.length === 1) return [...tabs[0].children, ...(rest.length ? [text(rest)] : [])];
  return [block("tabs", {}, tabs), ...(rest.length ? [text(["", ...rest])] : [])];
}

/** Puts `caption` on the first image in a Frame (Markdown or <img>). */
function captionImages(nodes, caption) {
  let done = false;
  const cap = String(caption).replace(/"/g, "'");
  const fix = (l) => {
    if (done) return l;
    let s = l.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/, (_, alt, src) => {
      done = true;
      return cap ? `![${alt}](${src} "${cap}")` : `![${alt}](${src})`;
    });
    if (done) return s;
    s = s.replace(/<img\b([^>]*?)\/?>/i, (m, a) => {
      const attrs = parseJsxAttrs(a);
      if (!attrs.src) return m;
      done = true;
      return `![${(attrs.alt ?? "").replace(/[[\]]/g, "")}](${attrs.src}${cap ? ` "${cap}"` : ""})`;
    });
    return s;
  };
  const walk = (ns) => ns.map((n) => (n.type === "text" ? { ...n, lines: n.lines.map(fix) } : { ...n, children: walk(n.children) }));
  return walk(nodes);
}

/**
 * Raw tree → block nodes. ctx: count, issue, link(href) → href|null, image(src, {decorative}) →
 * {src}|null, icon(name) → icon|undefined, video(url, title) → id|null.
 */
export function normalize(nodes, ctx, state = { videos: 0 }, parent = "#root") {
  const out = [];
  for (const n of nodes) {
    if (n.type === "text") out.push(n);
    else out.push(...normalizeEl(n, ctx, state, parent));
  }
  // Mintlify <View title> siblings (one view per language or audience): tabs.
  const grouped = [];
  for (let i = 0; i < out.length; i++) {
    if (!out[i].fromView) {
      grouped.push(out[i]);
      continue;
    }
    const views = [];
    let j = i;
    while (j < out.length && (out[j].fromView || isBlankNode(out[j]))) {
      if (out[j].fromView) views.push(out[j]);
      j++;
    }
    grouped.push(views.length > 1 ? block("tabs", {}, views) : block("plain", {}, views[0].children));
    i = j - 1;
  }
  return grouped;
}

/** A Mintlify <Tree> as a ```text block: folders end in "/", children indented two spaces. */
function treeText(el, depth = 0, out = []) {
  for (const k of el.children) {
    if (k.type !== "el") continue;
    const name = k.attrs?.name ?? "";
    if (/Folder$/.test(k.name)) {
      out.push(`${"  ".repeat(depth)}${name}/`);
      treeText(k, depth + 1, out);
    } else if (/File$/.test(k.name)) out.push(`${"  ".repeat(depth)}${name}`);
    else treeText(k, depth, out);
  }
  return out;
}

/** Mintlify <Color> palettes as lines: **row title** then `- name: `value``. */
function colorLines(el, out = []) {
  for (const k of el.children) {
    if (k.type !== "el") continue;
    if (/Row$/.test(k.name)) {
      if (k.attrs?.title) out.push("", `**${k.attrs.title}**`, "");
      colorLines(k, out);
    } else if (/Item$/.test(k.name)) out.push(`- ${k.attrs?.name ? `${k.attrs.name}: ` : ""}\`${k.attrs?.value ?? ""}\``);
    else colorLines(k, out);
  }
  return out;
}

function normalizeEl(el, ctx, state, parent) {
  const a = el.attrs ?? {};
  const kids = () => normalize(el.children, ctx, state, el.name);
  const name = el.name;
  const counted = (how) => ctx.count(`<${name}>`, how);
  if (name === "::admonition") {
    const kind = DOCUSAURUS_KINDS[a.type];
    if (!kind) ctx.issue("admonition", el.line, `admonition type "${a.type}" has no match: used a note`);
    ctx.count("admonition", `:::${kind ?? "note"}`);
    return [block(kind ?? "note", { label: a.title ?? "" }, kids())];
  }
  if (MINTLIFY_CALLOUTS[name]) {
    const kind = name === "Callout" && a.type ? DOCUSAURUS_KINDS[String(a.type).toLowerCase()] ?? "note" : MINTLIFY_CALLOUTS[name];
    counted(`:::${kind}`);
    return [block(kind, { label: a.title ?? "" }, kids())];
  }
  switch (name) {
    case "Admonition": {
      const type = String(a.type ?? "note").toLowerCase();
      const kind = DOCUSAURUS_KINDS[type];
      if (!kind) ctx.issue("admonition", el.line, `admonition type "${type}" has no match: used a note`);
      counted(`:::${kind ?? "note"}`);
      return [block(kind ?? "note", { label: a.title ?? "" }, kids())];
    }
    case "CardGroup":
    case "Columns": {
      const children = kids();
      if (!children.some((k) => k.type === "block" && k.kind === "card")) return [block("plain", {}, children)];
      counted("::::cards");
      const cols = /^\d$/.test(a.cols ?? "") ? a.cols : undefined;
      return [block("cards", { attrs: { cols } }, children)];
    }
    case "Card": {
      counted(":::card[title]{href icon}");
      const href = a.href ? ctx.link(a.href, { line: el.line }) ?? undefined : undefined;
      const icon = a.icon && !a.icon.startsWith("{") ? ctx.icon(a.icon, { line: el.line }) : undefined;
      const cover = a.img ? ctx.image(a.img, { decorative: true, line: el.line })?.src : undefined;
      const card = block("card", { label: a.title ?? "", attrs: { href, icon, cover } }, kids());
      return parent === "CardGroup" || parent === "Columns" ? [card] : [block("cards", { attrs: {} }, [card])];
    }
    case "Tabs": {
      counted("::::tabs + :::tab[label]");
      const children = kids();
      if (!children.some((k) => k.type === "block" && k.kind === "tab")) return [block("plain", {}, children)];
      return [block("tabs", {}, children)];
    }
    case "Tab":
    case "TabItem": {
      const tab = block("tab", { label: a.title ?? a.label ?? a.value ?? "" }, kids());
      if (parent !== "Tabs") {
        ctx.issue("tabs", el.line, `<${name}> outside <Tabs>: content kept without the tab`);
        return [block("plain", {}, tab.children)];
      }
      return [tab];
    }
    case "Steps":
      counted("::::steps with ### step headings");
      return [block("steps", {}, kids())];
    case "Step":
      if (parent !== "Steps") return [block("section", { label: a.title ?? "Step" }, kids())];
      return [block("step", { label: a.title ?? "" }, kids())];
    case "AccordionGroup":
      return [block("plain", {}, kids())];
    case "Accordion":
    case "Expandable":
      counted(":::details[title]");
      return [block("details", { label: a.title ?? (name === "Expandable" ? "Properties" : "Details") }, kids())];
    case "details": {
      counted(":::details[summary]");
      const children = el.children;
      const sum = children.find((k) => k.type === "el" && k.name === "summary");
      let summary = sum ? plainText(sum.children) : "";
      let rest = children.filter((k) => k !== sum);
      if (!sum) {
        // <summary> written inline in the first text line.
        const t = rest.find((k) => k.type === "text" && k.lines.some((x) => /<summary\b/i.test(x)));
        if (t) {
          const idx = t.lines.findIndex((x) => /<summary\b/i.test(x));
          const m = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(t.lines[idx]);
          if (m) {
            summary = m[1].replace(/<[^>]+>/g, "").trim();
            rest = rest.map((k) => (k === t ? { ...t, lines: t.lines.map((x, j) => (j === idx ? x.replace(m[0], "") : x)) } : k));
          }
        }
      }
      if (!summary) ctx.issue("<details>", el.line, "<details> without <summary>: labelled “Details”");
      return [block("details", { label: summary.replace(/\*\*/g, "") || "Details" }, normalize(rest, ctx, state, name))];
    }
    case "summary":
      return [block("plain", {}, [text([`**${plainText(el.children)}**`])])];
    case "CodeGroup":
    case "RequestExample":
    case "ResponseExample":
      counted("::::tabs, one :::tab per code block");
      return codeTabs(el.children, ctx, el.line);
    case "Frame": {
      counted(a.caption ? "image with its caption as the title" : "unwrapped");
      return [block("plain", {}, captionImages(kids(), a.caption ?? ""))];
    }
    case "ResponseField":
    case "ParamField": {
      const field = a.name ?? a.path ?? a.query ?? a.body ?? a.header ?? a.param ?? a.cookie ?? "";
      const type = a.type && !a.type.startsWith("{") ? ` \`${a.type}\`` : "";
      const extra = [a.required === "true" ? "required" : "", a.default !== undefined && !String(a.default).startsWith("{") ? `default: \`${a.default}\`` : ""].filter(Boolean);
      counted("**name** `type` line + its description");
      return [block("field", { line: `**${field}**${type}${extra.length ? ` (${extra.join(", ")})` : ""}` }, kids())];
    }
    case "Update":
      counted("### label section");
      return [block("section", { label: a.label ?? "Update", description: a.description ?? "" }, kids())];
    case "Tree":
      counted("```text file tree");
      return [text([SENT, "```text", ...treeText(el), "```", SENT])];
    case "Color":
      counted("a list of colour names and values");
      return [text([SENT, ...colorLines(el), SENT])];
    case "Visibility": {
      const who = String(a.for ?? "humans").toLowerCase();
      if (who === "agents") {
        counted("content for AI agents only: dropped");
        return [text([SENT])];
      }
      counted("its content kept");
      return [block("plain", {}, kids())];
    }
    case "Prompt": {
      // Copyable text, soft-wrapped (like the GitBook import's {% prompt %}).
      const lines = el.children.flatMap((k) => (k.type === "text" ? k.lines : []));
      const body = trimBlank(dedentLines(lines, minIndent(lines)));
      const title = String(a.description ?? a.title ?? "Prompt").replace(/"/g, "'");
      counted("```text wrap fence titled with the description");
      return [text([SENT, `\`\`\`text wrap title="${title}"`, ...body, "```", SENT])];
    }
    case "Tile": {
      counted(":::card[title]{href}");
      const href = a.href ? ctx.link(a.href, { line: el.line }) ?? undefined : undefined;
      const card = block("card", { label: a.title ?? "", attrs: { href } }, a.description ? [text([a.description])] : []);
      return parent === "Columns" || parent === "CardGroup" || parent === "Tiles" ? [card] : [block("cards", { attrs: {} }, [card])];
    }
    case "View": {
      counted("tabs (one per view)");
      const tab = block("tab", { label: a.title ?? a.name ?? "View" }, kids());
      tab.fromView = true;
      return [tab];
    }
    case "Column":
    case "Banner":
      return [block("plain", {}, kids())];
    case "Icon":
      counted("dropped (no inline icons)");
      return [text([SENT])];
    case "Tooltip":
    case "Badge":
    case "Panel":
      counted("its content kept");
      return [block("plain", {}, kids())];
    case "CodeBlock": {
      const lines = el.children.flatMap((k) => (k.type === "text" ? k.lines : []));
      let code = dedentLines(lines, minIndent(lines)).join("\n").trim();
      code = code.replace(/^\{\s*`([\s\S]*)`\s*\}$/, "$1").replace(/^\{\s*(["'])([\s\S]*)\1\s*\}$/, "$2");
      counted("fenced code block");
      return [text(["", `\`\`\`${a.language ?? ""}${a.title ? ` title="${a.title.replace(/"/g, "'")}"` : ""}`, ...code.split("\n"), "```", ""])];
    }
    case "iframe": {
      const src = (a.src ?? "").replace(/^\/\//, "https://");
      const title = a.title ?? "";
      if (!/^https:\/\//.test(src.replace(/^http:/, "https:"))) {
        ctx.issue("<iframe>", el.line, `iframe without an https address: dropped`);
        return [text([SENT])];
      }
      if (videoProvider(src) && state.videos === 0) {
        const id = ctx.video(src, title || "Video");
        if (id) {
          state.videos++;
          ctx.count("<iframe>", "::video (videos.json)");
          return [block("video", { attrs: { id, title: title || "Video" } })];
        }
      }
      ctx.count("<iframe>", "::embed{src title}");
      let host = "Embedded page";
      try {
        host = new URL(src).hostname;
      } catch {
        /* keep the default */
      }
      return [block("embed", { attrs: { src: src.replace(/^http:/, "https:"), title: title || host } })];
    }
    default: {
      if (UNWRAP.has(name)) return [block("plain", {}, kids())];
      const children = kids();
      if (!children.some((k) => !isBlankNode(k))) {
        ctx.count(`<${name}>`, "unknown component: dropped");
        ctx.issue("component", el.line, `<${name} /> isn't supported: dropped`);
        return [text([SENT])];
      }
      ctx.count(`<${name}>`, "unknown component: content kept, tags dropped");
      ctx.issue("component", el.line, `<${name}> isn't supported: its content was kept without it`);
      return [block("plain", {}, children)];
    }
  }
}

/* ── one page ────────────────────────────────────────────────────────────── */

const noop = () => {};
const defaultCtx = {
  count: noop,
  issue: noop,
  link: (h) => h,
  image: (src) => ({ src }),
  icon: () => undefined,
  video: () => null,
  snippet: () => null,
};

/**
 * Inlines Mintlify snippets: a line holding only `<Name />` where `Name` was imported from a .md/.mdx
 * file → that file's text (ctx.snippet(module) → text | null), nested up to 3 deep.
 */
function inlineSnippets(lines, imports, ctx, depth = 0) {
  if (!imports.size || depth > 3) return lines;
  const out = [];
  for (const l of lines) {
    const m = /^(\s*)<([A-Z][\w]*)\s*\/>\s*$/.exec(l);
    const mod = m && imports.get(m[2]);
    if (!mod || !/\.mdx?$/i.test(mod)) {
      out.push(l);
      continue;
    }
    const src = ctx.snippet(mod);
    if (src == null) {
      out.push(l);
      continue;
    }
    ctx.count("snippet", "inlined");
    const body = String(src).replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
    const inner = stripModuleLines(stripComments(body.split("\n"), true));
    out.push(...inlineSnippets(inner.lines, inner.imports, ctx, depth + 1).map((x) => (x ? m[1] + x : x)));
  }
  return out;
}

/**
 * A void tag written over several lines (`<img\n  alt="…"\n  src="…"\n/>`, common in Mintlify docs)
 * → one line, so the image, iframe or video is converted like a one-line tag. Only outside code.
 */
function joinTags(lines) {
  return outsideFences(lines, (run) => {
    const out = [];
    for (let i = 0; i < run.length; i++) {
      const l = run[i];
      const m = /^(\s*)<(img|iframe|video|source)\b(?:[^>"']|"[^"]*"|'[^']*')*$/i.exec(l);
      if (!m) {
        out.push(l);
        continue;
      }
      let j = i;
      let joined = l.trimEnd();
      while (j + 1 < run.length && j - i < 40 && !/>\s*$/.test(joined)) joined += " " + run[++j].trim();
      if (!/>\s*$/.test(joined)) {
        out.push(l);
        continue;
      }
      out.push(joined);
      i = j;
    }
    return out;
  });
}

/**
 * Inline <svg> drawings (an icon after a link, a decorative mark): the guide never renders raw SVG,
 * so they are dropped (counted), on one line or over several. Code is left alone.
 */
function dropInlineSvg(lines, ctx) {
  return outsideFences(lines, (run) => {
    const out = [];
    for (let i = 0; i < run.length; i++) {
      let l = run[i];
      if (/<svg\b/i.test(l) && !/<\/svg>/i.test(l)) {
        let j = i;
        let joined = l;
        while (j + 1 < run.length && j - i < 200 && !/<\/svg>/i.test(joined)) joined += "\n" + run[++j];
        if (/<\/svg>/i.test(joined)) {
          l = joined;
          i = j;
        }
      }
      const s2 = l.replace(/<svg\b[\s\S]*?<\/svg>/gi, () => {
        ctx.count("inline <svg>", "dropped (a drawing in the page's HTML)");
        return "";
      });
      if (s2 === l) out.push(l);
      else if (s2.trim()) out.push(s2.replace(/[ \t]+$/, ""));
    }
    return out;
  });
}

/** Dark-only images (`className="hidden dark:block"`): the light twin is the one imported. */
function dropDarkOnly(lines, ctx) {
  return outsideFences(lines, (run) =>
    run.map((l) => {
      const s = l.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*\bclass(?:Name)?=["'][^"']*\bdark:block\b[^"']*["'](?:[^>"']|"[^"]*"|'[^']*')*\/?>/g, () => {
        ctx.count("dark-only image", "dropped (the light image stays)");
        return "";
      });
      return s !== l && !s.trim() ? SENT : s;
    }),
  );
}

/**
 * A page body (front matter already removed) → Markdown with the engine's directives.
 * flavor: "mintlify" | "docusaurus" (MDX) | "markdown" | "mkdocs".
 */
export function convertMdx(src, { flavor = "mintlify", line0 = 0, ctx: given = {}, raw = false } = {}) {
  const ctx = { ...defaultCtx, ...given };
  const mdx = MDX_FLAVORS.has(flavor);
  let lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  lines = stripComments(lines, mdx);
  if (mdx) {
    const mod = stripModuleLines(lines);
    lines = inlineSnippets(mod.lines, mod.imports, ctx);
    lines = outsideFences(lines, (run) => run.map((l) => l.replace(/\{\s*(["'])\s\1\s*\}/g, " ")));
    lines = dropDarkOnly(joinTags(lines), ctx);
  }
  lines = dropInlineSvg(lines, ctx);
  lines = githubAlertsToTags(lines, ctx.count);
  const state = { videos: 0 };
  const toNodes = (ls, at) => normalize(parseComponents(ls, { flavor, line0: at, issue: ctx.issue, count: ctx.count }).children, ctx, state);
  let nodes;
  if (flavor === "mkdocs") {
    const expand = (ns) => ns.flatMap((n) => (n.type === "text" ? toNodes(n.lines, line0) : [{ ...n, children: expand(n.children) }]));
    nodes = expand(parseMkdocsBlocks(lines, { count: ctx.count, issue: ctx.issue, line0 }));
  } else nodes = toNodes(lines, line0);
  const md = renderTree({ children: nodes });
  return raw ? md : settle(md);
}

export { trimBlank };
