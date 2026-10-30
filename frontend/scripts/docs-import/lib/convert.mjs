/**
 * GitBook-flavoured Markdown → Markdrop Docs Markdown (pure: no network, no fs).
 *
 * Input is a page as GitBook serves it at `<page>.md` (or one page of llms-full.txt): a preamble
 * blockquote, `# Title`, the page description, the body, and an "Agent Instructions" footer.
 * `parseGitbookPage` splits that; `convertBody` turns the body's `{% … %}` blocks and leftover
 * HTML into the engine's directives (see frontend/src/docs/render/plugins.ts):
 *
 *   {% hint style=info|success|warning|danger %}  → :::note | :::tip | :::warning | :::danger
 *   {% tabs %} / {% tab title %}                  → ::::tabs / :::tab[title]
 *   {% stepper %} / {% step %}                    → ::::steps with a ### heading per step
 *   {% content-ref url %} (runs of them)          → ::::cards / :::card[title]{href}
 *   {% embed url %}                               → ::video (YouTube/Vimeo/Loom, first per page) or ::embed
 *   {% file src %}                                → :::card[name]{href icon="download"} (file downloaded)
 *   {% code title lineNumbers overflow %}         → fence meta title="…" (the rest dropped)
 *   {% prompt description %}                      → a soft-wrapped ```text wrap fence titled with the description
 *   {% columns %} / {% column %}                  → content kept, one column after another
 *   {% if %}                                      → content kept, condition dropped (reported)
 *   {% updates %} / {% update date %}             → a **date** line per update (reported)
 *   {% include %} {% openapi %} {% swagger %}     → a :::note pointing at the source (reported)
 *   <details><summary>                            → :::details[summary]
 *   <figure>/<img>/<picture> and ![](…)           → ![alt](local "caption") (dark <source> → .dark file)
 *   <table data-view="cards">                     → ::::cards (cover images dropped, reported)
 *   <table>                                       → GFM table
 *   inline <a> <strong> <em> <code> <kbd> <mark> <br> → Markdown; anything else → its text (reported)
 *
 * Every conversion is counted through `ctx.count(kind, how)`, and anything lossy goes through
 * `ctx.issue(kind, line, message)` with the line in the fetched .md file.
 */
import { decodeEntities, find, findTag, inlineMarkdown, parseAttrs, parseHtml, textOf } from "./html.mjs";

export const HINTS = { info: "note", success: "tip", warning: "warning", danger: "danger" };

/** Font Awesome names GitBook uses → design-system icons (src/components/ui/icons.ts). */
export const FA_ICONS = {
  bolt: "zap", "wand-sparkles": "sparkle", "wand-magic-sparkles": "sparkle", sparkles: "sparkle", sparkle: "sparkle", star: "sparkle",
  "chart-user": "chart", "chart-line": "chart", "chart-simple": "chart", "chart-bar": "chart", "chart-pie": "chart",
  "user-group": "users", users: "users", user: "user", "user-plus": "userPlus", house: "home", home: "home", gear: "settings",
  gears: "settings", sliders: "settings", book: "doc", "book-open": "doc", file: "doc", "file-lines": "lines", code: "code",
  terminal: "terminal", rocket: "zap", lock: "lock", shield: "shield", "shield-check": "shield", key: "key", globe: "globe",
  link: "link", plug: "link", "puzzle-piece": "layers", layer: "layers", "layer-group": "layers", envelope: "mail", calendar: "calendar",
  "magnifying-glass": "search", filter: "filter", list: "list", "list-check": "checkSquare", "circle-check": "checkCircle",
  "circle-info": "info", "circle-question": "info", lightbulb: "bulb", video: "film", film: "film", image: "image", table: "table",
  folder: "folder", download: "download", upload: "upload", message: "message", comments: "message", "paper-plane": "send",
  clock: "clock", "clipboard-list": "clipboard", clipboard: "clipboard", flag: "flag", server: "server", robot: "sparkle", brain: "sparkle",
  // Page icons GitBook sites use often.
  "hand-wave": "wave", desktop: "monitor", "picture-in-picture": "film", "rocketchat": "message", laptop: "laptop", mobile: "phone", "mobile-screen": "phone", tablet: "tablet", rotate: "rotate",
  recycle: "refresh", "arrows-rotate": "refresh", "arrows-spin": "refresh", play: "play", "circle-play": "play", memo: "lines", text: "lines",
  "file-image": "image", "file-chart-column": "chart", "file-magnifying-glass": "search", "file-user": "user", "filter-list": "filter",
  "envelope-open-text": "mail", "envelope-open": "mail", "comments-question": "message", "comment-sms": "message", comment: "message",
  "chart-simple-horizontal": "chart", "chart-mixed": "chart", "chart-mixed-up-circle-currency": "chart", calendars: "calendar",
  "calendar-star": "calendar", "calendar-days": "calendar", "badge-check": "checkCircle", "table-cells": "table", "table-cells-header": "table",
  "users-line": "users", "object-exclude": "layers", "sliders-simple": "settings", "gear-complex": "settings", hashtag: "hash", tag: "hash",
  "wand-magic": "sparkle", "sparkles-simple": "sparkle", "bullhorn": "send", "history": "history", "clock-rotate-left": "history",
  "shield-halved": "shield", "user-shield": "shield", "building-shield": "shield", "list-ul": "list", "list-ol": "list", "list-tree": "listTree",
  "sitemap": "listTree", "diagram-project": "listTree", "github": "github", "google": "google", "palette": "palette", "droplet": "droplet",
  "music": "music", "print": "printer", "qrcode": "qr", "inbox": "inbox", "archive": "archive", "box-archive": "archive", "bug": "bug",
  "share": "share", "share-nodes": "share", "arrow-up-right-from-square": "external", "up-right-from-square": "external",
};

