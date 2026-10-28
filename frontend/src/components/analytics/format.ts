/**
 * Number and label formatting for the analytics pages. House style: 2,418 · 312 h · 64% · 1.2 s ·
 * 3 min 40 s · 2:14 (positions in a video). Plain module, no React.
 */
import { parseApiDate } from "@/components/dashboard/format";
import type { AnalyticsRange, Kpi, TrackKind } from "@/lib/analytics";

export const num = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US"));

/** 64% · 0.6% · <0.1% */
export function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.1) return "<0.1%";
  if (n > 0 && n < 10 && Math.round(n) !== n && Math.abs(n - Math.round(n)) >= 0.05) return `${n.toFixed(1)}%`;
  return `${Math.round(n)}%`;
}

/** 1.2 s · 48 s · 3 min 40 s · 2 h 5 min */
export function secs(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 10 && Math.round(s) !== s) return `${s.toFixed(1)} s`;
  const r = Math.round(s);
  if (r < 60) return `${r} s`;
  if (r < 3600) {
    const m = Math.floor(r / 60), x = r % 60;
    return x ? `${m} min ${x} s` : `${m} min`;
  }
  const h = Math.floor(r / 3600), m = Math.round((r % 3600) / 60);
  // Past ten hours the minutes are noise: "312 h".
  if (h >= 10) return `${num(Math.round(r / 3600))} h`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const ms = (v: number | null | undefined) => (v == null ? "—" : secs(v / 1000));

/** 312 h · 4.5 h */
export function hours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return "—";
  return h < 10 && Math.round(h) !== h ? `${h.toFixed(1)} h` : `${num(h)} h`;
}

/** A position in a video: 0:42 · 2:14 · 1:02:03 */
export function clock(t: number): string {
  const r = Math.max(0, Math.round(t));
  const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function kpiValue(k: Pick<Kpi, "value" | "unit">): string {
  switch (k.unit) {
    case "percent": return pct(k.value);
    case "seconds": return secs(k.value);
    case "hours": return hours(k.value);
    default: return num(k.value);
  }
}

export const RANGE_WORDS: Record<AnalyticsRange, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "all time" };

/** "+12% vs previous 30 days" (null without a previous window). */
export function kpiDelta(k: Kpi, range: AnalyticsRange): { text: string; dir: "up" | "down" | "flat" } | null {
  if (range === "all" || k.prev == null || !Number.isFinite(k.prev)) return null;
  const vs = `vs previous ${RANGE_WORDS[range]}`;
  if (k.unit === "percent") {
    const d = Math.round(k.value - k.prev);
    return { text: d === 0 ? `No change ${vs}` : `${d > 0 ? "+" : "−"}${Math.abs(d)} pts ${vs}`, dir: d > 0 ? "up" : d < 0 ? "down" : "flat" };
  }
  if (k.prev === 0) return k.value > 0 ? { text: `New ${vs}`, dir: "up" } : null;
  const d = Math.round(((k.value - k.prev) / k.prev) * 100);
  return { text: d === 0 ? `No change ${vs}` : `${d > 0 ? "+" : "−"}${Math.abs(d)}% ${vs}`, dir: d > 0 ? "up" : d < 0 ? "down" : "flat" };
}

const utcDay = (iso: string) => parseApiDate(iso.length === 10 ? `${iso}T00:00:00` : iso);

/** Oct 21 */
export function day(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = utcDay(iso);
  return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : iso;
}
/** Tue, Oct 21 */
export function longDay(iso: string): string {
  const d = utcDay(iso);
  return d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : iso;
}

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  if (!/^[A-Z]{2}$/i.test(code)) return code;
  try {
    regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
/** "the US", "Germany": for sentences like "someone in the US". */
export function countryInSentence(code: string | null | undefined): string {
  const c = (code || "").toUpperCase();
  if (c === "US") return "the US";
  if (c === "GB") return "the UK";
  if (c === "AE") return "the UAE";
  if (c === "NL") return "the Netherlands";
  return countryName(code);
}

export function channelLabel(c: string | null | undefined): string {
  if (!c || c === "Direct") return "Direct or bookmarked";
  return c;
}
export function deviceLabel(d: string | null | undefined): string {
  if (d === "Mobile" || d === "Phone") return "Phone";
  return d || "Unknown";
}
export function deviceInSentence(d: string | null | undefined): string {
  if (d === "Mobile" || d === "Phone") return "on a phone";
  if (d === "Tablet") return "on a tablet";
  if (d === "Desktop") return "on a computer";
  return "";
}

/** "user-content-install-the-sdk" → "Install the sdk" (when the markdown isn't available). */
export function prettyHeadingId(id: string): string {
  const s = id.replace(/^user-content-/, "").replace(/-\d+$/, "").replace(/-/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Top of the page";
}

/** What "engaged" means for this kind, as a short past-tense phrase ("72% watched"). */
export function engagedWord(kind: TrackKind): string {
  switch (kind) {
    case "video": return "watched";
    case "audio": return "listened";
    case "doc": return "read it all";
    case "pdf": return "reached the end";
    default: return "engaged";
  }
}

export const KIND_WORD: Record<TrackKind, string> = { doc: "Document", pdf: "PDF", video: "Video", audio: "Audio", other: "File" };

/** A document's analytics page. */
export function docHref(slug: string, tab?: string | null): string {
  const t = tab && tab !== "overview" ? `tab=${encodeURIComponent(tab)}` : "";
  return `/dashboard/analytics/${encodeURIComponent(slug)}${t ? `?${t}` : ""}`;
}

/** The PDF viewer shows (and so reports) at most this many pages (worker/src/index.js LIMIT). */
export const PDF_VIEWER_PAGES = 50;

/** "12 pages", or "50+ pages" when the file is longer than the viewer shows. */
export function pagesLabel(n: number): string {
  if (n >= PDF_VIEWER_PAGES) return `${PDF_VIEWER_PAGES}+ pages`;
  return `${num(n)} ${n === 1 ? "page" : "pages"}`;
}
