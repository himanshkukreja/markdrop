/**
 * Small presentation rules shared by the pages and their tests (plain ESM, no imports): when a
 * description is worth showing under a title, and what a home "Start here" card says.
 */

/** Text compared loosely: case, spacing, quotes and closing punctuation (or an ellipsis) aside. */
export function looseText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:…|\.\.\.|[.!?:;,])+$/, "")
    .trim();
}

/** True when `text` says `sentence` already: the same, or starting with it. */
export function repeats(sentence, text) {
  const a = looseText(sentence);
  const b = looseText(text);
  return !!a && (a === b || b.startsWith(a));
}

/**
 * The lede under a page title (site.json `pages.showDescription`): the description, unless the
 * page's first paragraph (`intro`, plain text) already opens with it.
 */
export function pageLede(pages, description, intro) {
  if (!pages || pages.showDescription !== true || !description) return undefined;
  return repeats(description, intro) ? undefined : description;
}

/** The home hero's subtitle: the site description, unless it repeats the headline. */
export function heroLede(headline, description) {
  if (!description) return undefined;
  return looseText(headline) === looseText(description) ? undefined : description;
}

/** A "Start here" card's words: site.json's own title and description, else the page's. */
export function startCardText(entry, page) {
  const t = typeof entry?.title === "string" ? entry.title.trim() : "";
  const d = typeof entry?.description === "string" ? entry.description.trim() : "";
  return { title: t || page.title, description: d || page.description };
}
