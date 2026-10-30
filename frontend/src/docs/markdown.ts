/**
 * Pure markdown helpers (no fs, no React): headings with the ids the renderer gives them, sections
 * and their content hashes, the directive-free Markdown served to agents, and plain text for search.
 *
 * Heading ids: the renderer (render/plugins.ts) and `scanHeadings` both slug the heading's SOURCE
 * text with the same slugger, in document order, so they agree by construction.
 */
import { createSlugger, headingSourceText, inlineText } from "@/components/reading/slug";
import type { Heading, Section } from "./types";

/** Every directive name the renderer understands. `docs:check` flags anything else. */
export const CONTAINER_DIRECTIVES = ["note", "tip", "warning", "danger", "steps", "tabs", "tab", "cards", "card", "details"] as const;
export const LEAF_DIRECTIVES = ["video", "clip", "embed", "api"] as const;
export const TEXT_DIRECTIVES = ["kbd"] as const;
export const CALLOUTS: Record<string, string> = { note: "Note", tip: "Tip", warning: "Warning", danger: "Danger" };

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const QUOTE = /^\s{0,3}(?:>\s?)+/;
/*
 * `{…}` attributes: like remark-directive (micromark), a quoted value may hold `}` (`op="GET /a/{id}"`),
 * so the braces close at the first `}` outside quotes. An unclosed quote never matches, as there.
 */
