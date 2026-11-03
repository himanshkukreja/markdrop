/**
 * The rules behind the silent sign-in check on a workspace's own domain, as plain functions (no
 * imports, no browser globals), so they can be unit tested. The browser glue is
 * components/tenant/handoff.ts.
 *
 * A gated page on a custom domain cannot see the reader's markdrop.in session (storage is per
 * origin), so before showing "Sign in" it asks markdrop.in quietly: a top-level round trip to
 * /auth/handoff?silent=1 that comes straight back with a tenant token, or with "nothing to hand
 * over". Two things decide whether that round trip happens:
 *
 *   1. Is there already a session *for this host* worth using? A tenant token lives 12 hours; one
 *      that has expired (or is about to) is not a session, and treating it as one skipped the
 *      check, sent the dead token, and showed the gate to a reader who was signed in all along.
 *   2. Was the check tried for this page a moment ago? That is the loop guard: the round trip is a
 *      navigation, so "once per page load" has to survive it. A short window, not a flag kept for
 *      the life of the tab: a flag let one early "not signed in" (or a token that expired hours
 *      later) pin the gate on that page until the tab was closed.
 */

/** How long one silent attempt for a page blocks the next. Long enough to cover the round trip
 *  (and a reload right after it), short enough that a reader who signed in since is let in. */
export const SILENT_HANDOFF_WINDOW_MS = 2 * 60 * 1000;

/** A tenant token this close to its expiry is treated as already expired: a read that starts with
 *  it could be refused by the time it lands. */
export const TENANT_TOKEN_MARGIN_MS = 60 * 1000;

/** The JWT's claims, unverified (the API checks the signature). Null when unreadable. */
export function tokenClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const data = JSON.parse(json);
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `token` is a tenant token minted for `host` (already normalised: lowercase, no port,
 * no trailing dot) that is still good at `nowMs` with `marginMs` to spare.
 */
export function tenantTokenUsable(token: string, host: string, nowMs: number, marginMs = 0): boolean {
  const p = tokenClaims(token);
  if (!p || p.typ !== "tenant" || typeof p.host !== "string" || !host) return false;
  const claimed = p.host.trim().toLowerCase().replace(/\.+$/, "");
  if (claimed !== host) return false;
  // `exp` is required: a tenant token always carries one, and one without it is not ours.
  return typeof p.exp === "number" && p.exp * 1000 > nowMs + marginMs;
}

/** The sessionStorage key of the attempt marker for one page of one host. */
export function silentHandoffKey(host: string, pathname: string): string {
  return `md_silent_handoff:${host}${pathname}`;
}

/**
 * Whether a silent attempt is due, given the marker stored for this page (`null` = none).
 * The marker is the time of the last attempt in ms; anything unreadable (including the "1" an
 * older version kept for the life of the tab) counts as long ago.
 */
export function silentAttemptDue(stored: string | null, nowMs: number, windowMs = SILENT_HANDOFF_WINDOW_MS): boolean {
  if (!stored) return true;
  const at = Number(stored);
  if (!Number.isFinite(at) || at < 1e12) return true; // not a ms timestamp: the old flag, or junk
  // A marker from the future (the clock moved back) blocks only until the window has passed.
  return Math.abs(nowMs - at) >= windowMs;
}
