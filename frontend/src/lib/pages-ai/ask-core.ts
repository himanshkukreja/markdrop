/**
 * Ask this page: the parts with no DOM and no network (unit-tested in ask.test.mjs; no imports,
 * so `node --test` loads it directly).
 *
 *  - Section links: an answer cites the sections it used as `[text](#heading-id)`. The id is the
 *    reader's heading id (`user-content-<slug>`, components/reading/slug.ts) or the bare slug;
 *    both resolve. In the editor, headings carry no ids, so they're matched by the same slug
 *    of their text, in order (duplicates get -1, -2…).
 *  - The history sent with a question: the last 6 complete turns.
 *  - What a refusal says to the reader, per limit reason or HTTP status.
 */

export const HEADING_ID_PREFIX = "user-content-";
export const HISTORY_TURNS = 6;
const MAX_HISTORY_ANSWER = 4000;
const MAX_HISTORY_QUESTION = 2000;

/** github-slugger-like (mirror of components/reading/slug.ts `slugify`; keep in step). */
export function slugify(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Dedupes like github-slugger ("a", "a-1", "a-2"…), as the reader's heading ids do. */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = slugify(text) || "section";
    let slug = base;
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

/** A section id without the reader's prefix (`user-content-intro` → `intro`). */
export const bareId = (id: string): string => (id.startsWith(HEADING_ID_PREFIX) ? id.slice(HEADING_ID_PREFIX.length) : id);

/**
 * The section an answer's link points at, or null when it's a link elsewhere.
 * `#intro`, `#user-content-intro`, and a link to this same page with a hash, all count.
 */
export function sectionId(href: string | null | undefined, here?: { origin: string; pathname: string }): string | null {
  if (!href) return null;
  let hash: string | null = null;
  if (href.startsWith("#")) hash = href.slice(1);
  else if (here) {
    try {
      const u = new URL(href, here.origin + here.pathname);
      const same = u.origin === here.origin && u.pathname.replace(/\/$/, "") === here.pathname.replace(/\/$/, "");
      if (same && u.hash.length > 1) hash = u.hash.slice(1);
    } catch {
      hash = null;
    }
  }
  if (!hash) return null;
  let id = hash;
  try {
    id = decodeURIComponent(hash);
  } catch {
    /* keep it as written */
  }
  id = id.trim();
  return id && !/\s/.test(id) ? id : null;
}

/** The ids to try for a section, in order: as written, with the reader's prefix, without it. */
export function idCandidates(id: string): string[] {
  const bare = bareId(id);
  return [...new Set([id, HEADING_ID_PREFIX + bare, bare])];
}

/**
 * Which of these headings (their text, in page order) a section id means: the index, or -1.
 * Ids are made exactly as the reader makes them, so a duplicate title resolves to the right one.
 */
export function matchHeading(texts: string[], id: string): number {
  const want = bareId(id).toLowerCase();
  const slug = createSlugger();
  const slugs = texts.map((t) => slug(t));
  const exact = slugs.indexOf(want);
  if (exact >= 0) return exact;
  // A model may drop or add a duplicate's -1 suffix: fall back to the first heading whose slug
  // matches without it.
  const loose = slugs.map((s, i) => (s.replace(/-\d+$/, "") === want.replace(/-\d+$/, "") ? i : -1)).filter((i) => i >= 0);
  return loose.length >= 1 ? loose[0] : -1;
}

export interface SectionRef {
  id: string;
  text: string;
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** The distinct sections an answer links to, in the order it first cites them. */
export function sectionsUsed(answer: string): SectionRef[] {
  const out: SectionRef[] = [];
  const seen = new Set<string>();
  for (const m of answer.matchAll(LINK)) {
    const id = sectionId(m[2]);
    if (!id) continue;
    const key = bareId(id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, text: m[1].replace(/[*_`~]/g, "").trim() });
  }
  return out;
}

export interface AskTurn {
  q: string;
  a: string;
  /** "done" turns are sent as history; a stopped, refused or failed one isn't. */
  state: "streaming" | "done" | "stopped" | "limit" | "error";
}

/** The last 6 complete turns, as the API takes them (`[{q, a}]`), each trimmed to a sane size. */
export function historyFor(turns: AskTurn[], n: number = HISTORY_TURNS): { q: string; a: string }[] {
  return turns
    .filter((t) => t.state === "done" && t.a.trim())
    .slice(-n)
    .map((t) => ({ q: t.q.slice(0, MAX_HISTORY_QUESTION), a: t.a.slice(0, MAX_HISTORY_ANSWER) }));
}

/** What the reader sees when AI refuses, per `limit` reason (`fallback`: the server's sentence, for a reason this doesn't know). */
export function limitMessage(reason: string | null | undefined, fallback?: string | null): string {
  switch (reason) {
    case "daily":
      return "AI limit reached for today. Try again tomorrow.";
    case "monthly":
      return "AI limit reached for this month. It resets on the 1st (UTC).";
    case "burst":
      return "That's a lot of questions in a short time. Wait a minute, then try again.";
    case "user_daily":
      return "You've reached your AI limit for today. Try again tomorrow.";
    case "blocked":
      return "AI features aren't available on your account.";
    case "workspace_off":
      return "AI is off for this workspace.";
    case "off":
    case "not_configured":
      return "AI isn't available right now.";
    default:
      return fallback || "AI isn't available right now. Try again later.";
  }
}

/** What the reader sees for a failed request, by HTTP status (0: no connection). */
export function httpMessage(status: number, detail?: string | null): string {
  if (status === 0) return "Couldn't reach Markdrop. Check your connection and try again.";
  if (status === 401) return "Your sign-in has run out. Sign in again to ask about this page.";
  if (status === 403 || status === 404) return "You can't ask AI about this page.";
  if (status === 413 || status === 422) return detail || "That question is too long. Try a shorter one.";
  if (status === 429) return limitMessage("burst");
  if (status === 501 || status === 503) return limitMessage("off");
  return "Something went wrong while answering. Try again.";
}