/** A Font Awesome name (`bolt`, `fa-bolt`, `fa-regular fa-bolt`) → a design-system icon, or undefined. */
export function faName(name) {
  const n = String(name ?? "").toLowerCase().replace(/^fa-/, "");
  return FA_ICONS[n] ?? FA_ICONS[n.replace(/-(solid|regular|light|duotone|thin)$/, "")];
}

export function faIcon(cls) {
  for (const m of String(cls ?? "").matchAll(/\bfa-([a-z0-9-]+)/g)) {
    const icon = faName(m[1]);
    if (icon) return icon;
  }
  return undefined;
}

const norm = (s) => decodeEntities(String(s ?? "")).replace(/[\s ]+/g, " ").trim();

/* ── page envelope ───────────────────────────────────────────────────────── */

/**
 * Splits a GitBook page .md into { title, description, body, bodyLine } (bodyLine: 0-based line of
 * the body's first line in the source). `knownDescription` (from llms.txt) decides whether the
 * paragraph under the title is GitBook's page description or the start of the body.
 */
export function parseGitbookPage(src, knownDescription) {
  let text = src.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  // Footer GitBook appends for agents.
  const foot = text.search(/\n-{3,}\s*\n+# Agent Instructions\s*\n/);
  if (foot >= 0) text = text.slice(0, foot);
  const lines = text.split("\n");
  let i = 0;
  // Preamble: "> For the complete documentation index, see [llms.txt]…"
  while (i < lines.length && (/^\s*$/.test(lines[i]) || (/^>/.test(lines[i]) && /llms\.txt|documentation index|Markdown versions/i.test(lines[i])))) i++;
  let title = "";
  const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? "");
  if (h1) {
    title = norm(h1[1].replace(/\*\*/g, ""));
    i++;
  }
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  let description = "";
  if (knownDescription) {
    // The description is one paragraph right under the title.
    let j = i;
    const para = [];
    while (j < lines.length && lines[j].trim()) para.push(lines[j++]);
    if (para.length && norm(para.join(" ")) === norm(knownDescription)) {
      description = norm(para.join(" "));
      i = j;
      while (i < lines.length && /^\s*$/.test(lines[i])) i++;
    }
  }
  return { title, description, body: lines.slice(i).join("\n").replace(/\s+$/, "") + "\n", bodyLine: i };
}

/** Plain text of a Markdown paragraph (for descriptions). */
export function plainText(md) {
  return norm(
    md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1"),
  );
}

/** ≤ max chars: whole sentences when that keeps at least 60 chars, else whole words + "…". */
export function trimDescription(text, max = 160) {
  const t = norm(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence >= 60) return cut.slice(0, sentence + 1);
  if (/[.!?]$/.test(cut) && cut.length >= 60) return cut;
  const space = t.slice(0, max - 1).lastIndexOf(" ");
  return t.slice(0, space > 40 ? space : max - 1).replace(/[\s,;:—–-]+$/, "") + "…";
}

/** First prose paragraph of a converted body (skips headings, directives, images, tables, code). */
export function firstParagraph(body) {
  const lines = body.split("\n");
  let fence = false;
  let para = [];
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (!l.trim()) {
      if (para.length) break;
      continue;
    }
    if (/^\s*(#|:{2,}|!\[|\||>|<|[-*+] |\d+\. |\$\$)/.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l.trim());
  }
  return plainText(para.join(" "));
}

/* ── block tree ──────────────────────────────────────────────────────────── */

const TAG = /\{%\s*(end)?([a-zA-Z][\w-]*)\b((?:[^%]|%(?!\}))*)%\}/g;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/** Puts every `{% … %}` that shares a line with other text on its own line (outside code). */
function splitTagLines(lines) {
  const out = [];
  let fence = null;
  for (const { text, line } of lines) {
    if (fence) {
      out.push({ text, line });
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(text);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      continue;
    }
    const f = FENCE.exec(text);
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      out.push({ text, line });
      continue;
    }
    const masked = text.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    TAG.lastIndex = 0;
    const tags = [...masked.matchAll(TAG)];
    if (!tags.length || (tags.length === 1 && masked.trim() === tags[0][0].trim())) {
      out.push({ text, line });
      continue;
    }
    const indent = /^\s*/.exec(text)[0];
    let last = 0;
    for (const t of tags) {
      const before = text.slice(last, t.index);
      if (before.trim()) out.push({ text: (last === 0 ? "" : indent) + before.trimEnd(), line });
      out.push({ text: indent + t[0], line });
      last = t.index + t[0].length;
    }
    const after = text.slice(last);
    if (after.trim()) out.push({ text: indent + after.trim(), line });
  }
  return out;
}

