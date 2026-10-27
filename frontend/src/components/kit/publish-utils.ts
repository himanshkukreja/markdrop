/**
 * Shared types and helpers for the K3 forms & publish kit (PublishSettings, DateTimePicker,
 * PublishedPanel, OtpInput, Combobox). No UI and no "use client": the pure functions can be called
 * from server and client code alike; the two hooks are only usable from client components.
 *
 * Dates are formatted on the client only (the server's locale and timezone are not the reader's),
 * so every caller gates date text on `useIsClient()`.
 */
import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/** false on the server and during hydration, true after. */
export function useIsClient(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** A media query as state. The server (and hydration) snapshot is `serverValue`. */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue,
  );
}

/** Phones: settings panels become bottom sheets below this width. */
export const PHONE_QUERY = "(max-width: 639px)";

/* ── The publish settings value ────────────────────────────────────────── */

/** "workspace" needs a workspace Location; Location and access are otherwise independent (P4). */
export type PublishAccess = "link" | "private" | "workspace";

/**
 * The access level the create call takes. "Everyone in the workspace" can only be set once the
 * document is in the workspace, so it is created private and opened up by the filing call; a
 * filing failure then leaves it private, never public.
 */
export function createAccess(access: PublishAccess): "private" | "link" {
  return access === "workspace" ? "private" : access;
}

export interface PublishTarget {
  /** null = Personal (not in a workspace). */
  workspaceId: string | null;
  folderId: string | null;
}

export type ExpiryPreset = "never" | "1d" | "7d" | "30d";
/** A preset, or an exact moment (`at` is an ISO 8601 string, e.g. from `Date.toISOString()`). */
export type PublishExpiry = ExpiryPreset | { at: string };

export interface PublishSettingsValue {
  access: PublishAccess;
  encrypt: boolean;
  /** null (or "") = no password. */
  password: string | null;
  expires: PublishExpiry;
  /** The custom slug as typed; "" = a short random link. */
  slug: string;
  target: PublishTarget;
}
export type PublishField = keyof PublishSettingsValue;

export const DEFAULT_PUBLISH_SETTINGS: PublishSettingsValue = {
  access: "link",
  encrypt: false,
  password: null,
  expires: "never",
  slug: "",
  target: { workspaceId: null, folderId: null },
};

/** A workspace someone may publish into (members and above), with the folders of the chosen one. */
export interface PublishWorkspace {
  id: string;
  name: string;
  /** The verified document host, e.g. "docs.acme.com"; null/absent = markdrop.in. */
  host?: string | null;
  /** Folders, when loaded. `path` is the URL path from the root (`["specs", "q3"]`); `label` is the
   *  names from the root ("Specs › Q3") when known. */
  folders?: Array<{ id: string; name: string; path?: string[]; label?: string }>;
  /** Who can open what's published here unless the author chooses otherwise. */
  defaultAccess?: PublishAccess | null;
}

/* ── Expiry ────────────────────────────────────────────────────────────── */

export const EXPIRY_DAYS: Record<Exclude<ExpiryPreset, "never">, number> = { "1d": 1, "7d": 7, "30d": 30 };

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The moment a value expires, relative to `now`; null for "never" or an unparsable date. */
export function expiryDate(expires: PublishExpiry, now: Date = new Date()): Date | null {
  if (expires === "never") return null;
  if (typeof expires === "string") return new Date(now.getTime() + EXPIRY_DAYS[expires] * DAY);
  const d = new Date(expires.at);
  return isNaN(d.getTime()) ? null : d;
}

