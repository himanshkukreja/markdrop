"use client";

import { createContext, useContext } from "react";

/**
 * Small pieces every admin page shares: the page head, the date/size formatters, the URL state
 * helpers (read after mount, never useSearchParams) and the "your session ended" hook.
 */

// ── Config (D30) ──────────────────────────────────────────────────────────────

/**
 * Relay pricing, shown under the relayed-data meter in Product health. Kept here as config rather
 * than in the chart code so a plan change is a one-line edit (REVAMP D30).
 */
export const RELAY_PRICING = {
  provider: "Cloudflare",
  /** Free relayed data per month, in GB. The meter's max. */
  freeGbPerMonth: 1000,
  overage: "$0.05/GB",
  /** Fraction of the free allowance at which the meter turns warning. */
  warnAt: 0.8,
} as const;

export const relayPricingCopy = () =>
  `${RELAY_PRICING.provider}: ${RELAY_PRICING.freeGbPerMonth.toLocaleString("en")} GB a month free, then ${RELAY_PRICING.overage}`;

// ── Sections and URL state ────────────────────────────────────────────────────

export type Section = "overview" | "health" | "journeys" | "documents" | "reports" | "users" | "feedback" | "email";
export const SECTIONS: Section[] = ["overview", "health", "journeys", "documents", "reports", "users", "feedback", "email"];

/** Old tab names (bookmarks from before the rail) map onto the new sections. */
const ALIASES: Record<string, Section> = { analytics: "overview", docs: "documents", usage: "health" };

export function sectionFrom(v: string | null): Section {
  if (!v) return "overview";
  if ((SECTIONS as string[]).includes(v)) return v as Section;
  return ALIASES[v] ?? "overview";
}

/** The admin query string, read on the client only (call it in effects and handlers). */
export function readQuery(): URLSearchParams {
  return new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
}

/**
 * Merge `patch` into the query string. `null`/"" removes a key. `push` adds a history entry (tab
 * changes, so Back works); otherwise the entry is replaced (range and filter tweaks).
 * The fragment is kept as it is.
 */
export function writeQuery(patch: Record<string, string | null | undefined>, push = false) {
  if (typeof window === "undefined") return;
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  const url = `${window.location.pathname}${s ? `?${s}` : ""}${window.location.hash}`;
  if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  if (push) window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

// ── Session ───────────────────────────────────────────────────────────────────

/** Called by any admin request that comes back 401: clears the token and shows the sign-in card. */
export const UnauthorizedContext = createContext<() => void>(() => {});
export const useOnUnauthorized = () => useContext(UnauthorizedContext);

export function isUnauthorized(e: unknown) {
  return e instanceof Error && e.message === "UNAUTHORIZED";
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function fmtDate(iso: string | null | undefined, withYear = true) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
}

export function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function bytes(n: number) {
  if (n >= 2 ** 40) return `${(n / 2 ** 40).toFixed(2)} TB`;
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`;
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(n >= 10 * 2 ** 20 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** "Expires in 2 days" / "Expired" / "Never", for the documents table and drawer. */
export function expiryLabel(iso: string | null): { text: string; tone: "neutral" | "warning" | "danger" } {
  if (!iso) return { text: "Never", tone: "neutral" };
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: "Expired", tone: "danger" };
  const h = ms / 3_600_000;
  if (h < 1) return { text: "Expires within the hour", tone: "warning" };
  if (h < 24) return { text: `Expires in ${Math.round(h)} h`, tone: "warning" };
  const d = Math.round(h / 24);
  return { text: `Expires in ${d} day${d === 1 ? "" : "s"}`, tone: d <= 3 ? "warning" : "neutral" };
}

// ── Page head ─────────────────────────────────────────────────────────────────

/** Each admin page starts with its h1, a caption and (at most) one primary action. */
export function PageHead({ title, caption, actions }: { title: React.ReactNode; caption?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-h1 text-text">{title}</h1>
        {caption && <p className="mt-1 text-body text-text-secondary">{caption}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

// ── People and files ──────────────────────────────────────────────────────────

/** A decorative avatar beside a visible name. Google pictures load without a referrer. */
export function PersonAvatar({ name, src, size = "sm" }: { name: string; src?: string | null; size?: "sm" | "md" }) {
  const initials = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  return (
    <span aria-hidden className={`md-avatar md-avatar--${size} shrink-0`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" referrerPolicy="no-referrer" />
      ) : initials}
    </span>
  );
}

type FileRendererName = "pdf" | "sheet" | "docx" | "text" | "video" | "html" | "image" | "zip";
/** Artifact renderer → the DS FileIcon renderer ("bundle" is a zipped site). */
export function iconRenderer(r: string | null | undefined): FileRendererName | undefined {
  if (!r) return undefined;
  if (r === "bundle") return "zip";
  return (["pdf", "sheet", "docx", "text", "video", "html", "image"] as const).find((x) => x === r);
}
