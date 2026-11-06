/**
 * Initials for an avatar, from letters and digits only (any script): the first letter of the first
 * and the last word ("Ishaan Gupta" → "IG"), one letter for one word, else from the email's local
 * part ("priya.nair@…" → "PN"), else "?". Brackets, markdown links, quotes, emoji and other
 * punctuation never show up ("[Ishaan Gupta](mailto:…)" → "IG", not "[G"; owner 2026-11-06).
 */

const LETTER = /[\p{L}\p{N}]\p{M}*/u;

function wordsOf(text, splitDots) {
  const t = String(text || "")
    .replace(/\]\([^)]*\)/g, " ")          // "[Name](mailto:x)" → "[Name "
    .replace(/\([^)]*@[^)]*\)|<[^>]*@[^>]*>/g, " ")   // "(x@y)", "<x@y>"
    .replace(/mailto:\S*/gi, " ");
  return t.split(splitDots ? /[\s._+-]+/u : /\s+/u)
    .map((w) => { const m = w.match(LETTER); return m ? m[0] : ""; })
    .filter(Boolean);
}

/** @param {string | null | undefined} name @param {string | null | undefined} [email] */
export function initialsOf(name, email) {
  let n = String(name || "").trim();
  if (n.includes("@") && !/\s/.test(n)) { email = email || n; n = ""; }
  let words = wordsOf(n, false);
  if (!words.length && email) words = wordsOf(String(email).split("@")[0], true);
  if (!words.length) return "?";
  const out = words.length === 1 ? words[0] : words[0] + words[words.length - 1];
  return out.toLocaleUpperCase();
}
