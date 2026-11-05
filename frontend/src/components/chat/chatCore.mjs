/**
 * The shared chat's pure helpers (components/chat; tested in chatCore.test.mjs).
 *
 * An answer cites sources with tokens in square brackets ("[s12]", "[M2-s14]", "[3]"); which shapes count
 * is the caller's `pattern` (a global RegExp whose group 1 is the token). Citations are numbered in the
 * order the answer first cites them, so the reader sees [1] [2] [3] whatever the model wrote.
 */

/** Ask Markdrop's and the meetings' tokens: 3, 3-s12, s12, n4, M2, M2-s14. */
export const DEFAULT_CITE = /\[((?:M?\d{1,3}(?:-[sn]\d{1,5})?)|(?:[sn]\d{1,5}))\]/g;

function rx(pattern) {
  const p = pattern || DEFAULT_CITE;
  return new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`);
}

/** The known tokens in first-cited order → their number (1-based). */
export function numberCitations(answer, tokens, pattern) {
  const known = new Set(tokens || []);
  const out = new Map();
  const re = rx(pattern);
  let m;
  while ((m = re.exec(answer || ""))) {
    const t = m[1];
    if (known.has(t) && !out.has(t)) out.set(t, out.size + 1);
  }
  // Citations the answer didn't mention in the text (rare) go last, so the sources list is complete.
  for (const t of tokens || []) if (!out.has(t)) out.set(t, out.size + 1);
  return out;
}

/**
 * The answer as Markdown whose citations are links to "#cite-<token>" (drawn as numbered chips). While
 * streaming, tokens not known yet become "#cite-?" (a placeholder chip); after, unknown ones are dropped.
 * Runs of the same token collapse ("[s3][s3]" → one chip).
 */
export function linkCitations(answer, known, pattern, streaming = false) {
  const ok = known instanceof Set ? known : new Set(known || []);
  let last = null;
  return (answer || "").replace(rx(pattern), (whole, token, offset) => {
    const prevEnd = last?.end === offset ? last.token : null;
    last = { end: offset + whole.length, token };
    if (prevEnd === token) return "";
    if (ok.has(token)) return `[${token}](#cite-${encodeURIComponent(token)})`;
    return streaming ? "[?](#cite-%3F)" : "";
  });
}

/** Plain text for the clipboard: "[1]" numbers, and the sources listed under the answer. */
export function plainAnswer(answer, citations, pattern) {
  const list = citations || [];
  const nums = numberCitations(answer, list.map((c) => c.token), pattern);
  const text = (answer || "").replace(rx(pattern), (_w, t) => (nums.has(t) ? `[${nums.get(t)}]` : "")).trim();
  if (!list.length) return text;
  const lines = [...list].sort((a, b) => nums.get(a.token) - nums.get(b.token)).map((c) => {
    const bits = [c.title, c.subtitle, c.meta].filter(Boolean).join(" · ");
    return `[${nums.get(c.token)}] ${bits}${c.href ? ` — ${absolute(c.href)}` : ""}`;
  });
  return `${text}\n\nSources\n${lines.join("\n")}`;
}

function absolute(href) {
  if (/^https?:\/\//i.test(href)) return href;
  try {
    return typeof window !== "undefined" ? new URL(href, window.location.origin).toString() : href;
  } catch {
    return href;
  }
}

/** How fast streamed text is revealed: a few characters a frame, faster when far behind (never > 1 s behind). */
export function revealStep(shown, total) {
  const behind = total - shown;
  if (behind <= 0) return 0;
  return Math.max(2, Math.ceil(behind / 12));
}

/** The last `max` finished turns as history ({question, answer}) for the next question. */
export function historyOf(turns, max = 6) {
  return (turns || []).filter((t) => t.state === "done" && t.answer).slice(-max)
    .map((t) => ({ question: t.question, answer: t.answer }));
}

/** Grow a textarea to its content, up to `max` px. */
export function autoGrowHeight(scrollHeight, max = 168) {
  return Math.min(Math.max(scrollHeight, 0), max);
}
