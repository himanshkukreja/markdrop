/**
 * The `@` people picker's rules (menus/people.tsx), kept free of runtime imports so the tests load
 * them in Node (test/people.test.mjs):
 *
 * - When `@` opens it: at the start of a line, or after whitespace or punctuation (so `a@b.com`
 *   never does), never in a code block (Mermaid and math blocks are code blocks too) or inline code.
 * - When it stays open: one word always (it says "No one matches"); more words only while someone
 *   still matches them ("@ben m" → Ben Member), so typing on after a name you didn't pick closes it.
 *   A space never opens it, only keeps it open.
 * - Filtering: fuzzy, by name or email, best first.
 */

/** One person the picker offers (GET /documents/{slug}/mentionable). */
export interface PickPerson {
  id: string;
  name: string;
  email?: string | null;
  avatar_url?: string | null;
  you?: boolean;
}

/** Lower case, accents dropped: "José" matches "jose". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * May `@` open the picker after this character? `null` is the start of the line, or right after a
 * chip or a line break. Letters, digits, `_` and another `@` keep it closed (an email address, a
 * handle); whitespace and punctuation open it ("cc:@ben", "(@ben").
 */
export function opensAfter(before: string | null): boolean {
  if (before === null || before === "") return true;
  return !/[\p{L}\p{N}\p{M}_@]/u.test(before);
}

/** The picker's query keeps it open (see the top of the file). `people` is null until loaded. */
export function keepsOpen(query: string, people: readonly PickPerson[] | null): boolean {
  if (query.length > 60 || /^\s/.test(query)) return false;
  if (!/\s/.test(query)) return true;
  if (query.trim().split(/\s+/).length > 3) return false;
  if (!people) return true;
  return filterPeople(people, query).length > 0;
}

/**
 * How well `q` matches `text` as letters in order: null when it doesn't, else the gaps between
 * the letters (a jump to the start of a word costs less). Too scattered a match doesn't count.
 */
function inOrder(q: string, text: string): number | null {
  let at = 0;
  let last = -1;
  let gaps = 0;
  for (const ch of q) {
    const i = text.indexOf(ch, at);
    if (i < 0) return null;
    if (last >= 0 && i > last + 1) gaps += /[\s.\-_@]/.test(text[i - 1] ?? "") ? 0.5 : 1;
    last = i;
    at = i + 1;
  }
  return gaps <= Math.max(2, q.length) ? gaps : null;
}

const WORDS = /[\s.\-_'’@]+/;

/** A person's score for a folded, trimmed query: lower is better, null is no match. */
export function scorePerson(p: PickPerson, q: string): number | null {
  if (!q) return 0;
  const name = fold(p.name);
  const email = fold(p.email ?? "");
  const local = email.split("@")[0] ?? "";
  if (name.startsWith(q)) return 0;
  const words = name.split(WORDS).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 0.5;
  // "ben m": each word of the query starts a word of the name, in order.
  const qw = q.split(/\s+/).filter(Boolean);
  if (qw.length > 1) {
    let k = 0;
    for (const w of words) if (k < qw.length && w.startsWith(qw[k]!)) k++;
    if (k === qw.length) return 0.75;
  }
  if (email && (email.startsWith(q) || local.split(WORDS).some((w) => w.startsWith(q)))) return 1;
  // One letter matches a name's or an address's start only, never anywhere in it.
  if (q.length < 2) return null;
  if (name.includes(q)) return 1.5;
  if (email.includes(q)) return 2;
  const compact = q.replace(/\s+/g, "");
  const n = inOrder(compact, name);
  if (n !== null) return 3 + Math.min(n, 9) / 10;
  const e = local ? inOrder(compact, local) : null;
  if (e !== null) return 4 + Math.min(e, 9) / 10;
  return null;
}

/** The people matching `query` (by name or email, fuzzy), best first; everyone for no query. */
export function filterPeople<P extends PickPerson>(people: readonly P[], query: string, limit = 50): P[] {
  const q = fold(query).trim().replace(/\s+/g, " ");
  return people
    .map((p, i) => ({ p, i, s: scorePerson(p, q) }))
    .filter((x): x is { p: P; i: number; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.p);
}

/** The bits of a ProseMirror state the trigger rules read (structural: no imports). */
interface PMish {
  doc: {
    resolve(pos: number): {
      parent: { type: { name: string; spec: { code?: boolean } } };
      parentOffset: number;
      nodeBefore: { isText: boolean; text?: string | null } | null;
    };
    nodeAt(pos: number): { marks: ReadonlyArray<{ type: { name: string; spec: { code?: boolean } } }> } | null;
    textBetween(from: number, to: number, blockSeparator?: string, leafText?: string): string;
  };
}

/**
 * What the trigger rules need about an `@` at `range.from` (the suggestion's range, `@` included):
 * the character before it (null: start of the line, or a chip), whether it is in code, the query.
 */
export function triggerContext(state: PMish, range: { from: number; to: number }) {
  const $at = state.doc.resolve(range.from);
  const marks = state.doc.nodeAt(range.from)?.marks ?? [];
  const inCode = !!$at.parent.type.spec.code || marks.some((m) => !!m.type.spec.code || m.type.name === "code");
  const nb = $at.parentOffset === 0 ? null : $at.nodeBefore;
  const before = nb && nb.isText && nb.text ? nb.text.slice(-1) : null;
  const query = state.doc.textBetween(range.from + 1, range.to, "\n", "\ufffc");
  return { before, inCode, query };
}

/**
 * Does an `@` here open (or keep open) the picker? `force`: "/person" put it there. `active`: it is
 * open already. A space only ever keeps an open picker open: coming back (Backspace, a click) to
 * an `@ben ` left as text earlier doesn't open it again.
 */
export function mayOpen(state: PMish, range: { from: number; to: number }, people: readonly PickPerson[] | null, force = false, active = true): boolean {
  const c = triggerContext(state, range);
  if (c.inCode) return false;
  if (!force && !opensAfter(c.before)) return false;
  if (!active && /\s/.test(c.query)) return false;
  return keepsOpen(c.query, people);
}
