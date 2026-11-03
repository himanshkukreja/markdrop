/**
 * Paste: what comes in from other apps, made into the blocks the editor's schema already reads.
 *
 *   bareUrl / pasteTargets   a pasted link on its own, and what it can become (PasteMenu.tsx)
 *   normalizePastedHTML      Google Docs, Notion, GitHub, Word and web pages → the schema's DOM
 *   pasteMarkdown            Markdown from other tools (Notion's `<aside>` callouts, GitHub's
 *                            `> [!NOTE]` alerts, `<details>` toggles) → the editor's Markdown
 *   pickSource               which of the clipboard's HTML and text to read
 *
 * Everything but `normalizePastedHTML` is pure (test/paste.test.mjs). The normaliser needs a DOM
 * (DOMParser), so it's covered by the Playwright pass; it never touches the live document.
 */
import { embedSlug, webEmbedUrl, SLUG_RE } from "../../../lib/pageBlocks.mjs";

/* ── a pasted link on its own ────────────────────────────────────────────── */

const URL_RE = /^https?:\/\/[^\s<>"'`]+$/i;

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/**
 * The link when the clipboard holds one http(s) address and nothing else: its text is the address,
 * and its HTML (when there is any) is that address or one link to it. Null otherwise.
 */
export function bareUrl(text: string | null | undefined, html?: string | null): string | null {
  const t = String(text ?? "").trim();
  if (!t || t.length > 2048 || !URL_RE.test(t)) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  const h = String(html ?? "").trim();
  if (!h) return t;
  const body = h.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<(meta|style|script|title)\b[\s\S]*?(<\/\1>|>)/gi, "");
  const visible = decodeEntities(body.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  if (visible === t) return t;
  // One link to the address (a titled link copied from a browser): still the address.
  const links = [...body.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)];
  if (links.length === 1 && decodeEntities(links[0][2] ?? links[0][3] ?? "").trim() === t && !/<(img|table|ul|ol|pre|h[1-6])\b/i.test(body)) return t;
  return null;
}

/** App routes on markdrop.in (and this app's origin) that aren't items. */
const APP_ROUTES = new Set([
  "dashboard", "pages", "recent", "requests", "settings", "shared", "w", "auth", "d", "extension", "invite", "login", "oauth",
  "guides", "enterprise", "mcp", "privacy", "builder", "new", "share", "upload", "admin", "api", "docs-site", "f", "h", "fonts",
  "docs", "pricing", "about", "terms", "blog", "changelog", "signup", "logout", "p2p", "r", "v",
]);

/**
 * The slug a pasted link names when it's a Markdrop item: `https://markdrop.in/<slug>`, or this
 * app's own origin `/<slug>` (`ownHost`, e.g. a preview deployment). One path segment, not an app
 * route. Null for anything else.
 */
export function markdropSlug(url: string, ownHost?: string | null): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.host.toLowerCase();
  const markdrop = host === "markdrop.in" || host === "www.markdrop.in";
  if (!markdrop && !(ownHost && host === ownHost.toLowerCase())) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length !== 1) return null;
  const slug = embedSlug(url, ownHost ? [ownHost] : []);
  if (!slug || !SLUG_RE.test(slug) || APP_ROUTES.has(slug.toLowerCase())) return null;
  return slug;
}

export type PasteTargetId = "link" | "mention" | "bookmark" | "embed";
export interface PasteTarget {
  id: PasteTargetId;
  label: string;
  hint: string;
  icon: string;
}

const PROVIDERS: Array<[RegExp, string]> = [
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/, "YouTube video"],
  [/(^|\.)vimeo\.com$/, "Vimeo video"],
  [/(^|\.)loom\.com$/, "Loom video"],
  [/(^|\.)figma\.com$/, "Figma file"],
  [/(^|\.)google\.com$/, "map"],
  [/(^|\.)codepen\.io$/, "CodePen"],
];

function providerName(url: string): string {
  let h = "";
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {
    /* not a URL */
  }
  return PROVIDERS.find(([re]) => re.test(h))?.[1] ?? "page";
}

/**
 * What a pasted link can become, in menu order: Link (keep it; also what Esc does), then Mention
 * (Markdrop items), Bookmark (needs room for a block), Embed (allowlisted providers and Markdrop
 * items, room for a block).
 */
export function pasteTargets(url: string, { ownHost, blockOk = true }: { ownHost?: string | null; blockOk?: boolean } = {}): { slug: string | null; web: boolean; items: PasteTarget[] } {
  const slug = markdropSlug(url, ownHost);
  const web = !slug && !!webEmbedUrl(url);
  const items: PasteTarget[] = [{ id: "link", label: "Link", hint: "Keep it as it is", icon: "link" }];
  if (slug) items.push({ id: "mention", label: "Mention", hint: "A chip with the item's title", icon: "doc" });
  if (blockOk) items.push({ id: "bookmark", label: "Bookmark", hint: "A card with the link's preview", icon: "external" });
  if (blockOk && (slug || web)) items.push({ id: "embed", label: "Embed", hint: slug ? "Show the item on this page" : `Play the ${providerName(url)} here`, icon: slug ? "layers" : "globe" });
  return { slug, web, items };
}

/* ── which part of the clipboard to read ─────────────────────────────────── */

export type PasteSource = { kind: "html" } | { kind: "markdown" } | { kind: "code"; language: string | null };

