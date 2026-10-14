/**
 * Small display helpers shared by the dashboard list, the library and the analytics drawer.
 * Plain module (no React), so it can be unit-tested or reused anywhere.
 */
import type { MyDocListItem } from "@/lib/api";

/** API timestamps come back without a zone ("2026-10-13T17:54:32.661000") but are UTC. */
export function parseApiDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const RTF = typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl
  ? new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  : null;

/** "just now", "2 minutes ago", "yesterday", "3 days ago", then "Oct 3" (or "Oct 3, 2025"). */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  const d = parseApiDate(iso);
  if (!d) return "";
  const sec = Math.round((now - d.getTime()) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return RTF ? RTF.format(-min, "minute") : `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return RTF ? RTF.format(-hr, "hour") : `${hr} h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return RTF ? RTF.format(-day, "day") : `${day} days ago`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function fullDate(iso: string | null | undefined): string {
  const d = parseApiDate(iso);
  return d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

/** "Expires in 2 days" / "Expires in 6 hours" / "Expires in 12 minutes"; null when not expiring. */
export function expiresLabel(iso: string | null | undefined, now = Date.now()): string | null {
  const d = parseApiDate(iso);
  if (!d) return null;
  const ms = d.getTime() - now;
  if (ms <= 0) return "Expired";
  const min = Math.round(ms / 60000);
  if (min < 60) return `Expires in ${Math.max(1, min)} minute${min === 1 ? "" : "s"}`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `Expires in ${hr} hour${hr === 1 ? "" : "s"}`;
  const day = Math.round(hr / 24);
  return `Expires in ${day} days`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The first markdown heading of the preview, when the document has no stored title. */
function headingOf(preview: string | null | undefined): string | null {
  if (!preview) return null;
  const m = preview.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
  return m ? m[1]!.replace(/[*_`]/g, "").trim() || null : null;
}

/** What a row is called. E2E documents have no readable title, so they are named by their slug. */
export function displayTitle(d: MyDocListItem): string {
  if (d.encrypted) return d.slug;
  return d.title?.trim() || d.original_filename || headingOf(d.content_preview) || d.slug;
}

/** "markdrop.in/slug", or the workspace host with its folder path when there is one. */
export function addressOf(d: MyDocListItem, host?: string | null): { href: string; label: string; external: boolean } {
  if (host) {
    const path = [...(d.folder_path ?? []), d.slug].join("/");
    return { href: `https://${host}/${path}`, label: `${host}/${path}`, external: true };
  }
  let label = `markdrop.in/${d.slug}`;
  try {
    const u = new URL(d.url);
    label = `${u.host}${u.pathname}`;
  } catch {
    /* keep the default */
  }
  return { href: `/${d.slug}`, label, external: false };
}

/** "2m 14s", "45s", "—". */
export function readTime(s: number | null | undefined): string {
  if (!s) return "—";
  const r = Math.round(s);
  if (r < 60) return `${r}s`;
  return `${Math.floor(r / 60)}m ${String(r % 60).padStart(2, "0")}s`;
}

/** A slug the API accepts: 3–50 of [A-Za-z0-9_-]. */
export const SLUG_RE = /^[A-Za-z0-9_-]{3,50}$/;
