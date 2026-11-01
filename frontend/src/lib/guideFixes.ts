/**
 * A guide's Fix list (backend routers/guide_fixes.py): the ranked things to fix next, from readers'
 * signals (where they leave a page, what they searched for and didn't find, what Ask AI couldn't
 * answer, "not helpful" votes, video drop-off, broken links, stale and heavy pages). Kept out of
 * lib/docsSites.ts so the editor's bundle carries only the few calls it needs.
 */
import { docsRequest } from "@/lib/docsSites";
import { after, guideEvents } from "@/lib/guidesEvents";

const enc = encodeURIComponent;

export type FixType = "drop" | "search" | "ask" | "not_helpful" | "video" | "broken" | "stale" | "heavy";
export type FixStatus = "open" | "in_progress" | "fixed" | "dismissed";
export type FixLevel = "high" | "medium" | "low";
export type DismissReason = "not_a_problem" | "wont_fix" | "duplicate" | "other";
export type FixStatusFilter = "active" | FixStatus | "all";

export interface DropPoint { i: number; id: string | null; title: string; reached: number; left: number; reached_pct: number; left_pct: number }
export interface Sample { text: string; n: number }

/** What an item's evidence can carry (by type; the list has the headline numbers only). */
export interface FixEvidence {
  // drop
  measured?: number; left?: number; left_pct?: number; typical_pct?: number; curve?: DropPoint[] | number[]; seconds?: number | null;
  // search / ask
  searches?: number; questions?: number; wordings?: number; samples?: Sample[];
  pages?: { path: string; title: string; n?: number; link?: boolean; hits?: number }[];
  // not helpful
  yes?: number; no?: number; helpful_pct?: number; comments?: { id: string | null; text: string; ts: string | null }[];
  // video
  video?: string; video_title?: string; plays?: number; length?: number; at?: number; fall_pct?: number;
  // broken
  target?: string; hits?: number; suggested?: string | null;
  // stale / heavy
  updated_at?: string; age_days?: number; readers?: number; words?: number; media?: number;
}

export interface FixDraft {
  kind: "section" | "append" | "new_page" | "link" | "notes";
  page_id?: string;
  path?: string;
  page_title?: string;
  /** The heading id of the section it replaces (null: the introduction). */
  section?: string | null;
  heading?: string | null;
  depth?: number;
  before: string;
  after: string;
  addition?: string;
  /** A new page's title (kind new_page). */
  title?: string;
  summary?: string | null;
  at?: string;
}

export interface FixHistory { at: string; status: FixStatus; by: string; note?: string }

export interface FixItem {
  id: string;
  type: FixType;
  key: string;
  status: FixStatus;
  title: string;
  summary: string;
  path: string | null;
  page_id: string | null;
  page_title: string | null;
  section: string | null;
  section_title: string | null;
  /** Readers affected (what the evidence counts). */
  readers: number;
  severity: number;
  recency: number;
  impact: number;
  level: FixLevel;
  detected_at: string | null;
  last_seen_at: string | null;
  status_at: string | null;
  reason: DismissReason | null;
  note: string | null;
  reopened: number;
  fixed_by: "person" | "publish" | "detector" | null;
  fixed_build: number | null;
  /** Not detected at the last check (it may have gone away). */
  quiet: boolean;
  has_draft: boolean;
  applied: { page_id: string; at: string } | null;
  evidence: FixEvidence;
  /** On GET …/fixes/{id} only. */
  history?: FixHistory[];
  draft?: FixDraft | null;
  can_edit?: boolean;
}

export interface FixList {
  items: FixItem[];
  counts: Record<FixStatus, number>;
  types: Record<FixType, number>;
  pages: { path: string; title: string | null; n: number }[];
  checked_at: string | null;
  readers: number | null;
  window_days: number;
  can_edit: boolean;
  enabled: boolean;
  live: boolean;
  stats?: { new: number; updated: number; reopened: number; closed: number; fixed_by_publish: number };
}

export function getFixes(siteId: string, q: { status?: FixStatusFilter; type?: FixType | null; path?: string | null } = {}): Promise<FixList> {
  const p = new URLSearchParams();
  if (q.status && q.status !== "active") p.set("status", q.status);
  if (q.type) p.set("type", q.type);
  if (q.path) p.set("path", q.path);
  const qs = p.toString();
  return docsRequest(`/${enc(siteId)}/fixes${qs ? `?${qs}` : ""}`);
}

export function getFixCount(siteId: string): Promise<{ open: number; high: number }> {
  return docsRequest(`/${enc(siteId)}/fixes/count`);
}

export function getFix(siteId: string, id: string): Promise<FixItem> {
  return docsRequest(`/${enc(siteId)}/fixes/${enc(id)}`);
}

/** Editors and up: re-detect now. */
export function checkFixes(siteId: string): Promise<FixList> {
  return docsRequest<FixList>(`/${enc(siteId)}/fixes/check`, { method: "POST" }).then(after(() => guideEvents.fixesChecked()));
}

export function setFixStatus(siteId: string, item: Pick<FixItem, "id" | "type">, status: FixStatus, reason?: DismissReason, note?: string): Promise<FixItem> {
  return docsRequest<FixItem>(`/${enc(siteId)}/fixes/${enc(item.id)}`, { method: "PATCH", json: { status, reason, note } })
    .then(after(() => guideEvents.fixStatus(item.type, status)));
}

/** An AI-drafted fix (spends one of the guide's monthly AI uses; a link fix is free). */
export function draftFix(siteId: string, item: Pick<FixItem, "id" | "type">): Promise<FixItem> {
  return docsRequest<FixItem>(`/${enc(siteId)}/fixes/${enc(item.id)}/draft`, { method: "POST" })
    .then(after(() => guideEvents.fixDrafted(item.type)));
}

/** The draft is in the page (accepted in the editor, or a new page made from it): in progress until published. */
export function fixApplied(siteId: string, id: string, pageId: string): Promise<FixItem> {
  return docsRequest<FixItem>(`/${enc(siteId)}/fixes/${enc(id)}/applied`, { method: "POST", json: { page_id: pageId } });
}