export const DIRECTIVE_OPEN = /^\s*(:{3,})([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{((?:[^}"']|"[^"]*"|'[^']*')*)\})?\s*$/;
export const DIRECTIVE_CLOSE = /^\s*(:{3,})\s*$/;
export const DIRECTIVE_LEAF = /^\s*::([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{((?:[^}"']|"[^"]*"|'[^']*')*)\})?\s*$/;
const TEXT_DIRECTIVE = /(^|[^\w:\\]):([A-Za-z][\w-]*)\[([^\]]*)\](?:\{(?:[^}"']|"[^"]*"|'[^']*')*\})?/g;

/**
 * `{id="x" title='y' flag}` → {id: "x", title: "y", flag: ""}. A quoted value is taken whole, so it
 * may hold spaces, braces and `#`/`.` (`op="GET /a/{id}"`).
 */
export function parseAttrs(src: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!src) return out;
  const re = /([A-Za-z_][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?|#([\w-]+)|\.([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[5]) out.id = m[5];
    else if (m[6]) out.class = out.class ? `${out.class} ${m[6]}` : m[6];
    else if (m[1]) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/** Iterate lines with a flag for "inside a fenced code block or $$ math". */
function* walkLines(body: string): Generator<{ line: string; i: number; code: boolean }> {
  const lines = body.split(/\r?\n/);
  let fence: { ch: string; len: number } | null = null;
  let math = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(QUOTE, "");
    if (fence) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      yield { line: raw, i, code: true };
      continue;
    }
    if (math) {
      if (/^\s{0,3}\$\$\s*$/.test(line)) math = false;
      yield { line: raw, i, code: true };
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { ch: open[1][0], len: open[1].length };
      yield { line: raw, i, code: true };
      continue;
    }
    if (/^\s{0,3}\$\$(?!.*\$\$)/.test(line)) {
      math = true;
      yield { line: raw, i, code: true };
      continue;
    }
    yield { line: raw, i, code: false };
  }
}

/** ATX headings h1–h4 of a page body, with renderer-identical ids. */
export function scanHeadings(body: string): Heading[] {
  const slug = createSlugger();
  const out: Heading[] = [];
  let open = 0; // container directives we are inside (steps, tabs, callouts…)
  for (const { line, i, code } of walkLines(body)) {
    if (code) continue;
    if (DIRECTIVE_OPEN.test(line)) {
      open++;
      continue;
    }
    if (DIRECTIVE_CLOSE.test(line)) {
      open = Math.max(0, open - 1);
      continue;
    }
    const l = line.replace(QUOTE, "");
    const m = /^\s{0,3}(#{1,6})(?:\s|$)/.exec(l);
    if (!m || m[1].length > 4) continue;
    const text = headingSourceText(l);
    out.push({ id: slug(text), text, depth: m[1].length, line: i, ...(open ? { nested: true } : {}) });
  }
  return out;
}

/** FNV-1a, 32-bit, hex. Stable everywhere (build and browser), no crypto needed. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * h2 and h3 sections. A section runs from its heading to the next heading of the same or a
 * higher level, so an h2's hash also changes when one of its h3s does.
 */
export function splitSections(body: string, headings = scanHeadings(body)): Section[] {
  const lines = body.split(/\r?\n/);
  return headings
    .filter((h) => h.depth === 2 || h.depth === 3)
    .map((h) => {
      const next = headings.find((o) => o.line > h.line && o.depth <= h.depth);
      const raw = lines.slice(h.line, next ? next.line : lines.length).join("\n").trim();
      return { id: h.id, title: h.text, depth: h.depth, raw, hash: shortHash(raw.replace(/\s+/g, " ")) };
    });
}

/** The text before the first heading (the page's intro). */
export function introOf(body: string, headings = scanHeadings(body)): string {
  const first = headings[0];
  return (first ? body.split(/\r?\n/).slice(0, first.line).join("\n") : body).trim();
}

export function readingMinutes(body: string): number {
  const words = body.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

export interface PlainOptions {
  /** Absolute origin for root-relative links (`/a/b` → `${base}/a/b`). */
  base?: string;
  /** Resolves a `::video` id to its published link (and length), if any. */
  video?: (id: string) => { url: string; duration?: string } | undefined;
  /** Resolves a `::clip` src (no extension) to its file and length. */
  clip?: (src: string) => { url: string; duration?: string };
}

function absolutize(line: string, base?: string): string {
  if (!base) return line;
  return line.replace(/\]\((\/[^)\s]*)/g, (_, p: string) => `](${base}${p}`);
}

function textDirectives(line: string): string {
  return line.replace(TEXT_DIRECTIVE, (m, pre: string, name: string, label: string) =>
    (TEXT_DIRECTIVES as readonly string[]).includes(name) ? `${pre}${label}` : m,
  );
}

/** `METHOD /path` with the method upper-cased, or the trimmed text when it isn't shaped that way. */
export function normalizeApiOp(op: string): string {
  const t = op.trim().replace(/\s+/, " ");
  const m = /^([A-Za-z]+) (\S.*)$/.exec(t);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : t;
}

/** `::api[label]{op="GET /a/{id}"}` → "label: `GET /a/{id}`" (no label: just the code span). */
function apiLine(op: string, label?: string): string {
  const code = `\`${normalizeApiOp(op).replace(/`/g, "")}\``;
  return label?.trim() ? `${label.trim()}: ${code}` : code;
}

/**
 * Directive syntax → plain GitHub Markdown, for agents, llms-full.txt, clipboard and search.
 * Callouts become blockquotes with a bold label, tabs/cards/details become bold labels, steps keep
 * their headings, videos and clips become `[Video: title (0:45)](url)` lines (an unfilled video slot
 * vanishes), embeds become links, an API operation becomes `` `GET /a/{id}` `` (after its label,
 * if it has one), images keep their Markdown with absolute URLs.
 * Code is never touched. Unbalanced fences (a section cut out of a container) are tolerated.
 */
export function toPlainMarkdown(body: string, opts: PlainOptions = {}): string {
  const out: string[] = [];
  const stack: Array<{ quote: boolean }> = [];
  const prefix = () => "> ".repeat(stack.filter((f) => f.quote).length);
  const emit = (s: string) => {
    const p = prefix();
    out.push(p ? (s ? p + s : p.trimEnd()) : s);
  };
  for (const { line, code } of walkLines(body)) {
    if (code) {
      emit(line);
      continue;
    }
    const open = DIRECTIVE_OPEN.exec(line);
    if (open) {
      const [, , name, label, attrs] = open;
      const a = parseAttrs(attrs);
      if (CALLOUTS[name]) {
        emit("");
        stack.push({ quote: true });
        emit(label ? `**${CALLOUTS[name]}: ${label}**` : `**${CALLOUTS[name]}**`);
        emit("");
      } else {
        stack.push({ quote: false });
        if (name === "details" || name === "tab") {
          emit("");
          emit(`**${label || (name === "tab" ? "Option" : "Details")}**`);
          emit("");
        } else if (name === "card") {
          const href = a.href ? (a.href.startsWith("/") && opts.base ? opts.base + a.href : a.href) : "";
          emit("");
          emit(href ? `**[${label || href}](${href})**` : `**${label ?? ""}**`);
          emit("");
        }
      }
      continue;
    }
    if (DIRECTIVE_CLOSE.test(line)) {
      if (stack.length) stack.pop();
      emit("");
      continue;
    }
    const leaf = DIRECTIVE_LEAF.exec(line);
    if (leaf) {
      const [, name, label, attrs] = leaf;
      const a = parseAttrs(attrs);
      if (name === "video") {
        const v = a.id ? opts.video?.(a.id) : undefined;
        const d = a.duration || v?.duration;
        if (v) emit(`[Video: ${a.title || label || a.id}${d ? ` (${d})` : ""}](${v.url})`);
      } else if (name === "clip" && a.src) {
        const c = opts.clip?.(a.src) ?? { url: `${opts.base ?? ""}${a.src}.mp4` };
        const title = (a.alt || a.caption || label || a.src.split("/").pop() || "").replace(/[[\]]/g, "");
        emit("");
        emit(`[Video: ${title}${c.duration ? ` (${c.duration})` : ""}](${c.url})`);
        emit("");
      } else if (name === "embed" && a.src) {
        emit(`[${a.title || label || a.src}](${a.src})`);
      } else if (name === "api" && a.op?.trim()) {
        emit(apiLine(a.op, label));
      }
      continue;
    }
    emit(absolutize(textDirectives(line), opts.base));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Markdown → one line of plain text (search index, snippets, descriptions). */
export function plainText(md: string, { code = true }: { code?: boolean } = {}): string {
  const parts: string[] = [];
  for (const { line, code: isCode } of walkLines(toPlainMarkdown(md))) {
    if (isCode) {
      if (code && !/^\s{0,3}(`{3,}|~{3,}|\$\$)/.test(line)) parts.push(line.trim());
      continue;
    }
    let l = line.replace(QUOTE, "").trim();
    if (!l || /^\|?\s*:?-{3,}/.test(l)) continue;
    l = l.replace(/!\[([^\]]*)\]\([^)]*\)/g, " $1 ").replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "").replace(/\|/g, " ");
    parts.push(inlineText(l));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** First ~`n` characters of plain text, cut at a word. */
export function snippet(text: string, n = 160): string {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).replace(/[\s,.;:]+$/, "") + "…";
}

/** Root-relative paths stay in the app router; files (llms.txt, .md) and other sites load normally. */
export function isAppPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && !/\.[a-z0-9]+(?:[?#]|$)/i.test(href.split("#")[0]);
}
