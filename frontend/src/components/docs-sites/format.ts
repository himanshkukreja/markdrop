/** Small formatting helpers shared by the docs-sites screens. */

/** "just now", "3 min ago", "2 hours ago", "yesterday", "Tue", "Oct 28", "Oct 28, 2025". */
export function timeAgo(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = new Date(t);
  const days = Math.floor((nowMs - t) / 86_400_000);
  if (days < 2) return "yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** "Tue 4:12 PM", "Oct 28" (older than a week). For history rows. */
export function whenShort(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = (nowMs - d.getTime()) / 86_400_000;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days < 1 && d.getDate() === new Date(nowMs).getDate()) return `Today ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "0 MB";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export const num = (n: number | null | undefined): string => (n ?? 0).toLocaleString("en-US");

export const plural = (n: number, one: string, many = `${one}s`): string => `${num(n)} ${n === 1 ? one : many}`;

export const firstName = (name: string | null | undefined): string => (name || "Someone").trim().split(/\s+/)[0]!;

/** "12.8:1" */
export const ratio = (r: number): string => `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;