/** Tags that may appear without an end tag. */
const MAYBE_SELF_CLOSING = new Set(["embed", "file", "include", "openapi", "swagger", "openapi-operation", "openapi-schemas", "openapi-webhook", "content-ref", "code"]);

/**
 * Lines → tree of { type: "line", text, line } and { type: "block", name, attrs, line, indent,
 * children }. Also folds <details> … </details> spans into "details" blocks.
 */
export function buildTree(body, bodyLine = 0) {
  const lines = splitTagLines(body.split("\n").map((text, i) => ({ text, line: bodyLine + i })));
  // Which opening tags have a matching end tag (by nesting count of the same name)?
  const closes = new Map();
  {
    const open = new Map();
    let fence = null;
    lines.forEach(({ text }, idx) => {
      if (fence) {
        const c = /^\s*(`{3,}|~{3,})\s*$/.exec(text);
        if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
        return;
      }
      const f = FENCE.exec(text);
      if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
        fence = f[1];
        return;
      }
      const t = /^\s*\{%\s*(end)?([a-zA-Z][\w-]*)\b.*%\}\s*$/.exec(text);
      if (!t) return;
      const name = t[2].toLowerCase();
      if (!open.has(name)) open.set(name, []);
      if (t[1]) {
        const at = open.get(name).pop();
        if (at !== undefined) closes.set(at, idx);
      } else open.get(name).push(idx);
    });
  }

  const root = { type: "block", name: "#root", attrs: {}, children: [], line: bodyLine };
  const stack = [root];
  let fence = null;
  const top = () => stack[stack.length - 1];
  lines.forEach(({ text, line }, idx) => {
    if (fence) {
      top().children.push({ type: "line", text, line });
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(text);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      return;
    }
    const f = FENCE.exec(text);
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      top().children.push({ type: "line", text, line });
      return;
    }
    const t = /^(\s*)\{%\s*(end)?([a-zA-Z][\w-]*)\b((?:[^%]|%(?!\}))*)%\}\s*$/.exec(text);
    if (t) {
      const [, indent, end, rawName, rest] = t;
      const name = rawName.toLowerCase();
      if (end) {
        const at = stack.map((n) => n.name).lastIndexOf(name);
        if (at > 0) stack.length = at;
        else top().children.push({ type: "stray", text, line, name });
        return;
      }
      const node = { type: "block", name, attrs: tagAttrs(rest), arg: rest.trim(), line, indent, children: [] };
      top().children.push(node);
      if (closes.has(idx) || !MAYBE_SELF_CLOSING.has(name)) {
        if (closes.has(idx)) stack.push(node);
        else node.unclosed = true; // a container with no end tag: treat its tag as a marker
      }
      return;
    }
    // <details> … </details> (GitBook expandable)
    const d = /^(\s*)<details(\s[^>]*)?>\s*(.*)$/i.exec(text);
    if (d) {
      const node = { type: "block", name: "details", attrs: { open: /\bopen\b/.test(d[2] ?? "") ? "true" : "" }, line, indent: d[1], children: [] };
      top().children.push(node);
      stack.push(node);
      if (d[3].trim()) top().children.push({ type: "line", text: d[1] + d[3], line });
      return;
    }
    if (/^\s*<\/details>\s*$/i.test(text) && top().name === "details") {
      stack.pop();
      return;
    }
    top().children.push({ type: "line", text, line });
  });
  return root;
}

/** `style="info" title='x' lineNumbers=true fullWidth` → attrs; a bare quoted value → {_: value}. */
export function tagAttrs(src) {
  const out = {};
  const s = String(src ?? "").trim();
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|'([^']*)'|([A-Za-z_][\w-]*)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    else if (m[5] !== undefined || m[6] !== undefined) out._ ??= decodeEntities(m[5] ?? m[6]);
    else if (m[7]) out[m[7]] = "true";
  }
  return out;
}

/* ── rendering ───────────────────────────────────────────────────────────── */

/** Blocks that become one directive level; others are transparent. */
const DIRECTIVE_LEVELS = { hint: 1, tabs: 2, stepper: 1, details: 1, "content-ref": 2, file: 2 };

function height(node) {
  if (node.type === "line") return /data-view=["']?cards/.test(node.text) ? 2 : 0;
  if (node.type !== "block") return 0;
  const inner = Math.max(0, ...node.children.map(height));
  if (node.name === "tabs") return Math.max(2, inner + 1);
  if (node.name === "tab") return inner + 1;
  const own = DIRECTIVE_LEVELS[node.name] ?? 0;
  return own ? inner + own : inner;
}

const colons = (h) => ":".repeat(2 + Math.max(1, h));
const blank = (n) => n.type === "line" && !n.text.trim();
const label = (s) => norm(s).replace(/[[\]]/g, (c) => (c === "[" ? "(" : ")"));
const attrVal = (s) => String(s ?? "").replace(/"/g, "'");

/**
 * Converts a GitBook body. ctx:
 *   link(href, {line}) → new href | null      image(src, {alt, caption, darkSrc, line}) → Markdown path
 *   file(index, src, {line}) → {href, name, size?} | null   video(url, title) → id | null
 *   pageInfo(href) → {title, description} | null             count(kind, how)   issue(kind, line, msg)
 */
export function convertBody(body, bodyLine, ctx) {
  const tree = buildTree(body, bodyLine);
  const state = { files: 0, videos: 0 };
  const out = renderChildren(tree.children, ctx, state);
  return finishBody(out.join("\n"), ctx, bodyLine);
}

function renderChildren(children, ctx, state) {
  const out = [];
  let i = 0;
  let text = [];
  const flush = () => {
    if (text.length) out.push(...convertText(text, ctx));
    text = [];
  };
  while (i < children.length) {
    const n = children[i];
    if (n.type === "line") {
      text.push(n);
      i++;
      continue;
    }
    flush();
    if (n.type === "stray") {
      ctx.issue("stray tag", n.line, `{% end${n.name} %} without an opening tag: dropped`);
      i++;
      continue;
    }
    if (n.name === "content-ref") {
      // A run of content-refs (blank lines between) becomes one card grid.
      const run = [n];
      let j = i + 1;
      while (j < children.length && (blank(children[j]) || (children[j].type === "block" && children[j].name === "content-ref"))) {
        if (children[j].type === "block") run.push(children[j]);
        j++;
      }
      out.push(...renderContentRefs(run, ctx));
      i = j;
      continue;
    }
    out.push(...renderBlock(n, ctx, state));
    i++;
  }
  flush();
  return out;
}

function renderBlock(n, ctx, state) {
  const ind = n.indent ?? "";
  const h = height(n);
  // Blank lines around: a flattened block (columns, if…) must not merge with its neighbours.
  const inner = () => ["", ...renderChildren(n.children, ctx, state), ""];
  const wrap = (open, lines) => ["", ind + open, ...trimBlank(lines), ind + colons(h), ""];
  switch (n.name) {
    case "hint": {
      const style = (n.attrs.style ?? "info").toLowerCase();
      const kind = HINTS[style] ?? "note";
      ctx.count("hint", `:::${kind}`);
      if (!HINTS[style]) ctx.issue("hint", n.line, `hint style "${style}" has no match: used :::note`);
      return wrap(`${colons(h)}${kind}`, inner());
    }
    case "tabs": {
      ctx.count("tabs", "::::tabs + :::tab[title]");
      const lines = [];
      let k = 0;
      for (const c of n.children) {
        if (c.type === "block" && c.name === "tab") {
          const th = h - 1; // every tab one level under its tabs
          lines.push("", `${ind}${colons(th)}tab[${label(c.attrs.title ?? `Tab ${k + 1}`)}]`, ...trimBlank(renderChildren(c.children, ctx, state)), `${ind}${colons(th)}`);
          k++;
        } else if (!blank(c)) {
          ctx.issue("tabs", c.line, "content between tabs (outside any {% tab %}) was moved after the tabs");
          lines.push(...renderChildren([c], ctx, state));
        }
      }
      if (!k) {
        ctx.issue("tabs", n.line, "{% tabs %} without any {% tab %}: content kept without tabs");
        return renderChildren(n.children, ctx, state);
      }
      return wrap(`${colons(h)}tabs`, lines);
    }
    case "tab":
      ctx.issue("tabs", n.line, "{% tab %} outside {% tabs %}: content kept without the tab");
      return inner();
    case "stepper": {
      ctx.count("stepper", "::::steps with ### step headings");
      const lines = [];
      let k = 0;
      for (const c of n.children) {
        if (c.type === "block" && c.name === "step") lines.push("", ...renderStep(c, ++k, ctx, state));
        else if (!blank(c)) lines.push(...renderChildren([c], ctx, state));
      }
      if (!k) return inner();
      return wrap(`${colons(h)}steps`, lines);
    }
    case "step":
      ctx.issue("stepper", n.line, "{% step %} outside {% stepper %}: content kept");
      return inner();
    case "details": {
      ctx.count("<details>", ":::details[summary]");
      // The summary is the first <summary> line.
      let summary = "";
      const rest = [];
      for (const c of n.children) {
        if (!summary && c.type === "line" && /<summary\b/i.test(c.text)) {
          summary = inlineMarkdown(parseHtml(c.text.replace(/^.*?<summary[^>]*>|<\/summary>.*$/gi, "")), {});
          const after = c.text.replace(/^.*<\/summary>/i, "");
          if (after.trim() && after !== c.text) rest.push({ ...c, text: after });
          continue;
        }
        rest.push(c);
      }
      if (!summary) {
        summary = "Details";
        ctx.issue("<details>", n.line, "<details> without <summary>: labelled “Details”");
      }
      return wrap(`${colons(h)}details[${label(summary.replace(/\*\*/g, ""))}]`, renderChildren(rest, ctx, state));
    }
    case "columns":
      ctx.count("columns", "flattened: columns one after another");
      return inner();
    case "column":
      return inner();
    case "if":
      ctx.count("if", "content kept, condition dropped");
      ctx.issue("if", n.line, `adaptive content condition dropped (content always shown): ${n.arg}`);
      return inner();
    case "code": {
      const lines = inner();
      const at = lines.findIndex((l) => FENCE.test(l));
      const parts = [];
      if (at >= 0) {
        const m = FENCE.exec(lines[at]);
        const title = n.attrs.title;
        if (title) {
          lines[at] = `${lines[at].slice(0, lines[at].indexOf(m[1]))}${m[1]}${(m[2].trim().split(/\s+/)[0] || "text")} title="${attrVal(title)}"`;
          parts.push("title");
        }
      }
      const dropped = Object.keys(n.attrs).filter((k) => k !== "title" && k !== "_");
      ctx.count("code", parts.length ? "fence title=\"…\"" : "fence kept");
      if (dropped.length) ctx.count("code options", `dropped: ${dropped.join(", ")}`);
      return lines;
    }
    case "prompt": {
      // A prompt is prose to copy: soft-wrapped (`wrap`), never a sideways scroll.
      ctx.count("prompt", "```text wrap fence titled with the description (copy button)");
      const lines = trimBlank(inner());
      const title = n.attrs.description || n.attrs.title || "Prompt";
      const at = lines.findIndex((l) => FENCE.test(l));
      if (at >= 0) {
        const m = FENCE.exec(lines[at]);
        lines[at] = `${lines[at].slice(0, lines[at].indexOf(m[1]))}${m[1]}text wrap title="${attrVal(title)}"`;
        return ["", ...lines, ""];
      }
      return ["", `${ind}\`\`\`text wrap title="${attrVal(title)}"`, ...lines.map((l) => l.replace(ind, "")), `${ind}\`\`\``, ""];
    }
    case "embed": {
      const url = n.attrs.url ?? n.attrs._ ?? "";
      const caption = norm(n.children.filter((c) => c.type === "line").map((c) => c.text).join(" "));
      if (!/^https?:\/\//.test(url)) {
        ctx.issue("embed", n.line, `embed without an https url: ${url || "(none)"}`);
        return [];
      }
      const vid = videoProvider(url) && state.videos === 0 ? ctx.video(url, caption || "Video") : null;
      if (vid) {
        state.videos++;
        ctx.count("embed", "::video (videos.json url)");
        return ["", `${ind}::video{id="${vid}" title="${attrVal(caption || "Video")}"}`, ""];
      }
      ctx.count("embed", "::embed{src title}");
      return ["", `${ind}::embed{src="${attrVal(url.replace(/^http:/, "https:"))}" title="${attrVal(caption || hostOf(url))}"}`, ""];
    }
    case "file": {
      const src = n.attrs.src ?? n.attrs._ ?? "";
      const caption = norm(n.children.filter((c) => c.type === "line").map((c) => c.text).join(" "));
      const f = ctx.file(state.files++, src, { line: n.line });
      if (!f) {
        ctx.issue("file", n.line, `file ${src} could not be resolved: left as a note`);
        return ["", `${ind}:::note`, `${ind}A downloadable file (${src}) was here in the original docs and could not be imported.`, `${ind}:::`, ""];
      }
      ctx.count("file", ":::card[name]{href icon=download} (file downloaded)");
      const c3 = colons(1);
      return ["", `${ind}::::cards`, `${ind}${c3}card[${label(f.name)}]{href="${f.href}" icon="download"}`, `${ind}${caption || [f.ext?.toUpperCase(), f.size].filter(Boolean).join(" file, ") || "Download"}`, `${ind}${c3}`, `${ind}::::`, ""];
    }
    case "updates": {
      ctx.count("updates", "flattened into dated sections");
      ctx.issue("updates", n.line, "{% updates %} flattened into dated sections (consider changelog.json)");
      return inner();
    }
    case "update": {
      const date = n.attrs.date ?? "";
      return ["", `${ind}**${date}**`, "", ...inner()];
    }
    case "include":
    case "openapi":
    case "openapi-operation":
    case "openapi-schemas":
    case "openapi-webhook":
    case "swagger": {
      const src = n.attrs.src ?? n.attrs.url ?? n.attrs._ ?? "";
      ctx.count(n.name, "placeholder :::note (not imported)");
      ctx.issue(n.name, n.line, `{% ${n.name} ${n.arg} %} is not imported: replaced with a note`);
      const what = n.name === "include" ? "Reused content" : "An API reference block";
      const link = /^https?:\/\//.test(src) ? ` ([source](${src}))` : "";
      return ["", `${ind}:::note`, `${ind}${what} from the original docs goes here${link}.`, `${ind}:::`, ""];
    }
    default:
      ctx.count(n.name, "unknown block: content kept, tags dropped");
      ctx.issue(n.name, n.line, `unknown block {% ${n.name} %}: tags dropped, content kept`);
      return inner();
  }
}

function renderStep(step, k, ctx, state) {
  const lines = trimBlank(renderChildren(step.children, ctx, state));
  // The step title: its first heading (any depth), or a bold first line, or "Step N".
  let title = null;
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0) {
    const hm = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[first]);
    const bm = /^\s*\*\*([^*]+)\*\*\s*$/.exec(lines[first]);
    if (hm || bm) {
      title = (hm ?? bm)[1];
      lines.splice(first, 1);
    }
  }
  if (!title) {
    title = `Step ${k}`;
    ctx.issue("stepper", step.line, `step ${k} has no heading: titled “Step ${k}”`);
  }
  // Other headings inside the step sit below the step heading.
  const body = lines.map((l) => l.replace(/^(\s*)(#{1,3})(\s)/, (_, s, _h, sp) => `${s}####${sp}`));
  return [`${step.indent ?? ""}### ${title}`, ...body];
}

function renderContentRefs(run, ctx) {
  const ind = run[0].indent ?? "";
  const cards = [];
  for (const n of run) {
    const url = n.attrs.url ?? n.attrs._ ?? "";
    const linkLine = n.children.map((c) => c.text ?? "").join(" ");
    const lm = /\[([^\]]*)\]\(([^)\s]+)/.exec(linkLine);
    const href = ctx.link(url || lm?.[2] || "", { line: n.line });
    const info = ctx.pageInfo(url || lm?.[2] || "");
    const title = norm(lm?.[1] || info?.title || url);
    ctx.count("content-ref", "::::cards / :::card[title]{href}");
    cards.push(
      `${ind}:::card[${label(title)}]${href ? `{href="${href}"}` : ""}`,
      ...(info?.description ? [`${ind}${info.description}`] : []),
      `${ind}:::`,
    );
  }
  return ["", `${ind}::::cards`, ...cards, `${ind}::::`, ""];
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

export function videoProvider(url) {
  if (/(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/.test(url)) return "youtube";
  if (/vimeo\.com/.test(url)) return "vimeo";
  if (/loom\.com\/share\//.test(url)) return "loom";
  return null;
}

/** A frameable player URL for a video page link. */
export function videoEmbedUrl(url) {
  let m = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed|shorts)\/)([\w-]{6,})/.exec(url);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  m = /vimeo\.com\/(?:video\/)?(\d+)/.exec(url);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  m = /loom\.com\/share\/([\w-]+)/.exec(url);
  if (m) return `https://www.loom.com/embed/${m[1]}`;
  return url;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Embedded page";
  }
}

/* ── text: HTML, images, links ───────────────────────────────────────────── */

/** HTML elements that GitBook writes as blocks (possibly over several lines). */
const BLOCK_HTML = /^\s*<(figure|table|picture|img|div|p|blockquote|ul|ol|h[1-6]|iframe|video|center)\b/i;

function convertText(nodes, ctx) {
  // Merge multi-line HTML blocks into one line first.
  const lines = [];
  let fence = null;
  for (let i = 0; i < nodes.length; i++) {
    const { text, line } = nodes[i];
    if (fence) {
      lines.push({ text, line, code: true });
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(text);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      continue;
    }
    const f = FENCE.exec(text);
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      lines.push({ text, line, code: true });
      continue;
    }
    const b = BLOCK_HTML.exec(text);
    if (b && !/^img$/i.test(b[1])) {
      const tag = b[1].toLowerCase();
      const close = new RegExp(`</${tag}\\s*>`, "i");
      let joined = text;
      let j = i;
      while (!close.test(joined) && j + 1 < nodes.length && j - i < 400) joined += "\n" + nodes[++j].text;
      lines.push({ text: joined, line, html: tag });
      i = j;
      continue;
    }
    lines.push({ text, line });
  }

  const out = [];
  for (const l of lines) {
    if (l.code) {
      out.push(l.text);
      continue;
    }
    if (l.html) {
      out.push(...convertHtmlBlock(l.text, l.html, l.line, ctx));
      continue;
    }
    out.push(convertLine(l.text, l.line, ctx));
  }
  return out;
}

function convertHtmlBlock(html, tag, line, ctx) {
  const ind = /^\s*/.exec(html)[0];
  const tree = parseHtml(html.trim());
  const hooks = inlineHooks(line, ctx);
  if (tag === "figure" || tag === "picture") return ["", ...figureMarkdown(tree, line, ctx).map((l) => ind + l), ""];
  if (tag === "table") {
    const table = findTag(tree, "table")[0];
    if (!table) return [html];
    const view = table.attrs["data-view"];
    if (view === "cards") return ["", ...cardsTable(table, line, ctx).map((l) => ind + l), ""];
    ctx.count("<table>", "GFM table");
    return ["", ...gfmTable(table, hooks).map((l) => ind + l), ""];
  }
  if (/^h[1-6]$/.test(tag)) {
    ctx.count("<h>", "Markdown heading");
    return [`${ind}${"#".repeat(+tag[1])} ${inlineMarkdown(tree, hooks)}`];
  }
  if (tag === "iframe") {
    const src = findTag(tree, "iframe")[0]?.attrs.src ?? "";
    ctx.count("<iframe>", "::embed");
    return /^https:\/\//.test(src) ? ["", `${ind}::embed{src="${attrVal(src)}" title="${attrVal(hostOf(src))}"}`, ""] : [];
  }
  if (tag === "ul" || tag === "ol") {
    ctx.count(`<${tag}>`, "Markdown list");
    const items = findTag(tree, "li");
    return ["", ...items.map((li, k) => `${ind}${tag === "ol" ? `${k + 1}.` : "-"} ${inlineMarkdown(li, hooks)}`), ""];
  }
  // div / p / blockquote / center / video: keep the text and any images.
  ctx.count(`<${tag}>`, "text kept");
  const imgs = findTag(tree, "img");
  const text = inlineMarkdown({ ...tree, children: tree.children }, { ...hooks, image: () => "" });
  if (tag === "video") ctx.issue("<video>", line, "an inline <video> was not imported");
  return ["", ...(text ? [ind + (tag === "blockquote" ? "> " : "") + text] : []), ...imgs.flatMap((im) => ["", ind + imageMarkdown(im.attrs.src, im.attrs.alt, "", null, line, ctx)]), ""];
}

function inlineHooks(line, ctx) {
  return {
    link: (href) => ctx.link(href, { line }),
    image: (src, alt) => imageMarkdown(src, alt, "", null, line, ctx),
    note: (k) => {
      if (k === "icon") ctx.count("icon", "dropped (no inline icons)");
      else if (k === "mark") ctx.count("<mark>", "text kept, colour dropped");
      else if (k === "button") ctx.count("button", "bold link");
      else if (k.startsWith("<")) {
        ctx.count(k, "text kept");
        ctx.issue("html", line, `${k} was reduced to its text`);
      }
    },
  };
}

function figureMarkdown(tree, line, ctx) {
  const img = findTag(tree, "img")[0];
  const caption = norm(textOf(findTag(tree, "figcaption")[0] ?? { children: [] }));
  const dark = find(tree, (n) => n.tag === "source" && /dark/.test(n.attrs.media ?? ""))[0]?.attrs.srcset?.split(/\s+/)[0];
  if (!img) {
    const v = findTag(tree, "video")[0];
    ctx.issue("<figure>", line, v ? "a <figure> with a video was not imported" : "a <figure> without an image was dropped");
    return caption ? [caption] : [];
  }
  ctx.count("<figure>", dark ? "![alt](src \"caption\") + .dark variant" : "![alt](src \"caption\")");
  return [imageMarkdown(img.attrs.src, img.attrs.alt, caption, dark, line, ctx)];
}

export function imageMarkdown(src, alt, caption, darkSrc, line, ctx) {
  const a = norm(alt);
  const c = norm(caption);
  const path = ctx.image(decodeEntities(src ?? ""), { alt: a, caption: c, darkSrc: darkSrc ? decodeEntities(darkSrc) : null, line });
  if (!path) return c ? `*${c}*` : "";
  const altText = label(path.alt ?? (a || c));
  return `![${altText}](${path.src}${c ? ` "${c.replace(/"/g, "'")}"` : ""})`;
}

