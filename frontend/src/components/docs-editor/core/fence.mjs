/**
 * Code-fence meta (` ```bash title="Install" wrap {2,4} `) and directive labels, edited one part at
 * a time so the rest of what the author wrote stays as it was.
 */

const TITLE = /(^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/;

/** `{ title, wrap }` read the way the renderer reads them. */
export function readMeta(meta) {
  const m = String(meta ?? "");
  const t = TITLE.exec(m);
  const bare = m.replace(/=(?:"[^"]*"|'[^']*'|\S+)/g, "=").replace(/\{[^}]*\}/g, " ");
  return { title: t ? t[2] ?? t[3] ?? t[4] ?? "" : "", wrap: /(?:^|\s)wrap(?=\s|$)/.test(bare) };
}

const tidy = (s) => s.replace(/\s+/g, " ").trim() || null;

/** Sets (or with "" removes) `title="…"`, keeping every other part of the meta. */
export function setMetaTitle(meta, title) {
  let m = String(meta ?? "");
  const value = String(title ?? "").replace(/"/g, "'");
  if (TITLE.test(m)) m = m.replace(TITLE, value ? `$1title="${value}"` : "$1");
  else if (value) m = `${m} title="${value}"`;
  return tidy(m);
}

/** Adds or removes the bare `wrap` flag. */
export function setMetaWrap(meta, on) {
  const m = String(meta ?? "");
  const has = readMeta(m).wrap;
  if (on && !has) return tidy(`${m} wrap`);
  if (!on && has) return tidy(m.replace(/(^|\s)wrap(?=\s|$)/, "$1"));
  return tidy(m);
}

/** A directive `[label]` as raw Markdown → the text shown in an input (escapes resolved). */
export function labelText(label) {
  return label == null ? "" : String(label).replace(/\\([[\]\\])/g, "$1");
}

/** Text typed in an input → a `[label]` that can't break out of its brackets (null when empty). */
export function textLabel(text) {
  const t = String(text ?? "").replace(/\n/g, " ");
  return t ? t.replace(/([\\[\]])/g, "\\$1") : null;
}
