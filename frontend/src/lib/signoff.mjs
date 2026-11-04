/**
 * Sign-off blocks (`:::signoff{#b-x person="<user id>" label="…" options="A|B" lock=above}`): what
 * the editor, the reader and the tests share. Mirrors backend/app/services/signoffs.py (defaults,
 * limits, the decision's colour). The decision itself is never read from the Markdown.
 */

export const DEFAULT_LABEL = "Sign-off";
export const DEFAULT_OPTIONS = ["Approved", "Not approved"];
export const MAX_OPTIONS = 6;
export const MAX_OPTION_CHARS = 80;
export const MAX_LABEL_CHARS = 120;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** `"A|B"` → `["A", "B"]` (trimmed, no empties or repeats, at most 6 of 80 characters); defaults when none. */
export function parseOptions(value) {
  const out = [];
  for (const part of String(value ?? "").split("|")) {
    const p = clean(part).slice(0, MAX_OPTION_CHARS);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out.length ? out : [...DEFAULT_OPTIONS];
}

/** Options → the attribute (a `|` or `"` inside an option can't be written: they become spaces / ”). */
export function joinOptions(list) {
  const out = [];
  for (const o of list ?? []) {
    const p = clean(String(o).replace(/\|/g, " ").replace(/"/g, "”")).slice(0, MAX_OPTION_CHARS);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= MAX_OPTIONS) break;
  }
  return out.join("|");
}

/** A block's attributes → what it says: `{ id, person, label, options, lock }`. */
export function signoffInfo(attributes) {
  const a = attributes ?? {};
  const id = typeof a.id === "string" && /^b-[a-z0-9]{4,12}$/.test(a.id) ? a.id : null;
  const person = clean(a.person) || null;
  const label = clean(a.label).slice(0, MAX_LABEL_CHARS) || DEFAULT_LABEL;
  return { id, person, label, options: parseOptions(a.options), lock: a.lock === "above" };
}

/** The decision's colour: "success" | "danger" | "warning" | "neutral" (null while waiting). */
export function tone(option, options = []) {
  if (!option) return null;
  const t = String(option).toLowerCase();
  if (/\b(not|no|reject\w*|declin\w*|block\w*|fail\w*|den(y|ied)|veto\w*|stop)\b/.test(t)) return "danger";
  if (/\b(change\w*|revis\w*|hold|wait\w*|later|condition\w*|partial\w*|minor|pending|with)\b/.test(t)) return "warning";
  if (options.length && option === options[0]) return "success";
  if (/\b(approv\w*|yes|accept\w*|ok|go|ship\w*|lgtm|pass\w*|done|agree\w*)\b/.test(t)) return "success";
  return "neutral";
}
