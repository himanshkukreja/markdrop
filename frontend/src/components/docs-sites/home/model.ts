/**
 * The Guides home's view of a guide (pure, no React): its state badge, which filter tabs it is in,
 * its last change, the one-line note a guide that isn't live gets, and search matching.
 */
import type { Tone } from "@/components/ui";
import { primaryAddress, type SiteSummary } from "@/lib/docsSites";
import { plural, timeAgo } from "../format";

export type GuideTab = "all" | "live" | "review" | "drafts";
export const GUIDE_TABS: Array<{ value: GuideTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "review", label: "In review" },
  { value: "drafts", label: "Drafts" },
];

const BUSY = new Set(["queued", "building", "publishing"]);

export const isLive = (s: SiteSummary): boolean => s.status === "live";
/** Never published (an unpublished guide was live once: it isn't a draft). */
export const isDraft = (s: SiteSummary): boolean => s.status === "draft";

export function inTab(s: SiteSummary, tab: GuideTab): boolean {
  if (tab === "live") return isLive(s);
  if (tab === "review") return s.in_review;
  if (tab === "drafts") return isDraft(s);
  return true;
}

export interface GuideState { label: string; tone: Tone; title?: string }

/** The card's badge: Building while a publish runs, In review, Failed (the newest publish), Live,
 * Unpublished, Draft. */
export function stateOf(s: SiteSummary): GuideState {
  if (s.build_status && BUSY.has(s.build_status)) return { label: "Building", tone: "info", title: "A publish is on its way" };
  if (s.in_review) return { label: "In review", tone: "warning", title: "Changes are waiting for a reviewer" };
  if (s.build_status === "failed") {
    return {
      label: "Failed",
      tone: "danger",
      title: isLive(s) ? "The last publish failed. Readers still see the one before it." : "The last publish failed.",
    };
  }
  if (isLive(s)) return { label: "Live", tone: "success" };
  if (s.status === "unpublished") return { label: "Unpublished", tone: "neutral", title: "Taken down: pages and history are kept" };
  return { label: "Draft", tone: "neutral", title: "Not published yet" };
}

const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() || 0 : 0);

/** "Published 2 hours ago", "Edited 20 min ago" (whichever is newer), else "Created …". */
export function lastChange(s: SiteSummary, nowMs: number = Date.now()): string {
  const published = ms(s.last_published_at);
  const edited = ms(s.last_edited_at);
  if (published && published >= edited) return `Published ${timeAgo(s.last_published_at, nowMs)}`;
  if (edited) return `Edited ${timeAgo(s.last_edited_at, nowMs)}`;
  return `Created ${timeAgo(s.created_at, nowMs)}`;
}

/** The newest of its publish, page save and settings change: the home's sort order. */
export const touched = (s: SiteSummary): number => Math.max(ms(s.last_published_at), ms(s.last_edited_at), ms(s.updated_at), ms(s.created_at));

/** The line a guide that isn't (only) live gets instead of its numbers. */
export function noteOf(s: SiteSummary): string | null {
  if (s.build_status && BUSY.has(s.build_status)) return "Publishing now";
  if (s.in_review) {
    const n = s.review_pages ?? 0;
    return n > 0 ? `${plural(n, "page")} waiting for a reviewer` : "Changes waiting for a reviewer";
  }
  if (s.build_status === "failed" && !isLive(s)) return "The last publish failed";
  if (s.status === "unpublished") return "Unpublished. Pages and history are kept";
  if (isDraft(s)) return "Not published yet";
  return null;
}

/** Where readers find it: a live own domain, else the free address. */
export const addressOf = (s: SiteSummary): string => primaryAddress(s);

/** Search over name and addresses (the free one and own domains), case- and accent-insensitive. */
export function matches(s: SiteSummary, q: string): boolean {
  const norm = (v: string) => v.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const needle = norm(q.trim());
  if (!needle) return true;
  const hay = [s.name, s.slug, addressOf(s), ...(s.domains ?? []).map((d) => d.host)].filter(Boolean).map((v) => norm(String(v)));
  return hay.some((h) => h.includes(needle));
}
