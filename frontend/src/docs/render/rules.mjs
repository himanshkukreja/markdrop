/**
 * Pure rules the renderer's plugins (plugins.ts) apply, kept free of imports so tests run them
 * directly: the `wrap` flag in code-fence meta, and the hidden anchors that keep old heading ids
 * (frontmatter `anchors`) landing on their headings.
 */

/** True when a fence's meta has the bare `wrap` flag (outside quoted values and `{…}`): soft-wrapped lines. */
export function hasWrapFlag(meta) {
  return /(?:^|\s)wrap(?=\s|$)/.test(String(meta ?? "").replace(/=(?:"[^"]*"|'[^']*'|\S+)/g, "=").replace(/\{[^}]*\}/g, " "));
}

/** `{ "old-id": "new-id" }` → Map(new-id → [old ids]). */
export function aliasesByTarget(anchors) {
  const out = new Map();
  for (const [from, to] of Object.entries(anchors ?? {})) {
    if (typeof to !== "string" || !from || !to || from === to) continue;
    out.set(to, [...(out.get(to) ?? []), from]);
  }
  return out;
}

/**
 * The hast nodes that go first inside a heading whose id has aliases: one empty, hidden span per
 * old id (`taken` holds ids already used on the page, which an alias must not repeat).
 */
export function aliasNodes(aliases, id, taken) {
  return (aliases.get(id) ?? [])
    .filter((a) => !taken.has(a))
    .map((a) => ({ type: "element", tagName: "span", properties: { id: a, className: ["dx-anchor-alias"], ariaHidden: "true" }, children: [] }));
}
