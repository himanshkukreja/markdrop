/** Writing a page's properties into its front matter (the editor only; reading is pageProps.ts). */
import { splitFrontmatter, writeFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import type { PageProps } from "./pageProps";

/** The Markdown with some properties changed (null / false / default removes the key). */
export function writePageProps(markdown: string, patch: Partial<PageProps>): string {
  const { front, body } = splitFrontmatter(markdown);
  const p: Record<string, string | null> = {};
  if ("icon" in patch) p.icon = patch.icon || null;
  if ("cover" in patch) p.cover = patch.cover || null;
  if ("coverY" in patch) p.cover_y = patch.coverY === undefined || patch.coverY === 50 ? null : String(Math.round(patch.coverY));
  if ("fullWidth" in patch) p.full_width = patch.fullWidth ? "true" : null;
  if ("smallText" in patch) p.small_text = patch.smallText ? "true" : null;
  if ("font" in patch) p.font = patch.font && patch.font !== "default" ? patch.font : null;
  if ("locked" in patch) p.locked = patch.locked ? "true" : null;
  let next = writeFrontmatter(front, p);
  // Booleans and numbers as YAML values, not strings.
  next = next.replace(/^(full_width|small_text|locked): "true"$/gm, "$1: true").replace(/^cover_y: "(\d+)"$/gm, "cover_y: $1");
  // Nothing left in it: no front matter at all.
  if (/^---[ \t]*\r?\n---[ \t]*(\r?\n)?$/.test(next)) next = "";
  return next + body;
}