/** "in 7 days", "in 5 hours", "in under an hour"; null when the moment has passed. */
export function relativeFromNow(target: Date, now: Date = new Date()): string | null {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return null;
  if (ms < HOUR) return "in under an hour";
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(ms / DAY);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

export function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
export function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
export function formatMoment(d: Date): string {
  return `${formatDay(d)} at ${formatTime(d)}`;
}

/**
 * The live hint under an expiry control (client only: it formats dates in the reader's zone).
 * `error` is set when an exact date is missing or in the past.
 */
export function expiryHint(expires: PublishExpiry, now: Date = new Date()): { text: string; error?: boolean } {
  if (expires === "never") return { text: "Stays up until you delete it." };
  const d = expiryDate(expires, now);
  if (!d) return { text: "Pick a date and a time.", error: true };
  const rel = relativeFromNow(d, now);
  if (!rel) return { text: "That time has passed. Pick one in the future.", error: true };
  const when = typeof expires === "string" ? formatDay(d) : formatMoment(d);
  return { text: `Expires ${rel}, on ${when}. The link stops working then.` };
}

/** True when an exact expiry is unusable (unparsable or not in the future). Presets are always valid. */
export function expiryInvalid(expires: PublishExpiry, now: Date = new Date()): boolean {
  if (typeof expires === "string") return false;
  const d = expiryDate(expires, now);
  return !d || d.getTime() <= now.getTime();
}

/** The chip label: "Never expires", "Expires in 7 days", "Expires Thu, Oct 16". */
export function expiryChipLabel(expires: PublishExpiry, isClient: boolean): string {
  if (expires === "never") return "Never expires";
  if (typeof expires === "string") {
    const n = EXPIRY_DAYS[expires];
    return `Expires in ${n} day${n === 1 ? "" : "s"}`;
  }
  if (!isClient) return "Expires on a date";
  const d = expiryDate(expires);
  return d ? `Expires ${formatDay(d)}` : "Expires on a date";
}

/**
 * The API shape the existing endpoints take (`lib/api.ts` ExpiresIn + customExpiresAt), so surfaces
 * don't each re-derive it.
 */
export function toApiExpiry(expires: PublishExpiry): { expiresIn: ExpiryPreset | "custom"; customExpiresAt?: string } {
  if (typeof expires === "string") return { expiresIn: expires };
  const d = new Date(expires.at);
  return { expiresIn: "custom", customExpiresAt: isNaN(d.getTime()) ? expires.at : d.toISOString() };
}

/** Tomorrow at 12:00 local time: the default when someone picks "On a date…". */
export function defaultExpiryMoment(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(12, 0, 0, 0);
  return d;
}

/* ── Summaries ─────────────────────────────────────────────────────────── */

export interface PublishSummaryOptions {
  /** Pass `useIsClient()`: exact expiry dates are only formatted on the client. */
  isClient?: boolean;
  /** Include "Encrypted" (default true). Pass false where encryption isn't offered (artifacts). */
  showEncrypt?: boolean;
  /** Name of the chosen workspace; it leads the secondary line ("Acme Docs · Never expires"). */
  workspaceName?: string | null;
}

/**
 * The publish settings in words, for the phone's sticky bar: `primary` is who can open it,
 * `secondary` the rest ("Encrypted · Password · Expires in 7 days"), `text` both joined with " · "
 * ("Anyone with the link · Never expires"), and `changed` whether anything differs from the
 * defaults (the settings IconButton shows a dot then).
 */
export function publishSummary(value: PublishSettingsValue, opts: PublishSummaryOptions = {}): { primary: string; secondary: string; text: string; changed: boolean } {
  const { isClient = false, showEncrypt = true, workspaceName } = opts;
  const primary = value.access === "private" ? "Only me"
    : value.access === "workspace" ? `Everyone in ${workspaceName || "the workspace"}`
    : "Anyone with the link";
  const parts: string[] = [];
  if (workspaceName && value.target.workspaceId) parts.push(workspaceName);
  if (showEncrypt && value.encrypt) parts.push("Encrypted");
  if (value.password) parts.push("Password");
  parts.push(expiryChipLabel(value.expires, isClient));
  const secondary = parts.join(" · ");
  return { primary, secondary, text: `${primary} · ${secondary}`, changed: publishSettingsChanged(value, showEncrypt) };
}

/** The one-line caption: "Anyone with the link · Never expires". */
export function summarizePublishSettings(value: PublishSettingsValue, opts?: PublishSummaryOptions): string {
  return publishSummary(value, opts).text;
}

/** Anything non-default (drives the "some changed" dot on the phone's settings button). */
export function publishSettingsChanged(value: PublishSettingsValue, countEncrypt = true): boolean {
  return value.access !== "link" || (countEncrypt && value.encrypt) || !!value.password || value.expires !== "never" || !!value.slug.trim() || !!value.target.workspaceId;
}

/* ── Misc ──────────────────────────────────────────────────────────────── */

/** A loose but honest email check: something@something.tld, no spaces. */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(s.trim());
}

/** Split a share URL into what's sent to a server and the fragment (which never is). */
export function splitFragment(url: string): { base: string; fragment: string } {
  const i = url.indexOf("#");
  return i < 0 ? { base: url, fragment: "" } : { base: url.slice(0, i), fragment: url.slice(i) };
}

/**
 * A URL as LinkPill parts: `host` ("markdrop.in"), `slug` (the path without its leading slash,
 * folders included) and `fragment` ("#k=…", or ""). Falls back to treating the string as a path.
 */
export function linkParts(url: string): { host: string; slug: string; fragment: string } {
  const { base, fragment } = splitFragment(url);
  try {
    const u = new URL(base);
    return { host: u.host, slug: (u.pathname + u.search).replace(/^\/+/, ""), fragment };
  } catch {
    const m = /^(?:[a-z]+:\/\/)?([^/]+)\/?(.*)$/i.exec(base);
    return { host: m?.[1] ?? "", slug: m?.[2] ?? "", fragment };
  }
}

/**
 * The text before the slug input: "markdrop.in/", or a workspace host plus folder path. Long
 * prefixes keep the host and the last folder ("docs.acme.com/…/q3/") so the input keeps its room.
 */
export function slugPrefix(host: string, folderPath: string[] = [], max = 30): string {
  const h = host.replace(/\/+$/, "");
  const full = [h, ...folderPath].join("/") + "/";
  if (full.length <= max || folderPath.length < 2) return full;
  return `${h}/…/${folderPath[folderPath.length - 1]}/`;
}
