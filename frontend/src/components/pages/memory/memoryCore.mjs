/**
 * Meeting memory in the page editor (MeetingMemory.tsx): the pure parts, tested in Node
 * (memoryCore.test.mjs) — which section the caret is in, what to ask the server for it, when a
 * question in Ask this page is about meetings, and when a section is worth the AI check.
 */
import { chipOf, sourcesOf } from "../../../lib/askCore.mjs";

/**
 * The section around top-level block `index`: from the nearest heading at or above it to the next
 * heading of the same or a higher level (the introduction before the first heading has no heading).
 * `blocks`: [{ level: number | null, text: string }] in page order (level: a heading's 1-6).
 */
export function sectionAround(blocks, index) {
  const list = Array.isArray(blocks) ? blocks : [];
  const at = Math.max(0, Math.min(Number(index) || 0, list.length - 1));
  let start = 0;
  let heading = null;
  let level = null;
  for (let i = at; i >= 0; i--) {
    const b = list[i];
    if (b && b.level) {
      start = i;
      heading = String(b.text ?? "").trim() || null;
      level = b.level;
      break;
    }
  }
  let end = list.length;
  for (let i = start + 1; i < list.length; i++) {
    const b = list[i];
    if (b && b.level && (level === null || b.level <= level)) {
      end = i;
      break;
    }
  }
  const text = list.slice(heading ? start + 1 : start, end).map((b) => String(b?.text ?? "")).filter((t) => t.trim()).join("\n");
  return { heading, level, start, end, text };
}

/**
 * View mode has no caret: the page's Markdown (front matter left out) as `sectionAround`'s blocks,
 * one per heading and one per paragraph or other block between them. Lines inside a fenced code
 * block are text, never headings.
 */
export function markdownBlocks(markdown) {
  const out = [];
  let para = [];
  let fence = null;
  const flush = () => {
    if (para.length) out.push({ level: null, text: para.join("\n") });
    para = [];
  };
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      para.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      flush();
      fence = f[1];
      para.push(line);
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push({ level: h[1].length, text: h[2] });
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return out;
}

const looseText = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The block index of the heading a reader has in view (its text as shown; the Markdown may carry
 * emphasis or links in it): the first heading whose words match, else 0 (the top of the page).
 */
export function headingIndex(blocks, heading) {
  const want = looseText(heading);
  if (!want || !Array.isArray(blocks)) return 0;
  const strip = (t) => looseText(String(t ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
  const at = blocks.findIndex((b) => b && b.level && strip(b.text) === want);
  return at < 0 ? 0 : at;
}

/** The words of a text that carry meaning (3+ letters, not a small word). */
export function contentWords(text) {
  const out = [];
  for (const w of String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 3 && !SMALL.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

const SMALL = new Set(("the and are for from has have her his its not our she than that their them then there these they this was were what when which who will with you your does did can could should would may might must been being also just about over how why where whose whom into").split(" "));

/** A stable key for a section's request (the panel caches its answers per key). */
export function sectionKey({ title, heading, selection, q }) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
  return [norm(title), norm(heading), norm(selection), norm(q)].join("\u0001");
}

const MEMORY_Q = /\b(when|why|who|where)\b[^?]{0,80}\b(decid\w*|agree\w*|discuss\w*|chose|chosen|choose|pick\w*|settle\w*|approv\w*|meeting|call|standup|sync)\b|\b(decision|decided|meeting|meetings|standup|sync|discussed|action items?|what (were|are) we (working|doing)|which feature|follow[- ]?ups?)\b/i;

/** Is this question about what the team decided or discussed (answered from meetings first)? */
export function isMemoryQuestion(q) {
  return MEMORY_Q.test(String(q ?? ""));
}

/**
 * Worth the AI check (Haiku, limited): the section has some text (`minWords`), a related decision,
 * and this exact text wasn't checked yet in this visit, within the visit's budget.
 */
export function shouldCheck({ words, decisions, key, checked, budget }) {
  if (!decisions || decisions < 1) return false;
  if ((words ?? 0) < 25) return false;
  if (checked && checked.has(key)) return false;
  return (budget ?? 0) > 0;
}

/** A short, stable hash for a section's text (the AI check's per-visit memory). */
export function textHash(s) {
  let h = 2166136261;
  const t = String(s ?? "");
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** A link the page can follow: same-origin URLs become paths (they open in place). */
export function localHref(url, origin) {
  const u = String(url ?? "");
  if (!u) return null;
  if (origin && (u === origin || u.startsWith(`${origin}/`))) return u.slice(origin.length) || "/";
  if (/^https?:\/\//i.test(u) || (u.startsWith("/") && !u.startsWith("//"))) return u;
  return null;
}

/**
 * An Ask-with-meetings answer (Ask Markdrop's `[n]` / `[n-sK]` citations) as Markdown whose citations
 * are links: `[n]` → `[[k]](item url)`, `[n-sK]` → `[[k·i]](the transcript moment)`, numbered in
 * first-cited order (askCore.sourcesOf). Labels the server didn't keep stay as they are. Returns
 * `{ markdown, sources }` (sources: askCore's, each with `href`).
 */
export function citedMarkdown(answer, citations, origin) {
  const text = String(answer ?? "");
  const byLabel = new Map();
  for (const c of citations || []) if (c && c.label) byLabel.set(String(c.label), c);
  const sources = sourcesOf(text, citations).map((s) => ({ ...s, href: localHref(s.url, origin) }));
  const markdown = text.replace(/\[(\d{1,2})(?:-s(\d{1,5}))?\]/g, (all) => {
    const label = all.slice(1, -1);
    const c = byLabel.get(label);
    if (!c) return all;
    const href = localHref(c.url, origin) ?? sources.find((s) => s.n === Number(label.split("-")[0]))?.href;
    const chip = chipOf(sources, label);
    return href ? `[\\[${chip}\\]](${href.replace(/[()\s]/g, encodeURIComponent)})` : `\\[${chip}\\]`;
  });
  return { markdown, sources };
}
