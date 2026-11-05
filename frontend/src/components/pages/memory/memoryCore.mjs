/**
 * Meeting memory in the page editor (MeetingMemory.tsx): the pure parts, tested in Node
 * (memoryCore.test.mjs) — which section the caret is in, what to ask the server for it, when a
 * question in Ask this page is about meetings, and when a section is worth the AI check.
 */

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
