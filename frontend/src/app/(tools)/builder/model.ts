/**
 * The builder's data model: the localStorage draft (`markdrop:builder:v1`, shape unchanged:
 * `{ title, sections: [{ uid, templateId, content }] }`), assembling the README, and the
 * table-of-contents generator. Pure functions only, so they're cheap to reason about.
 */

import { TEMPLATES_BY_ID, headingSlug } from "@/lib/readmeSections";

export interface SectionInstance {
  uid: string;
  templateId: string;
  content: string;
}

export interface BuilderDraft {
  title?: string;
  sections?: SectionInstance[];
}

export const STORAGE_KEY = "markdrop:builder:v1";

/** The template whose first line is the README's H1. */
export const TITLE_TEMPLATE = "title-and-description";
/** The H1 that template ships with. The builder title replaces it (REVAMP_PLAN 7.5). */
export const DEFAULT_H1 = "Project Title";

let uidSeq = 0;
export function nextUid(): string {
  uidSeq += 1;
  return `s${Date.now().toString(36)}${uidSeq.toString(36)}`;
}

/** The markdown a new instance of `templateId` starts with, with the README title as its H1. */
export function templateMarkdown(templateId: string, title: string): string {
  const md = TEMPLATES_BY_ID[templateId]?.markdown ?? "";
  return templateId === TITLE_TEMPLATE ? replaceH1(md, DEFAULT_H1, title) : md;
}

export function newSection(templateId: string, title = ""): SectionInstance {
  return { uid: nextUid(), templateId, content: templateMarkdown(templateId, title) };
}

export function assemble(sections: SectionInstance[]): string {
  return sections
    .map((s) => s.content.replace(/\s+$/, ""))
    .filter((c) => c.length > 0)
    .join("\n\n");
}

/**
 * If `md` opens with `# <from>` (the template default, or the previous title), rewrite that line to
 * `# <to>` (the default again when `to` is blank). Anything the author typed by hand is left alone,
 * so the title only ever replaces text the builder put there.
 */
export function replaceH1(md: string, from: string, to: string): string {
  const nl = md.indexOf("\n");
  const first = nl < 0 ? md : md.slice(0, nl);
  const m = /^#\s+(.*?)\s*$/.exec(first);
  if (!m) return md;
  const current = m[1];
  const fromText = from.trim() || DEFAULT_H1;
  if (current !== fromText && current !== DEFAULT_H1) return md;
  const next = `# ${to.trim() || DEFAULT_H1}`;
  return nl < 0 ? next : next + md.slice(nl);
}

/** Keep the first title section's H1 in step with the README title. */
export function syncTitle(sections: SectionInstance[], prevTitle: string, nextTitle: string): SectionInstance[] {
  const i = sections.findIndex((s) => s.templateId === TITLE_TEMPLATE);
  if (i < 0) return sections;
  const s = sections[i];
  const content = replaceH1(s.content, prevTitle, nextTitle);
  if (content === s.content) return sections;
  const out = sections.slice();
  out[i] = { ...s, content };
  return out;
}

/** Build a nested TOC from the ## / ### headings of every OTHER section. */
export function generateToc(sections: SectionInstance[], selfUid: string): string {
  const lines: string[] = [];
  for (const s of sections) {
    if (s.uid === selfUid) continue;
    for (const raw of s.content.split("\n")) {
      const m = /^(#{2,3})\s+(.+)$/.exec(raw.trim());
      if (!m) continue;
      const level = m[1].length;
      const text = m[2].replace(/[#*`]/g, "").trim();
      if (!text) continue;
      const indent = level === 3 ? "  " : "";
      lines.push(`${indent}- [${text}](#${headingSlug(text)})`);
    }
  }
  return "## Table of Contents\n\n" + (lines.join("\n") || "- [Section](#section)");
}

export function readDraft(): BuilderDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as BuilderDraft;
    return data && Array.isArray(data.sections) && data.sections.length ? data : null;
  } catch {
    return null; // corrupt draft or storage blocked: start fresh
  }
}

export function writeDraft(title: string, sections: SectionInstance[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ title, sections }));
  } catch {
    /* quota or blocked storage: the builder still works, it just won't survive a reload */
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