const VSCODE_MARKDOWN = new Set(["markdown", "mdx", "plaintext", "text", ""]);
const VSCODE_LANG: Record<string, string> = { typescriptreact: "tsx", javascriptreact: "jsx", shellscript: "bash", "objective-c": "objc", csharp: "csharp", fsharp: "fsharp" };

/**
 * Which part of the clipboard gives the better blocks:
 *  - VS Code (and editors like it) put coloured `<span>` lines in the HTML: its text is the source,
 *    read as Markdown for Markdown files and as a code block for code.
 *  - Notion puts both: the HTML keeps toggles, callouts (icon, colour) and to-dos, which its
 *    Markdown loses or flattens, so the HTML wins; its Markdown only when the HTML lost the
 *    to-dos' checkboxes (older clipboard formats).
 *  - Everything else: the HTML when there is any (ProseMirror's default).
 */
export function pickSource({ types, html, text, vscode }: { types: readonly string[]; html: string; text: string; vscode?: string | null }): PasteSource {
  if (vscode != null || types.includes("vscode-editor-data")) {
    let mode = "";
    try {
      mode = String((JSON.parse(vscode || "{}") as { mode?: string }).mode ?? "").toLowerCase();
    } catch {
      /* not JSON */
    }
    if (VSCODE_MARKDOWN.has(mode)) return { kind: "markdown" };
    return { kind: "code", language: VSCODE_LANG[mode] ?? (/^[\w+#.-]{1,30}$/.test(mode) ? mode : null) };
  }
  const notion = types.some((t) => t.startsWith("text/_notion"));
  if (notion && text.trim()) {
    if (!html.trim()) return { kind: "markdown" };
    const mdTodos = /^\s*[-*] \[[ xX]\] /m.test(text);
    const htmlTodos = /checkbox|to-do|type="?checkbox|aria-checked|data-checked/i.test(html);
    if (mdTodos && !htmlTodos) return { kind: "markdown" };
  }
  return { kind: "html" };
}

/* ── Markdown from other tools ───────────────────────────────────────────── */

const EMOJI_HEAD = /^(\p{Extended_Pictographic}(?:️|\u200d\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*/u;
const attr = (v: string) => `"${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ")}"`;
const ALERT_KIND: Record<string, string> = { NOTE: "note", TIP: "tip", IMPORTANT: "note", WARNING: "warning", CAUTION: "danger" };

/**
 * Markdown other tools write for blocks the editor has, rewritten as the editor writes them:
 *  - Notion's callouts `<aside>💡 text</aside>` → `:::note{icon="💡"}` (pages; Guides drop the icon);
 *  - GitHub's alerts `> [!WARNING]` → `:::warning`;
 *  - `<details><summary>S</summary> … </details>` → a toggle.
 * Fenced code is left alone.
 */
export function pasteMarkdown(md: string, { page = true }: { page?: boolean } = {}): string {
  const text = md.replace(/\r\n?/g, "\n");
  if (!/<aside|<details|\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(text)) return text;
  // Split out fenced code so nothing inside it changes.
  const parts = text.split(/(^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[^\S\n]*(?=\n|(?![\s\S]))|(?![\s\S])))/m);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    if (i % 3 === 1) {
      out.push(part);
      continue;
    }
    if (i % 3 === 2) continue; // the fence capture
    out.push(rewriteBlocks(part, page));
  }
  return out.join("");
}

function rewriteBlocks(s: string, page: boolean): string {
  let t = s.replace(/^<aside>[^\S\n]*\n?([\s\S]*?)\n?[^\S\n]*<\/aside>[^\S\n]*$/gm, (_m, body: string) => {
    let b = body.trim();
    let icon = "";
    const em = EMOJI_HEAD.exec(b);
    if (em) {
      icon = em[1];
      b = b.slice(em[0].length);
    }
    const attrs = page && icon ? `{icon=${attr(icon)}}` : "";
    return `:::note${attrs}\n${b.trim() || " "}\n:::`;
  });
  t = t.replace(/^<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>[^\S\n]*$/gm, (_m, sum: string, body: string) => {
    const summary = decodeEntities(sum.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() || "Details";
    const head = page ? `:::details{summary=${attr(summary)}}` : `:::details[${summary.replace(/[[\]\\]/g, "")}]`;
    return `${head}\n${body.trim() || " "}\n:::`;
  });
  // GitHub alerts: a quote whose first line is `[!KIND]`.
  t = t.replace(/^> ?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][^\S\n]*\n((?:>[^\n]*(?:\n|$))*)/gim, (_m, kind: string, body: string) => {
    const k = kind.toUpperCase();
    const inner = body.replace(/^> ?/gm, "").replace(/\n$/, "");
    const label = k === "IMPORTANT" ? "[Important]" : "";
    return `:::${ALERT_KIND[k]}${label}\n${inner.trim() || " "}\n:::\n`;
  });
  return t;
}

/* ── inline styles → marks ───────────────────────────────────────────────── */

export interface StyleMarks {
  /** true: bold; false: explicitly not bold (font-weight: normal); undefined: not set. */
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

const MONO = /(^|[\s,'"])(courier( new)?|consolas|monaco|menlo|"?source code pro|roboto mono|sf mono|fira (code|mono)|jetbrains mono|ubuntu mono|monospace|lucida console|inconsolata)([\s,'"]|$)/i;

/** The marks a `style` attribute asks for (Google Docs and Word write formatting as styles). */
export function styleMarks(style: string | null | undefined): StyleMarks {
  const out: StyleMarks = {};
  for (const decl of String(style ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).trim().toLowerCase().replace(/\s*!important$/, "");
    if (k === "font-weight") {
      if (/^(bold|bolder)$/.test(v) || (/^\d+$/.test(v) && Number(v) >= 600)) out.bold = true;
      else if (/^(normal|lighter)$/.test(v) || (/^\d+$/.test(v) && Number(v) < 600)) out.bold = false;
    } else if (k === "font-style") {
      if (v === "italic" || v === "oblique") out.italic = true;
      else if (v === "normal") out.italic = false;
    } else if (k === "text-decoration" || k === "text-decoration-line") {
      if (v.includes("line-through")) out.strike = true;
    } else if (k === "font-family") {
      if (MONO.test(v)) out.code = true;
    }
  }
  return out;
}

/* ── code languages ──────────────────────────────────────────────────────── */

const LANG_ALIAS: Record<string, string | null> = {
  "plain text": null, plaintext: null, text: null, none: null, plain: null, txt: null, "": null,
  "c++": "cpp", "c#": "csharp", "f#": "fsharp", "objective-c": "objc", "visual basic": "vb", "vb.net": "vb", shell: "bash", sh: "bash", zsh: "bash", "shell session": "console",
  markup: "html", py: "python", docker: "dockerfile", md: "markdown",
};

/**
 * A fence language from a label ("JavaScript", "Plain Text", "c++") or, with `fromClass`, from a
 * class list ("language-js", "highlight-source-shell"; a class list without one gives null).
 */
export function codeLanguage(raw: string | null | undefined, { fromClass = false }: { fromClass?: boolean } = {}): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  const hit = s.split(/\s+/).map((c) => /^(?:language-|lang-|highlight-source-|highlight-text-)(.+)$/i.exec(c)?.[1]).find(Boolean);
  if (hit) s = hit;
  else if (fromClass) return null;
  s = s.toLowerCase().trim();
  if (s in LANG_ALIAS) return LANG_ALIAS[s];
  s = s.replace(/\s+/g, "-");
  return /^[\w+#.-]{1,30}$/.test(s) ? s : null;
}

/* ── foreign HTML → the schema's DOM (needs a DOM) ───────────────────────── */

const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CENTER", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH",
  "THEAD", "TR", "UL", "CAPTION", "COLGROUP", "HGROUP",
]);
const JUNK = "style, script, meta, link, title, noscript, template, iframe, object, embed, svg, canvas, video, audio, button, select, textarea, map, area, " +
  "clipboard-copy, .zeroclipboard-container, .js-clipboard-copy, .octicon, .anchor:empty, [hidden], [aria-hidden='true'].emoji-icon, .notion-page-mention-token-icon";
const CALLOUT_COLORS = new Set(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);
const KEEP_ATTRS = new Set(["href", "start", "data-checked", "data-docs", "data-src", "data-alt", "data-title", "data-label", "data-kind", "data-attributes", "data-value", "data-name"]);

/** The code language a pasted display equation travels in (PasteController.slice makes it a math block). */
export const MATH_LANG = "x-markdrop-math";

export interface NormalizeOptions {
  /** A page (Notion-style blocks: toggles with `summary`, callout icons and colours, H1–H3 only). */
  page?: boolean;
}

/**
 * Foreign HTML into the DOM the schema parses: `<figure data-docs="figure">` for images on their
 * own line, `<img data-docs="image">` inline, `<li data-checked>` to-dos, callout and toggle
 * containers, one-line table cells, `<pre><code class="language-…">`, and no styles, classes or
 * junk. ProseMirror HTML (`data-pm-slice`: a copy from this or another ProseMirror editor) is
 * returned as it is.
 */
export function normalizePastedHTML(html: string, opts: NormalizeOptions = {}): string {
  if (!html || /data-pm-slice/.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return html;
  const page = !!opts.page;
  const gdocs = !!body.querySelector('[id^="docs-internal-guid"]') || /docs-internal-guid/.test(html);
  const office = /urn:schemas-microsoft-com|class="?Mso|mso-/i.test(html);
  const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = body) => Array.from(root.querySelectorAll<T>(sel) as unknown as ArrayLike<T>);
  const el = (tag: string, attrs: Record<string, string> = {}) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  // 1. Junk: comments, styles and scripts, controls, hidden things, Office's namespaced tags.
  const walker = doc.createTreeWalker(body, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
  $(JUNK).forEach((e) => e.remove());
  $("input").forEach((e) => {
    if ((e.getAttribute("type") ?? "").toLowerCase() !== "checkbox") e.remove();
  });
  $("[style]").forEach((e) => {
    if (/display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all/i.test(e.getAttribute("style") ?? "")) e.remove();
  });
  for (const e of $("*")) {
    const n = e.localName;
    if (!n.includes(":")) continue;
    if (n === "o:p" || n.startsWith("v:") || n.startsWith("o:")) e.remove();
    else unwrap(e);
  }

  // 2. Google Docs' wrapper: `<b style="font-weight:normal" id="docs-internal-guid-…">`.
  $('[id^="docs-internal-guid"]').forEach((e) => unwrap(e));
  if (office) wordLists(doc, body);

  // 3. Math (KaTeX: Notion, many docs sites): the TeX source from its annotation.
  for (const k of $(".katex-display, .katex, figure.equation")) {
    if (!k.isConnected) continue;
    const tex = (k.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? "").trim();
    if (!tex) continue;
    const display = k.matches(".katex-display, figure.equation") || !!k.closest("figure.equation");
    const host = k.closest("figure.equation") ?? k;
    if (display) {
      // The schema's code block reads every <pre> first, so an equation travels as code in a
      // language of its own, which PasteController.slice makes a math block.
      const pre = el("pre", { "data-docs": "mathBlock" });
      const code = el("code", { class: `language-${MATH_LANG}` });
      code.textContent = tex;
      pre.append(code);
      host.replaceWith(pre);
    } else host.replaceWith(el("span", { "data-docs": "inlineMath", "data-value": tex }));
  }

  // 4. Code blocks: one `<pre><code class="language-…">` with the text, lines and all.
  for (const pre of $("pre")) {
    if (!pre.isConnected || pre.getAttribute("data-docs") || pre.parentElement?.closest("pre")) continue;
    const code = pre.querySelector("code");
    const wrap = pre.parentElement?.closest('[class*="highlight-"], [class*="language-"], [data-lang], [data-language]') as HTMLElement | null;
    const lang =
      codeLanguage(pre.getAttribute("lang") ?? pre.getAttribute("data-lang") ?? pre.getAttribute("data-language")) ??
      codeLanguage(code?.getAttribute("class"), { fromClass: true }) ??
      codeLanguage(code?.getAttribute("data-lang") ?? code?.getAttribute("data-language")) ??
      codeLanguage(pre.getAttribute("class"), { fromClass: true }) ??
      codeLanguage(wrap?.getAttribute("data-lang") ?? wrap?.getAttribute("data-language")) ??
      codeLanguage(wrap?.getAttribute("class"), { fromClass: true });
    const text = preText(pre).replace(/\n$/, "");
    const out = el("pre");
    const c = el("code", lang ? { class: `language-${lang}` } : {});
    c.textContent = text;
    out.append(c);
    pre.replaceWith(out);
  }
  // GitHub's file view: a table of code lines.
  for (const t of $("table")) {
    if (!t.isConnected || !t.querySelector("td.blob-code")) continue;
    const out = el("pre");
    const c = el("code");
    c.textContent = $("td.blob-code", t).map((td) => td.textContent ?? "").join("\n");
    out.append(c);
    t.replaceWith(out);
  }

  // 5. Callouts: Notion (`figure.callout`, `aside`), GitHub alerts, docs-site admonitions.
  for (const e of $("figure.callout, aside, .markdown-alert, .admonition, .theme-admonition, div[role='note']")) {
    if (!e.isConnected || e.closest("[data-docs]")) continue;
    // A page's sidebar is an `aside` too: only a short note is a callout.
    if (e.tagName === "ASIDE" && e.querySelector("nav, ul, ol, h1, h2, h3, h4, table, form")) {
      unwrap(e);
      continue;
    }
    callout(e);
  }

  // 6. Toggles: `<details><summary>` (Notion's toggles and toggle headings, GitHub's details).
  for (const d of $("details").reverse()) toggle(d);

  // 7. To-dos: a checkbox (GitHub task lists, Notion's to-do markup, Google Docs' checklists).
  for (const box of $("input[type=checkbox], input[type=CHECKBOX], .checkbox-on, .checkbox-off, [role=checkbox][aria-checked]")) {
    if (!box.isConnected) continue;
    const checked = box.matches("input") ? (box as HTMLInputElement).hasAttribute("checked") : box.matches(".checkbox-on") || box.getAttribute("aria-checked") === "true";
    let li = box.matches("li") ? box : box.closest("li");
    if (!li) {
      // A checkbox on its own line: that line becomes a one-item to-do list.
      const line = blockOf(box);
      if (line === body || !line.parentNode || /^(TD|TH|DT|DD|SUMMARY|CAPTION)$/.test(line.tagName) || line.closest("table")) {
        box.remove();
        continue;
      }
      const ul = el("ul");
      li = el("li");
      ul.append(li);
      line.replaceWith(ul);
      li.append(line);
    }
    li.setAttribute("data-checked", String(checked));
    if (!box.matches("li")) box.remove();
    else dropLeadingImages(li);
  }
  // A leading "[ ] " / "[x] " / ☐ ☑ in a list item's text.
  for (const li of $("li:not([data-checked])")) {
    const first = firstText(li);
    const m = first ? /^\s*(\[([ xX])\]|([☐☑☒✅]))\s+/.exec(first.data) : null;
    if (!first || !m || first.parentElement?.closest("li") !== li) continue;
    li.setAttribute("data-checked", String(m[2] ? m[2] !== " " : m[3] !== "☐"));
    first.data = first.data.slice(m[0].length);
  }

  // 8. Images: alone on their line → a figure; next to text (badges, icons) → inline.
  for (const img of $<HTMLImageElement>("img")) {
    if (!img.isConnected || img.getAttribute("data-docs")) continue;
    const src = imageSrc(img);
    const w = Number(img.getAttribute("width")), h = Number(img.getAttribute("height"));
    if (!src || (w > 0 && w <= 2) || (h > 0 && h <= 2)) {
      img.remove();
      continue;
    }
    const alt = (img.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
    const line = blockOf(img);
    let top: Element = img;
    while (top.parentElement && top.parentElement !== line && !BLOCK.has(top.parentElement.tagName)) top = top.parentElement;
    const inline = /^(LI|TD|TH|H[1-6]|SUMMARY|DT|DD|CAPTION)$/.test(line.tagName) || hasInlineText(top);
    if (inline) {
      img.replaceWith(el("img", { "data-docs": "image", "data-src": src, "data-alt": alt }));
      continue;
    }
    const caption = line.tagName === "FIGURE" ? (line.querySelector("figcaption")?.textContent ?? "").replace(/\s+/g, " ").trim() : "";
    const fig = el("figure", { "data-docs": "figure", "data-src": src, "data-alt": alt, ...(caption ? { "data-title": caption } : {}) });
    top.replaceWith(fig);
    if (line.tagName === "FIGURE" || line.tagName === "PICTURE") {
      line.querySelector("figcaption")?.remove();
      unwrap(line);
    }
  }
  // A paragraph left holding only figures: the figures, without it.
  for (const p of $("p, a, span, picture, center")) {
    if (!p.isConnected || !p.querySelector(":scope > figure[data-docs=figure]")) continue;
    if (hasText(p)) continue;
    p.querySelectorAll("br").forEach((b) => b.remove());
    unwrap(p);
  }

  // 9. Inline styles → marks (Google Docs and Word write bold / italic / strike as styles).
  for (const e of $("[style]")) {
    if (!e.isConnected || e.getAttribute("data-docs")) continue;
    const m = styleMarks(e.getAttribute("style"));
    e.removeAttribute("style");
    if (BLOCK.has(e.tagName) || e.tagName === "IMG") continue;
    if ((e.tagName === "B" || e.tagName === "STRONG") && m.bold === false) {
      unwrap(e);
      continue;
    }
    if ((e.tagName === "I" || e.tagName === "EM") && m.italic === false) {
      unwrap(e);
      continue;
    }
    if (!hasText(e)) continue;
    const tags: string[] = [];
    if (m.bold && !e.closest("h1,h2,h3,h4,h5,h6,b,strong,th")) tags.push("strong");
    if (m.italic && !e.closest("i,em")) tags.push("em");
    if (m.strike && !e.closest("s,del,strike") && !(gdocs && e.closest('li[data-checked="true"]'))) tags.push("s");
    if (m.code && (gdocs || office) && !e.closest("code,pre")) tags.push("code");
    if (!tags.length) continue;
    let inner: Element = e;
    for (const t of tags) {
      const w = el(t);
      while (inner.firstChild) w.append(inner.firstChild);
      inner.append(w);
      inner = w;
    }
  }
  // Google Docs ticks a checklist item by striking it through: the checkbox says so already.
  if (gdocs) $('li[data-checked="true"] s, li[data-checked="true"] del').forEach((s) => unwrap(s));

  // 10. Links: real addresses only (Google's redirect unwrapped); anchors and scripts become text.
  for (const a of $<HTMLAnchorElement>("a")) {
    let href = (a.getAttribute("href") ?? "").trim();
    const g = /^https?:\/\/(www\.)?google\.com\/url\?/.test(href) ? new URL(href).searchParams.get("q") : null;
    if (g) href = g;
    const hasContent = hasText(a) || !!a.querySelector("img, figure, [data-docs]");
    if (!hasContent) {
      a.remove();
      continue;
    }
    if (!/^(https?:|mailto:)/i.test(href)) {
      unwrap(a);
      continue;
    }
    for (const n of Array.from(a.attributes)) a.removeAttribute(n.name);
    a.setAttribute("href", href);
  }

  // 11. Tables: a header row, and one line per cell (GFM tables).
  for (const t of $<HTMLTableElement>("table").reverse()) table(t);

  // 12. Lists: a list inside a list belongs to the item before it (Google Docs writes `ul > ul`).
  for (const list of $("ul > ul, ul > ol, ol > ul, ol > ol")) {
    const prev = list.previousElementSibling;
    if (prev && prev.tagName === "LI") prev.append(list);
    else {
      const li = el("li");
      list.replaceWith(li);
      li.append(list);
    }
  }
  for (const list of $("ul, ol")) {
    for (const n of Array.from(list.childNodes)) {
      if (n.nodeType === 1 && (n as Element).tagName === "LI") continue;
      if (n.nodeType === 3 && !(n.textContent ?? "").trim()) {
        n.remove();
        continue;
      }
      const li = el("li");
      n.replaceWith(li);
      li.append(n);
    }
  }
  // Adjacent lists of one kind are one list (Markdown can't keep them apart anyway).
  for (const list of $("ul, ol")) {
    if (!list.isConnected) continue;
    let next = list.nextSibling;
    while (next && next.nodeType === 3 && !(next.textContent ?? "").trim()) next = next.nextSibling;
    if (next && next.nodeType === 1 && (next as Element).tagName === list.tagName && !(next as Element).hasAttribute("start")) {
      while (next.firstChild) list.append(next.firstChild);
      (next as Element).remove();
    }
  }

  // 13. Headings: pages have H1–H3; a heading's text isn't bold again.
  for (const hd of $("h1, h2, h3, h4, h5, h6")) {
    hd.querySelectorAll("strong, b").forEach((b) => unwrap(b));
    if (page && /^H[4-6]$/.test(hd.tagName)) {
      const h3 = el("h3");
      while (hd.firstChild) h3.append(hd.firstChild);
      hd.replaceWith(h3);
    }
  }

  // 14. Text: non-breaking spaces as spaces, zero-width characters gone (code keeps its own).
  const tw = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  while (tw.nextNode()) texts.push(tw.currentNode as Text);
  for (const t of texts) {
    if (t.parentElement?.closest("pre, code")) continue;
    const v = t.data.replace(/\u00a0/g, " ").replace(/[\u200b\u200c\u200d\ufeff]/g, (c) => (c === "\u200d" ? c : ""));
    if (v !== t.data) t.data = v;
  }

  // 15. Empty lines: paragraphs and headings with nothing in them, stray line breaks between blocks.
  for (const e of $("p, h1, h2, h3, h4, h5, h6, li:not([data-checked]), blockquote, span, font").reverse()) {
    if (!e.isConnected || e.hasAttribute("data-docs") || e.querySelector("img, figure, [data-docs], hr, input, ul, ol, pre, table")) continue;
    if (!hasText(e)) e.remove();
  }
  for (const br of $("br")) {
    const parent = br.parentElement;
    if (!parent) continue;
    const blockSibling = (n: Node | null) => !!n && n.nodeType === 1 && BLOCK.has((n as Element).tagName);
    if (parent === body || (BLOCK.has(parent.tagName) && !/^(P|LI|TD|TH|H[1-6])$/.test(parent.tagName) && (blockSibling(br.previousElementSibling) || blockSibling(br.nextElementSibling) || !br.previousSibling)))
      br.remove();
    else if (!br.nextSibling && /^(P|LI|H[1-6])$/.test(parent.tagName)) br.remove(); // a trailing break
  }

  // Lists left with no items.
  for (const list of $("ul, ol").reverse()) if (!list.querySelector(":scope > li")) list.remove();

  // 16. Attributes: only what the schema reads.
  for (const e of $("*")) {
    const docs = e.getAttribute("data-docs");
    for (const n of Array.from(e.attributes)) {
      if (KEEP_ATTRS.has(n.name)) continue;
      if (n.name === "class" && e.tagName === "CODE" && e.parentElement?.tagName === "PRE" && /^language-/.test(n.value)) continue;
      if (n.name === "src" && docs) continue;
      e.removeAttribute(n.name);
    }
  }
  return body.innerHTML;

  /* helpers (hoisted; they close over doc / body / page) */

  function unwrap(e: Element) {
    const parent = e.parentNode;
    if (!parent) return;
    while (e.firstChild) parent.insertBefore(e.firstChild, e);
    parent.removeChild(e);
  }

  function blockOf(n: Node): Element {
    let p = n.parentElement;
    while (p && p !== body && !BLOCK.has(p.tagName)) p = p.parentElement;
    return p ?? body;
  }

  function hasText(e: Element) {
    return !!(e.textContent ?? "").replace(/[\s\u00a0\u200b\ufeff]+/g, "");
  }

  /**
   * Whether `top` shares its line with text or other images (inline siblings up to the nearest
   * block or line break): a row of badges stays a row.
   */
  function hasInlineText(top: Element) {
    const look = (dir: "previousSibling" | "nextSibling") => {
      for (let n = top[dir]; n; n = n[dir]) {
        if (n.nodeType === 1 && BLOCK.has((n as Element).tagName)) return false;
        if (n.nodeType === 1 && (n as Element).tagName === "BR") return false;
        if (n.nodeType === 1 && (n as Element).matches("figure[data-docs]")) continue;
        if (n.nodeType === 1 && ((n as Element).tagName === "IMG" || (n as Element).querySelector("img"))) return true;
        if ((n.textContent ?? "").replace(/[\s\u00a0\u200b\ufeff]+/g, "")) return true;
      }
      return false;
    };
    return look("previousSibling") || look("nextSibling");
  }

  function firstText(e: Element): Text | null {
    const w = doc.createTreeWalker(e, 4);
    while (w.nextNode()) {
      const t = w.currentNode as Text;
      if (t.data.trim()) return t;
    }
    return null;
  }

  function dropLeadingImages(li: Element) {
    const w = doc.createTreeWalker(li, 1 | 4);
    const imgs: Element[] = [];
    while (w.nextNode()) {
      const n = w.currentNode;
      if (n.nodeType === 3 && (n as Text).data.trim()) break;
      if (n.nodeType === 1 && (n as Element).tagName === "IMG") imgs.push(n as Element);
      if (n.nodeType === 1 && /^(UL|OL)$/.test((n as Element).tagName)) break;
    }
    imgs.forEach((i) => i.remove());
  }

  function imageSrc(img: HTMLImageElement): string | null {
    const cands = [img.getAttribute("src"), img.getAttribute("data-src"), img.getAttribute("data-original"), (img.getAttribute("srcset") ?? "").split(",")[0]?.trim().split(/\s+/)[0]];
    for (const c of cands) {
      const s = (c ?? "").trim();
      if (/^https?:\/\//i.test(s)) return s;
      if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s) && s.length > 200) return s;
    }
    return null;
  }

  function preText(pre: Element): string {
    let out = "";
    const visit = (n: Node) => {
      if (n.nodeType === 3) {
        out += (n as Text).data;
        return;
      }
      if (n.nodeType !== 1) return;
      const e = n as Element;
      if (e.tagName === "BR") {
        out += "\n";
        return;
      }
      const block = /^(DIV|P|LI|TR)$/.test(e.tagName);
      if (block && out && !out.endsWith("\n")) out += "\n";
      e.childNodes.forEach(visit);
      if (block && !out.endsWith("\n")) out += "\n";
    };
    pre.childNodes.forEach(visit);
    return out.replace(/\u00a0/g, " ");
  }

  function callout(e: Element) {
    const cls = ` ${(e.getAttribute("class") ?? "").toLowerCase()} `;
    let kind = "note";
    let label: string | null = null;
    const attrs: Record<string, string> = {};
    if (/markdown-alert/.test(cls)) {
      const k = /markdown-alert-(note|tip|important|warning|caution)/.exec(cls)?.[1] ?? "note";
      kind = { note: "note", tip: "tip", important: "note", warning: "warning", caution: "danger" }[k] ?? "note";
      if (k === "important") label = "Important";
      e.querySelector(".markdown-alert-title")?.remove();
    } else if (/admonition|role/.test(cls) || e.getAttribute("role") === "note") {
      const k = /\b(note|info|tip|hint|success|important|warning|caution|attention|danger|error|bug|failure)\b/.exec(cls.replace(/admonition-?/g, " ").replace(/theme-/g, " "))?.[1] ?? "note";
      kind = /tip|hint|success/.test(k) ? "tip" : /warning|caution|attention/.test(k) ? "warning" : /danger|error|bug|failure/.test(k) ? "danger" : "note";
      const title = e.querySelector(".admonition-title, .admonition-heading, [class*='admonitionHeading']");
      const t = (title?.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t && t.toLowerCase() !== kind && t.toLowerCase() !== k) label = t;
      title?.remove();
    } else {
      // Notion: the icon in its own element (inside a wrapper of its own), then the text.
      const icon = e.querySelector(".icon, .notion-record-icon");
      let emoji = "";
      if (icon) {
        emoji = (icon.textContent ?? "").trim();
        let box: Element = icon;
        while (box.parentElement && box.parentElement !== e && (box.parentElement.textContent ?? "").trim() === emoji) box = box.parentElement;
        box.remove();
      } else {
        const first = e.firstElementChild;
        const t = (first?.textContent ?? "").trim();
        if (first && e.children.length > 1 && t.length <= 16 && EMOJI_HEAD.exec(t)?.[0].trim() === t) {
          emoji = t;
          first.remove();
        }
      }
      if (!emoji) {
        const t = firstText(e);
        const m = t ? EMOJI_HEAD.exec(t.data.trimStart()) : null;
        if (t && m) {
          emoji = m[1];
          t.data = t.data.trimStart().slice(m[0].length);
        }
      }
      if (page && emoji && EMOJI_HEAD.test(emoji) && emoji.length <= 16) attrs.icon = emoji;
      const color = /block-color-(\w+?)(?:_background)?\b/.exec(cls)?.[1];
      if (page && color && CALLOUT_COLORS.has(color)) attrs.color = color;
    }
    const div = el("div", { "data-docs": "callout", "data-kind": kind, "data-attributes": JSON.stringify(attrs), ...(label ? { "data-label": label } : {}) });
    while (e.firstChild) div.append(e.firstChild);
    if (!hasText(div) && !div.querySelector("img, figure")) div.append(el("p"));
    e.replaceWith(div);
  }

  function toggle(d: Element) {
    const sum = d.querySelector(":scope > summary");
    const headingEl = sum?.querySelector("h1, h2, h3, h4, h5, h6");
    const summary = (sum?.textContent ?? "").replace(/\s+/g, " ").trim();
    const fontSize = /font-size\s*:\s*([\d.]+)em/.exec(sum?.getAttribute("style") ?? "")?.[1];
    let level: number | null = headingEl ? Math.min(3, Number(headingEl.tagName[1])) : null;
    if (!level && fontSize) level = Number(fontSize) >= 1.8 ? 1 : Number(fontSize) >= 1.4 ? 2 : Number(fontSize) >= 1.2 ? 3 : null;
    sum?.remove();
    const div = page
      ? el("div", { "data-docs": "details", "data-attributes": JSON.stringify({ summary: summary || "Details", ...(level ? { heading: String(level) } : {}) }) })
      : el("div", { "data-docs": "details", "data-label": (summary || "Details").replace(/[[\]\\]/g, ""), "data-attributes": "{}" });
    while (d.firstChild) div.append(d.firstChild);
    if (!hasText(div) && !div.querySelector("img, figure, [data-docs]")) div.append(el("p"));
    d.replaceWith(div);
    // Notion: a toggle is a list of one item holding the details.
    const li = div.parentElement;
    if (li?.tagName === "LI" && li.children.length === 1 && !hasOwnText(li) && li.parentElement && /^(UL|OL)$/.test(li.parentElement.tagName) && li.parentElement.children.length === 1) {
      li.parentElement.replaceWith(div);
    }
  }

  function hasOwnText(e: Element) {
    return Array.from(e.childNodes).some((n) => n.nodeType === 3 && (n as Text).data.trim());
  }

  function table(t: HTMLTableElement) {
    if (!t.isConnected) return;
    const rows = Array.from(t.rows).filter((r) => r.closest("table") === t);
    if (!rows.length) {
      t.remove();
      return;
    }
    // The grid, with merged cells spread out (GFM has no spans).
    const grid: Array<Array<{ cell: HTMLTableCellElement | null; header: boolean }>> = [];
    rows.forEach((r, ri) => {
      grid[ri] ??= [];
      let ci = 0;
      for (const c of Array.from(r.cells)) {
        while (grid[ri][ci]) ci++;
        const cs = Math.max(1, Math.min(20, Number(c.getAttribute("colspan")) || 1));
        const rs = Math.max(1, Math.min(50, Number(c.getAttribute("rowspan")) || 1));
        for (let dr = 0; dr < rs && ri + dr < rows.length; dr++) {
          grid[ri + dr] ??= [];
          for (let dc = 0; dc < cs; dc++) grid[ri + dr][ci + dc] = { cell: dr === 0 && dc === 0 ? c : null, header: c.tagName === "TH" };
        }
        ci += cs;
      }
    });
    const width = Math.max(0, ...grid.map((r) => r.length));
    if (!width) {
      t.remove();
      return;
    }
    const out = el("table");
    const tbody = el("tbody");
    out.append(tbody);
    grid.forEach((r, ri) => {
      const tr = el("tr");
      for (let ci = 0; ci < width; ci++) {
        const cell = el(ri === 0 ? "th" : "td");
        const src = r[ci]?.cell;
        if (src) flattenInto(src, cell);
        // A header cell is bold already.
        if (ri === 0) cell.querySelectorAll("strong, b").forEach((x) => unwrap(x));
        tr.append(cell);
      }
      tbody.append(tr);
    });
    // A caption: a paragraph above.
    const cap = t.querySelector(":scope > caption");
    if (cap && hasText(cap)) {
      const p = el("p");
      p.textContent = (cap.textContent ?? "").replace(/\s+/g, " ").trim();
      t.before(p);
    }
    t.replaceWith(out);
  }

  /** A cell's content as one line: blocks joined by spaces, inline formatting kept. */
  function flattenInto(src: Element, dest: Element) {
    let sep = false;
    const add = (n: Node, into: Node) => {
      if (n.nodeType === 3) {
        const v = (n as Text).data.replace(/\s+/g, " ");
        if (!v.trim() && !into.lastChild) return;
        if (sep && v.trim()) {
          into.appendChild(doc.createTextNode(" "));
          sep = false;
        }
        into.appendChild(doc.createTextNode(v));
        return;
      }
      if (n.nodeType !== 1) return;
      const e = n as Element;
      if (e.tagName === "BR") {
        sep = true;
        return;
      }
      if (e.tagName === "IMG") {
        if (sep) into.appendChild(doc.createTextNode(" "));
        sep = false;
        into.appendChild(e.cloneNode(false));
        return;
      }
      if (e.matches("figure[data-docs=figure]")) {
        into.appendChild(el("img", { "data-docs": "image", "data-src": e.getAttribute("data-src") ?? "", "data-alt": e.getAttribute("data-alt") ?? "" }));
        return;
      }
      if (e.tagName === "PRE") {
        const c = el("code");
        c.textContent = (e.textContent ?? "").replace(/\s+/g, " ").trim();
        if (sep) into.appendChild(doc.createTextNode(" "));
        into.appendChild(c);
        sep = true;
        return;
      }
      if (e.tagName === "TABLE" || e.getAttribute("data-docs")) {
        const v = (e.textContent ?? "").replace(/\s+/g, " ").trim();
        if (v) into.appendChild(doc.createTextNode(`${sep ? " " : ""}${v}`));
        sep = true;
        return;
      }
      if (BLOCK.has(e.tagName) || e.tagName === "LI") {
        if (into.lastChild) sep = true;
        e.childNodes.forEach((k) => add(k, into));
        if (into.lastChild) sep = true;
        return;
      }
      const copy = e.cloneNode(false) as Element;
      into.appendChild(copy);
      e.childNodes.forEach((k) => add(k, copy));
    };
    src.childNodes.forEach((k) => add(k, dest));
    // Trim the ends.
    const first = dest.firstChild;
    if (first && first.nodeType === 3) (first as Text).data = (first as Text).data.replace(/^\s+/, "");
    const last = dest.lastChild;
    if (last && last.nodeType === 3) (last as Text).data = (last as Text).data.replace(/\s+$/, "");
  }
}

/**
 * Word's lists are paragraphs (`mso-list: l0 level2`) with the bullet as text in an
 * `mso-list:Ignore` span: rebuilt as nested `<ul>` / `<ol>`.
 */
function wordLists(doc: Document, body: HTMLElement) {
  const items = Array.from(body.querySelectorAll<HTMLElement>("p")).filter((p) => /mso-list\s*:\s*l\d+\s+level\d+/i.test(p.getAttribute("style") ?? ""));
  let i = 0;
  while (i < items.length) {
    // A run of list paragraphs that are siblings.
    const run = [items[i]];
    while (i + run.length < items.length && run[run.length - 1].nextElementSibling === items[i + run.length]) run.push(items[i + run.length]);
    i += run.length;
    const stack: Array<{ list: HTMLElement; level: number }> = [];
    const first = run[0];
    const anchor = doc.createElement("span");
    first.before(anchor);
    let root: HTMLElement | null = null;
    for (const p of run) {
      const level = Number(/level(\d+)/i.exec(p.getAttribute("style") ?? "")?.[1] ?? 1);
      const ignore = Array.from(p.querySelectorAll("span")).find((s) => /mso-list\s*:\s*ignore/i.test(s.getAttribute("style") ?? ""));
      const marker = (ignore?.textContent ?? "").replace(/\s+/g, "");
      ignore?.remove();
      const ordered = /^\(?[0-9a-zA-Z]{1,4}[.)]$/.test(marker) && !/^[·•o§▪-]$/.test(marker);
      while (stack.length && stack[stack.length - 1].level > level) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || top.level < level) {
        const list = doc.createElement(ordered ? "ol" : "ul");
        if (top) {
          const lastLi = top.list.lastElementChild ?? top.list.appendChild(doc.createElement("li"));
          lastLi.append(list);
        } else root = list;
        top = { list, level };
        stack.push(top);
      }
      const li = doc.createElement("li");
      while (p.firstChild) li.append(p.firstChild);
      top.list.append(li);
      p.remove();
    }
    if (root) anchor.replaceWith(root);
    else anchor.remove();
  }
}