function cardsTable(table, line, ctx) {
  const heads = findTag(findTag(table, "thead")[0] ?? { children: [] }, "th");
  const rows = findTag(findTag(table, "tbody")[0] ?? table, "tr");
  const hooks = inlineHooks(line, ctx);
  const cards = [];
  let covers = 0;
  for (const tr of rows) {
    const cells = tr.children.filter((c) => c.tag === "td");
    let title = "";
    let href = "";
    let icon;
    const body = [];
    cells.forEach((td, k) => {
      const th = heads[k]?.attrs ?? {};
      if ("data-card-target" in th) {
        const a = findTag(td, "a")[0];
        if (a?.attrs.href) href = ctx.link(a.attrs.href, { line }) ?? "";
        return;
      }
      if ("data-card-cover" in th || "data-card-cover-dark" in th) {
        if (textOf(td).trim()) covers++;
        return;
      }
      if ("data-hidden" in th) return;
      const i = findTag(td, "i")[0];
      if (i && !icon) icon = faIcon(i.attrs.class);
      const strongLink = find(td, (n) => n.tag === "a" && findTag(n, "strong").length > 0)[0];
      const txt = inlineMarkdown(td, { ...hooks, image: () => "" });
      if (!txt) return;
      if (!title) {
        title = plainText(txt); // icons (<i class="fa-…">:bolt:</i>) already dropped
        if (strongLink?.attrs.href && !href) href = ctx.link(strongLink.attrs.href, { line }) ?? "";
        else {
          const a = findTag(td, "a")[0];
          if (a?.attrs.href && !href) href = ctx.link(a.attrs.href, { line }) ?? "";
        }
      } else body.push(txt.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    });
    if (!title) continue;
    cards.push(`:::card[${label(title)}]${href || icon ? `{${[href && `href="${href}"`, icon && `icon="${icon}"`].filter(Boolean).join(" ")}}` : ""}`, ...body, ":::");
  }
  ctx.count("cards table", "::::cards / :::card[title]{href icon}");
  if (covers) {
    ctx.count("card cover image", "dropped (cards have no cover images)");
    ctx.issue("cards", line, `${covers} card cover image(s) dropped: the engine's cards have no cover`);
  }
  if (!cards.length) return [];
  return ["::::cards", ...cards, "::::"];
}

function gfmTable(table, hooks) {
  const headRow = findTag(findTag(table, "thead")[0] ?? { children: [] }, "tr")[0];
  const bodyRows = findTag(findTag(table, "tbody")[0] ?? table, "tr").filter((r) => r !== headRow);
  const cell = (n) => inlineMarkdown(n, hooks).replace(/\|/g, "\\|").replace(/\n/g, " ") || " ";
  const visible = (headRow ? headRow.children.filter((c) => c.tag === "th" || c.tag === "td") : []).map((th) => !("data-hidden" in th.attrs));
  const pick = (cells) => cells.filter((_, k) => visible[k] !== false);
  let head = headRow ? pick(headRow.children.filter((c) => c.tag === "th" || c.tag === "td")).map(cell) : null;
  const rows = bodyRows.map((r) => pick(r.children.filter((c) => c.tag === "td" || c.tag === "th")).map(cell));
  const width = Math.max(head?.length ?? 0, ...rows.map((r) => r.length));
  if (!head || head.every((h) => !h.trim())) head = Array.from({ length: width }, () => " ");
  const pad = (r) => [...r, ...Array.from({ length: width - r.length }, () => " ")];
  return [`| ${pad(head).join(" | ")} |`, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.map((r) => `| ${pad(r).join(" | ")} |`)];
}

/** One Markdown line: images, links, inline HTML (outside code spans). */
function convertLine(text, line, ctx) {
  if (/^\s*<br\s*\/?>\s*$/i.test(text)) {
    ctx.count("<br>", "dropped (spacer line)");
    return "";
  }
  const hooks = inlineHooks(line, ctx);
  return mapOutsideCode(text, (seg) => {
    let s = seg;
    // Markdown images ![alt](src "title")
    s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, alt, src, title) => {
      ctx.count("markdown image", "![alt](local)");
      return imageMarkdown(unescapeMd(src), alt, title ?? "", null, line, ctx);
    });
    // Markdown links [text](href "title") — not images (already local).
    s = s.replace(/(^|[^!\\])\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, pre, t, href) => {
      if (href.startsWith("/docs-assets/") || href.startsWith("@@")) return m;
      const h = ctx.link(unescapeMd(href), { line });
      return h ? `${pre}[${t}](${h})` : `${pre}${t}`;
    });
    // Inline HTML (not autolinks like <https://…> or <a@b.c>).
    if (/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/i.test(s.replace(/<(?:https?:|mailto:)[^>]*>|<[^\s<>@]+@[^\s<>]+>/gi, ""))) {
      s = s.replace(/<(a|strong|b|em|i|code|kbd|mark|span|sup|sub|u|s|del|br|img)\b[^>]*\/?>(?:[\s\S]*?<\/\1>)?|<\/?(?:p|div|span|font|u|small|center)\b[^>]*>/gi, (m) => {
        const md = inlineMarkdown(parseHtml(m), hooks);
        return /^<br/i.test(m) ? " " : md;
      });
      const rest = s.replace(/<(?:https?:|mailto:)[^>]*>|<[^\s<>@]+@[^\s<>]+>/gi, "");
      const left = /<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?>/i.exec(rest);
      if (left && /^(?:[a-z]+)$/i.test(left[1]) && isHtmlTag(left[1])) {
        ctx.count(`<${left[1].toLowerCase()}>`, "tag removed, text kept");
        ctx.issue("html", line, `<${left[1].toLowerCase()}> removed (raw HTML isn't rendered)`);
        s = s.replace(/<\/?([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi, (m, t) => (isHtmlTag(t) ? "" : m));
      }
    }
    return s;
  });
}

