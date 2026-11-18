/**
 * Small display helpers for the Deals section and a deal page (plain module, no React).
 */
import { relativeTime } from "@/components/dashboard/format";
import { fmtAmount, type DealCard } from "@/lib/hubspot";

/** "today", "yesterday", "3 days ago", then "Oct 3" — for a YYYY-MM-DD day or an ISO time. */
export function relDay(v: string | null | undefined, now = Date.now()): string {
  if (!v) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return relativeTime(v, now);
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const then = new Date(y, m - 1, d);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return days === 0 ? "today" : then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const sameYear = then.getFullYear() === today.getFullYear();
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "Jan 5" / "Jan 5, 2027" for a close date. */
export function shortDay(v: string | null | undefined): string {
  if (!v) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export const amountOf = (d: Pick<DealCard, "amount" | "currency">) => fmtAmount(d.amount, d.currency);

/** The quiet badge's words: "Quiet 21 days" / "No calls yet". */
export const quietLabel = (d: Pick<DealCard, "days_quiet" | "calls">) =>
  !d.calls || d.days_quiet == null ? "No calls yet" : `Quiet ${d.days_quiet} ${d.days_quiet === 1 ? "day" : "days"}`;

/** The sum of some deals' amounts, when they share one currency (else null). */
export function totalOf(deals: DealCard[]): string | null {
  const priced = deals.filter((d) => d.amount != null);
  if (!priced.length) return null;
  const cur = new Set(priced.map((d) => d.currency || "USD"));
  if (cur.size !== 1) return null;
  return fmtAmount(priced.reduce((a, d) => a + (d.amount ?? 0), 0), [...cur][0]!);
}

/** Bytes in words ("1.2 MB"). */
export function fmtSize(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "$1.1M" / "$107K" / "$950" for headers and column totals. */
export function compactAmount(amount: number | null | undefined, currency: string | null | undefined): string | null {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", notation: "compact", maximumFractionDigits: amount >= 1e6 ? 1 : 0 }).format(amount);
  } catch {
    return fmtAmount(amount, currency ?? null);
  }
}

/** A column's total, compact, when its deals share one currency (else null). */
export function compactTotal(deals: DealCard[]): string | null {
  const priced = deals.filter((d) => d.amount != null);
  if (!priced.length) return null;
  const cur = new Set(priced.map((d) => d.currency || "USD"));
  if (cur.size !== 1) return null;
  return compactAmount(priced.reduce((a, d) => a + (d.amount ?? 0), 0), [...cur][0]!);
}
