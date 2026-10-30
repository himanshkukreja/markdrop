/**
 * A docs page as the API stores it and as the editor edits it.
 *
 * The API keeps the page header as fields (`title`, `description`, `icon`, `hidden`), any other
 * frontmatter keys as `frontmatter_extra`, and the body as `markdown`. The editor edits ONE
 * Markdown document whose frontmatter carries the header (its PageHeader binds title / description
 * / icon to those keys, and Markdown mode shows them). These two functions convert between the
 * two, using the editor's own frontmatter helpers so the header is written exactly as the editor
 * writes it: nothing is lost (every extra key round-trips, typed) or duplicated (a header key is
 * never also in frontmatter_extra, and the body never carries a second frontmatter block).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { readMeta, splitFrontmatter, writeFrontmatter } from "../../docs-editor/core/frontmatter.mjs";

/** The keys the API owns as fields (the snapshot writer refuses them in frontmatter_extra, and so does the API). */
export const OWN_KEYS = ["title", "description", "icon", "hidden"] as const;

export interface DocFields {
  title: string;
  description: string;
  icon: string | null;
  hidden: boolean;
  markdown: string;
  frontmatter_extra: Record<string, unknown>;
}

/** The body as stored: no leading blank line (the one after the frontmatter is the composer's). */
const bodyOf = (body: string) => body.replace(/^\r?\n/, "");

/** The fields → the one document the editor edits. */
export function composeDoc(f: Pick<DocFields, "title" | "description" | "icon" | "markdown" | "frontmatter_extra">): string {
  // A body that still opens with its own --- block (stored before this split, or pasted through the
  // API) would read as a second frontmatter: fold its keys in (the fields win) and drop the block.
  const pasted = splitFrontmatter(f.markdown ?? "");
  const pastedKeys = pasted.front ? strictFront(pasted.front) ?? {} : {};
  let front = writeFrontmatter("", { title: f.title ?? "", description: f.description ?? "" }, { keep: ["title", "description"] });
  if (f.icon) front = writeFrontmatter(front, { icon: f.icon });
  const extra = Object.fromEntries(
    Object.entries({ ...pastedKeys, ...(f.frontmatter_extra ?? {}) }).filter(([k, v]) => !(OWN_KEYS as readonly string[]).includes(k) && v !== undefined),
  );
  if (Object.keys(extra).length) {
    const yaml = stringifyYaml(extra, { lineWidth: 0 }).trimEnd();
    front = front.replace(/---[ \t]*\r?\n?$/, `${yaml}\n---\n`);
  }
  return `${front}\n${bodyOf(pasted.front ? pasted.body : f.markdown ?? "")}`;
}

/** Strict YAML of a frontmatter block's inside, or null when it doesn't parse (mid-typing). */
function strictFront(front: string): Record<string, unknown> | null {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(front);
  if (!m) return {};
  try {
    const v = parseYaml(m[1] ?? "");
    if (v === null || v === undefined) return {};
    return typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The editor's document → the fields to save. While the frontmatter isn't valid YAML (someone is
 * typing in Markdown mode), the header comes from the editor's line-by-line reading and the extra
 * keys stay as they were (`prevExtra`), so a half-typed line never wipes them.
 */
export function parseDoc(doc: string, prevExtra: Record<string, unknown>): Omit<DocFields, "hidden"> & { hidden?: boolean } {
  const { front, body } = splitFrontmatter(doc);
  const meta = readMeta(front);
  const strict = strictFront(front);
  const out: Omit<DocFields, "hidden"> & { hidden?: boolean } = {
    title: meta.title,
    description: meta.description,
    icon: meta.icon || null,
    markdown: bodyOf(body),
    frontmatter_extra: prevExtra,
  };
  if (strict) {
    out.frontmatter_extra = Object.fromEntries(Object.entries(strict).filter(([k]) => !(OWN_KEYS as readonly string[]).includes(k)));
    if ("hidden" in strict) out.hidden = strict.hidden === true || strict.hidden === "true";
  }
  return out;
}

/** Sets header keys in the document's frontmatter (the page panel's icon, say), the editor's way. */
export function setDocKeys(doc: string, patch: Record<string, string | null>): string {
  const { front, body } = splitFrontmatter(doc);
  const next = writeFrontmatter(front, patch, { keep: ["title", "description"] });
  return next + (next && body && !/^\r?\n/.test(body) && !front ? "\n" : "") + body;
}
