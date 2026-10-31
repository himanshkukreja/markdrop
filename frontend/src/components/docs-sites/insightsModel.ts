/**
 * The pure half of the Insights tab (InsightsScreen.tsx): the words and tones its numbers get.
 * No imports, so node's type stripping can test it (insightsModel.test.mjs).
 */

export type Tone = "success" | "danger" | "warning" | "muted";

const fmt = (n: number): string => n.toLocaleString("en-US");

/** A page under this share of "helpful" votes is flagged. */
export const HELPFUL_FLOOR = 70;

/**
 * The change against the period before, for a KPI tile: "18% more than the previous 30 days".
 * null when there's nothing to compare with (no previous period, or nothing in it).
 * `points`: the value is a percentage, so the change is in points.
 */
export function change(value: number | null, prev: number | null | undefined, rangeWords: string, points = false):
  { dir: "up" | "down" | "flat"; text: string; tone: Tone } | null {
  if (value == null || prev == null || !Number.isFinite(value) || !Number.isFinite(prev)) return null;
  const vs = `vs previous ${rangeWords}`;
  let d: number;
  if (points) d = Math.round(value - prev);
  else if (prev === 0) return value > 0 ? { dir: "up", text: `New ${vs}`, tone: "success" } : null;
  else d = Math.round(((value - prev) / prev) * 100);
  if (d === 0) return { dir: "flat", text: `No change ${vs}`, tone: "muted" };
  return {
    dir: d > 0 ? "up" : "down",
    text: `${Math.abs(d)}${points ? " pts" : "%"} ${vs}`,
    tone: d > 0 ? "success" : "danger",
  };
}

/** A page's helpful share: red under the floor, green at or over it, muted without votes. */
export function helpfulTone(pct: number | null | undefined): Tone {
  if (pct == null) return "muted";
  return pct < HELPFUL_FLOOR ? "danger" : "success";
}

/** "41 searches, no results", "Ask AI had no answer · 12×", or both. */
export function missingNote(m: { searches: number; unanswered: number }): string {
  const bits: string[] = [];
  if (m.searches) bits.push(`${fmt(m.searches)} ${m.searches === 1 ? "search" : "searches"}, no results`);
  if (m.unanswered) bits.push(`Ask AI had no answer · ${fmt(m.unanswered)}×`);
  return bits.join(" · ");
}

/**
 * A page title from what a reader searched for or asked: trimmed, the question mark and quotes
 * dropped, the first letter capitalised, at most 120 characters (the New page dialog's limit).
 * "cancel subscription" → "Cancel subscription"; "Can I change the delivery date?" stays a
 * question without its "?" — the writer edits it in the dialog anyway.
 */
export function titleFromQuery(q: string): string {
  let t = (q || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  t = t.replace(/[?!.。？！\s]+$/u, "").trim();
  if (t.length > 120) t = t.slice(0, 120).replace(/\s+\S*$/, "").trim() || t.slice(0, 120);
  return t ? t.charAt(0).toLocaleUpperCase("en-US") + t.slice(1) : "";
}

/** The editor's address that opens the New page dialog with a title filled in. */
export function newPageHref(base: string, title: string): string {
  return `${base}?new=${encodeURIComponent(title)}`;
}

/** Width of a page's inline bar, as a share of the top page's views (never under 2%). */
export function barWidth(views: number, top: number): string {
  if (!top || views <= 0) return "0%";
  return `${Math.max(2, Math.round((views / top) * 100))}%`;
}
