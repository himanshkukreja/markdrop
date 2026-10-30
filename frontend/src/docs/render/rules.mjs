/**
 * Pure rules the renderer's plugins (plugins.ts) apply, kept free of path aliases so tests run them
 * directly with node: the `wrap` flag in code-fence meta, the hidden anchors that keep old heading
 * ids (frontmatter `anchors`) landing on their headings, and image alt text recomputed from the
 * source when the directive syntax swallowed part of it ("0:15").
 */
import { fromMarkdown } from "mdast-util-from-markdown";

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

/* ── image alt text ──────────────────────────────────────────────────────── */

/**
 * remark-parse's options for a processor's `data()`: the micromark and mdast extensions its
 * plugins registered (gfm, math, directive…), so a slice re-parses exactly as the page did.
 */
export function parserOptions(data) {
  return { extensions: data?.micromarkExtensions ?? [], mdastExtensions: data?.fromMarkdownExtensions ?? [] };
}

/**
 * Text of the inline content of an image's label, as the renderer shows the same content in prose:
 * mdast-util-to-string's rules (value, then alt, then children), except that a text directive reads
 * the way remarkDocs renders it: `:kbd[Ctrl]` is its label, any other `:name[label]` is the literal
 * `:name` plus `[label]` (so "0:15" stays "0:15").
 */
function altText(n) {
  if (!n || typeof n !== "object") return "";
  if (n.type === "textDirective") {
    const inner = (n.children ?? []).map(altText).join("");
    if (n.name === "kbd") return inner;
    return `:${n.name}${n.children?.length ? `[${inner}]` : ""}`;
  }
  if (typeof n.value === "string") return n.value;
  if (typeof n.alt === "string" && n.alt) return n.alt;
  return (n.children ?? []).map(altText).join("");
}

/**
 * The alt text of an `image` / `imageReference` node recomputed from its source, or undefined when
 * it can't be (no positions, the slice doesn't line up, a structure that re-parses differently).
 *
 * Why: with remark-directive, micromark reads `:15` in `![Video at 0:15](x.png)` as a text
 * directive, and mdast's alt (toString of the label) drops it. Re-parsing the slice as a link, with
 * the same extensions, keeps the label's phrasing nodes, which `altText` reads back in full.
 */
export function imageAltFromSource(source, node, options = {}) {
  const s = node?.position?.start?.offset, e = node?.position?.end?.offset;
  if (typeof source !== "string" || typeof s !== "number" || typeof e !== "number" || e <= s + 2) return undefined;
  const slice = source.slice(s, e);
  if (slice[0] !== "!" || slice[1] !== "[") return undefined;
  const ref = node.type === "imageReference";
  if (ref ? typeof node.label !== "string" || !node.label : node.type !== "image") return undefined;
  // `![label](url)` → `[label](url)`; a reference gets a definition so it still resolves.
  const doc = slice.slice(1) + (ref ? `\n\n[${node.label}]: #\n` : "");
  let tree;
  try {
    tree = fromMarkdown(doc, { extensions: options.extensions ?? [], mdastExtensions: options.mdastExtensions ?? [] });
  } catch {
    return undefined;
  }
  const para = tree.children?.[0];
  if (para?.type !== "paragraph" || para.children?.length !== 1) return undefined;
  const link = para.children[0];
  const same = ref ? link.type === "linkReference" && link.identifier === node.identifier : link.type === "link" && link.url === node.url;
  if (!same) return undefined;
  return (link.children ?? []).map(altText).join("");
}

/**
 * Recomputes the alt text of every image whose source has a colon (the only character the
 * directive syntax swallows from a label). Anything that doesn't line up keeps the parser's alt.
 */
export function fixImageAlts(tree, source, options = {}) {
  if (typeof source !== "string" || !source.includes(":")) return;
  const visit = (n) => {
    if (n.type === "image" || n.type === "imageReference") {
      const s = n.position?.start?.offset, e = n.position?.end?.offset;
      if (typeof s === "number" && typeof e === "number" && source.slice(s, e).includes(":")) {
        const alt = imageAltFromSource(source, n, options);
        if (alt !== undefined) n.alt = alt;
      }
    }
    if (Array.isArray(n.children)) n.children.forEach(visit);
  };
  visit(tree);
}
