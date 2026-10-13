/**
 * Hash-safe in-page navigation (REVAMP_PLAN 7.6, §10.3 "Fragments", smoke test 8).
 *
 * The fragment carries secrets: `#k=` (the E2E key), `#mdt=` (a private-doc handoff token) and
 * `#token=` (a tenant session handoff). A plain `<a href="#x">` replaces `location.hash`, so one
 * click on an encrypted document would wipe the key from the address bar. Every in-document jump
 * (Toc, TocTicks, heading anchors, `#links` inside the markdown) goes through this module instead:
 * it scrolls with `scrollIntoView` and only writes the hash with `history.replaceState` when the
 * current hash contains none of `k=`, `mdt=`, `token=`, and never on an encrypted document.
 */

import { HEADING_ID_PREFIX } from "./slug";

export const SENSITIVE_HASH_KEYS = ["k=", "mdt=", "token="] as const;

/** True when the hash holds a key or token (or anything that looks like one). */
export function isHashSensitive(hash?: string): boolean {
  const h = hash ?? (typeof location === "undefined" ? "" : location.hash);
  return SENSITIVE_HASH_KEYS.some((k) => h.includes(k));
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The element an in-document reference points at. Accepts "#x", "x" or a full id. Tries the id as
 * written, then with the sanitizer's `user-content-` prefix (author ids and GFM footnotes get it
 * added once more by rehype-sanitize, which is why `#user-content-fn-1` lives at
 * `user-content-user-content-fn-1`).
 */
export function findHeadingTarget(ref: string, doc: Document = document): HTMLElement | null {
  const id = decode(ref.replace(/^#/, ""));
  if (!id) return null;
  return doc.getElementById(id) ?? doc.getElementById(HEADING_ID_PREFIX + id);
}

/** "user-content-intro" → "intro" (the part that goes after # in a shared link). */
export function sectionFragment(id: string): string {
  return id.startsWith(HEADING_ID_PREFIX) ? id.slice(HEADING_ID_PREFIX.length) : id;
}

/**
 * The shareable address of a section: `<base>#<slug>`. `base` defaults to origin + pathname, so
 * query flags (`?new=1`) and any fragment secret are never part of it.
 */
export function sectionUrl(id: string, base?: string): string {
  const b = base ?? (typeof location === "undefined" ? "" : location.origin + location.pathname);
  return `${b.replace(/#.*$/, "")}#${encodeURIComponent(sectionFragment(id))}`;
}

export interface HashWriteOptions {
  /** Encrypted (E2E) document: the hash is never touched, whatever it holds. */
  encrypted?: boolean;
}

/** Points the address bar at a section, when that is safe. Returns whether it wrote. */
export function setSectionHash(id: string, { encrypted }: HashWriteOptions = {}): boolean {
  if (encrypted || typeof history === "undefined" || isHashSensitive()) return false;
  const frag = `#${encodeURIComponent(sectionFragment(id))}`;
  if (location.hash === frag) return false;
  try {
    // Keep history.state: the App Router stores its tree there.
    history.replaceState(history.state, "", location.pathname + location.search + frag);
    return true;
  } catch {
    return false;
  }
}

export interface NavigateOptions extends HashWriteOptions {
  /** Write the section into the address bar when safe (default true). */
  updateHash?: boolean;
  /** Move keyboard focus to the target (default true), without a second scroll. */
  focus?: boolean;
  behavior?: ScrollBehavior;
}

/**
 * Scrolls to a heading (or any in-document target) without a navigation. Returns false when the
 * target doesn't exist, so callers can decide what to do instead (never "let the browser do it"
 * on a document whose hash is sensitive).
 */
export function navigateToHeading(ref: string, opts: NavigateOptions = {}): boolean {
  if (typeof document === "undefined") return false;
  const el = findHeadingTarget(ref);
  if (!el) return false;
  const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: opts.behavior ?? (reduce ? "auto" : "smooth"), block: "start" });
  if (opts.focus !== false) {
    if (!el.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }
  if (opts.updateHash !== false) setSectionHash(el.id, opts);
  return true;
}

/**
 * On load, a shared section link (`/slug#intro`) can't scroll natively because the heading's id is
 * `user-content-intro`. Scroll to it once the content is in the DOM. Never runs for a sensitive
 * hash, and never writes the hash.
 */
export function scrollToInitialHash(): boolean {
  if (typeof location === "undefined") return false;
  const raw = location.hash.slice(1);
  if (!raw || raw.includes("=") || isHashSensitive()) return false;
  if (document.getElementById(decode(raw))) return false; // the browser already handled it
  const el = findHeadingTarget(raw);
  if (!el) return false;
  el.scrollIntoView({ block: "start" });
  return true;
}
