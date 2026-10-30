import { parse as parseYaml } from "yaml";
import type { Frontmatter } from "./types";

/**
 * Frontmatter: a `---` fenced YAML block at the very top of a page. Returns the parsed fields and
 * the body, plus every problem found (the build skips nothing for a soft problem; `docs:check`
 * prints them). Dates may be written bare (`2026-10-28`); YAML would read those as Date objects,
 * so they are normalised back to `YYYY-MM-DD` strings.
 */
export interface ParsedFrontmatter {
  data: Partial<Frontmatter> & Record<string, unknown>;
  body: string;
  problems: string[];
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function toDateString(v: unknown): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function toList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return v.split(",").map((x) => x.trim()).filter(Boolean);
  return undefined;
}

/** `anchors: { old-id: new-id }` → the string pairs (anything else dropped; docs:check reports it). */
function toAnchors(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, id] of Object.entries(v as Record<string, unknown>)) {
    const from = String(k).trim().replace(/^#/, "");
    const to = typeof id === "string" ? id.trim().replace(/^#/, "") : "";
    if (from && to && from !== to) out[from] = to;
  }
  return Object.keys(out).length ? out : undefined;
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** `key: value` per line; `[a, b]` → list. Used only when strict YAML fails. */
export function looseFrontmatter(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim();
    out[m[1]] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(",").map(unquote).filter(Boolean) : unquote(v);
  }
  return out;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const problems: string[] = [];
  const src = source.replace(/^﻿/, "");
  const m = FENCE.exec(src);
  if (!m) return { data: {}, body: src, problems: ["missing frontmatter (--- block at the top)"] };
  let raw: Record<string, unknown> = {};
  try {
    const v = parseYaml(m[1]);
    if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
    else problems.push("frontmatter is not a key: value map");
  } catch {
    // Writers often leave a ": " inside an unquoted value (strict YAML rejects it). Read the
    // block line by line instead: `key: rest of the line`, `[a, b]` lists.
    raw = looseFrontmatter(m[1]);
    problems.push("frontmatter isn't valid YAML (read leniently); quote values that contain \": \"");
  }
  const data: ParsedFrontmatter["data"] = { ...raw };
  if (raw.title !== undefined) data.title = String(raw.title).trim();
  if (raw.description !== undefined) data.description = String(raw.description).trim();
  data.updated = toDateString(raw.updated);
  data.checked = toDateString(raw.checked);
  data.prerequisites = toList(raw.prerequisites);
  data.keywords = toList(raw.keywords);
  if (raw.since !== undefined) data.since = String(raw.since).trim();
  if (raw.nav !== undefined) data.nav = String(raw.nav).trim() || undefined;
  data.icon = typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : undefined;
  data.anchors = toAnchors(raw.anchors);

  if (!data.title) problems.push("frontmatter: title is required");
  if (!data.description) problems.push("frontmatter: description is required");
  else if (data.description.length > 160) problems.push(`frontmatter: description is ${data.description.length} chars (max 160)`);
  if (!data.updated) problems.push("frontmatter: updated is required (YYYY-MM-DD)");
  else if (!DATE_RE.test(data.updated)) problems.push(`frontmatter: updated "${data.updated}" is not YYYY-MM-DD`);
  if (data.nav && data.nav.length > 40) problems.push(`frontmatter: nav is ${data.nav.length} chars (max 40)`);
  if (data.checked && !DATE_RE.test(data.checked)) problems.push(`frontmatter: checked "${data.checked}" is not YYYY-MM-DD`);
  for (const p of data.prerequisites ?? []) if (!p.startsWith("/")) problems.push(`frontmatter: prerequisite "${p}" must be a docs path starting with /`);

  return { data, body: src.slice(m[0].length).replace(/^\s*\n/, ""), problems };
}