const HTML_TAGS = new Set("a abbr b bdi bdo big blockquote br button caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i iframe img ins kbd label li main mark nav ol p picture pre q s samp section small source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var video wbr".split(" "));
const isHtmlTag = (t) => HTML_TAGS.has(t.toLowerCase());

/** Markdown backslash escapes in a URL (`?alt=media\&token=…`) → the plain URL. */
export const unescapeMd = (s) => String(s ?? "").replace(/\\([!-/:-@[-`{-~])/g, "$1");

/** Applies fn to the parts of a line outside `inline code`. */
export function mapOutsideCode(line, fn) {
  const parts = line.split(/(`+[^`]*?`+)/);
  return parts.map((p, i) => (i % 2 ? p : fn(p))).join("");
}

/* ── final pass ──────────────────────────────────────────────────────────── */

/**
 * Headings: drops empty ones, unwraps **bold** headings, and shifts every heading down a level when
 * the body uses H1 (the page title is the only H1). Collapses runs of blank lines.
 */
function finishBody(md, ctx, bodyLine) {
  const lines = md.split("\n");
  let fence = null;
  let hasH1 = false;
  const isFence = (l) => {
    const f = FENCE.exec(l);
    return f && !(f[1][0] === "`" && f[2].includes("`")) ? f[1] : null;
  };
  for (const l of lines) {
    if (fence) {
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      continue;
    }
    const f = isFence(l);
    if (f) {
      fence = f;
      continue;
    }
    if (/^\s{0,3}#\s/.test(l)) hasH1 = true;
  }
  if (hasH1) ctx.count("H1 in body", "all headings shifted down one level");
  const out = [];
  fence = null;
  for (let l of lines) {
    if (fence) {
      out.push(l);
      const c = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) fence = null;
      continue;
    }
    const f = isFence(l);
    if (f) {
      fence = f;
      out.push(l);
      continue;
    }
    const h = /^(\s{0,3})(#{1,6})\s*(.*?)\s*#*\s*$/.exec(l);
    if (h && /^\s{0,3}#{1,6}(\s|$)/.test(l)) {
      let text = h[3].replace(/​/g, "").trim();
      const bold = /^\*\*(.+?)\*\*$/.exec(text);
      if (bold && !bold[1].includes("**")) text = bold[1].trim();
      if (!text || /^<br\s*\/?>$/i.test(text) || !text.replace(/[*_\s\\]/g, "")) {
        ctx.count("empty heading", "dropped");
        continue;
      }
      const depth = Math.min(6, h[2].length + (hasH1 ? 1 : 0));
      l = `${h[1]}${"#".repeat(depth)} ${text}`;
    }
    out.push(l.replace(/[ \t]+$/, ""));
  }
  void bodyLine;
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s*$/, "\n");
}
