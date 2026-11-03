/**
 * The sign-in handoff fragment (`#mdt=<token>`), read safely. Browser only.
 *
 * A `#mdt=` fragment is attacker-controllable — anyone can send a link carrying one — so taking
 * it at face value let a link swap the reader's markdrop.in session for someone else's (login
 * CSRF). A fragment token is accepted only when ALL hold:
 *
 *   - this page is on a customer's domain (never on markdrop.in, where the real session lives
 *     and nothing is ever handed over by fragment);
 *   - the token is a tenant token (`typ === "tenant"`), not a full session;
 *   - it was minted for exactly this host (`host === location.hostname`).
 *
 * The API enforces the same thing from its side (a tenant token is refused unless the request's
 * Origin is the host it names), so a token that slipped past here would still be useless.
 */

import { HANDOFF_FRAGMENT, silentSignInUrl } from "@/lib/hosts";
import {
  TENANT_TOKEN_MARGIN_MS,
  silentAttemptDue,
  silentHandoffKey,
  tenantTokenUsable,
} from "@/lib/silentHandoffCore";
import { isPrimaryHost, normalizeHost } from "./hosts";

const MARKER = `#${HANDOFF_FRAGMENT}=`;
const TOKEN_KEY = "markdrop_token";

/** Whether `token` is a tenant token for `host` (claims only; the API checks the signature). */
export function isTenantTokenFor(token: string, host: string): boolean {
  const h = normalizeHost(host);
  if (!h || isPrimaryHost(h)) return false;
  return tenantTokenUsable(token, h, Date.now());
}

/** The fragment's token if it is acceptable here, without consuming it. */
export function peekHandoffToken(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (!hash.startsWith(MARKER)) return null;
  let token = "";
  try {
    token = decodeURIComponent(hash.slice(MARKER.length));
  } catch {
    return null;
  }
  return token && isTenantTokenFor(token, window.location.hostname) ? token : null;
}

/**
 * Take the handoff from the address bar: store an acceptable token as this origin's session and
 * strip the fragment either way (a credential must not sit in a URL people copy). Returns the
 * stored token, null when there was none or it was refused.
 */
export function consumeHandoffToken(): string | null {
  if (typeof window === "undefined" || !window.location.hash.startsWith(MARKER)) return null;
  const token = peekHandoffToken();
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage blocked: stay signed out */
  }
  history.replaceState(history.state, "", window.location.pathname + window.location.search);
  return token;
}

/**
 * The session this page may read with, or null. On markdrop.in that is simply the stored token. On a
 * workspace's own domain it is only a tenant token minted for this host that has not expired (with a
 * minute to spare); anything else there is removed first. A dead token is worse than none: it reads
 * as "signed in", so the page skipped the silent check, sent it, was answered as a stranger and
 * showed "Sign in" to a reader who was signed in on markdrop.in the whole time.
 */
export function usableSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  let token: string | null = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
  if (!token) return null;
  const host = normalizeHost(window.location.hostname);
  if (isPrimaryHost(host)) return token;
  if (tenantTokenUsable(token, host, Date.now(), TENANT_TOKEN_MARGIN_MS)) return token;
  forgetSessionToken();
  return null;
}

/** Drop this origin's stored session (a stale one, or one the API just refused). */
export function forgetSessionToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: nothing is stored either */
  }
}

/**
 * Ask markdrop.in, without showing anything, whether the reader is signed in there: a top-level
 * navigation to its handoff (`signInUrl` + silent=1), which comes straight back to this address with
 * `#mdt=<token>` or `#mdt-none=1`. Returns true when that navigation has started (the caller keeps
 * showing "Opening…"), false when it is not due and the caller shows its gate.
 *
 * Loop guard: one attempt per page per `SILENT_HANDOFF_WINDOW_MS`, stamped in sessionStorage before
 * leaving (lib/silentHandoffCore). Only on a workspace's own domain, and only to the handoff URL the
 * page was rendered with (`signInUrlFor`: markdrop.in's own host, never one read from the address
 * bar). Nothing secret goes out: the request names the host and this path, and the token comes back
 * on the fragment, which no server, log or Referer sees.
 */
export function startSilentHandoff(signInUrl: string | null | undefined): boolean {
  if (typeof window === "undefined" || !signInUrl) return false;
  if (isPrimaryHost(normalizeHost(window.location.hostname))) return false;
  const key = silentHandoffKey(window.location.host, window.location.pathname);
  try {
    if (!silentAttemptDue(sessionStorage.getItem(key), Date.now())) return false;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return false; // storage blocked: a loop can't be told from a first try, so never start one
  }
  window.location.replace(silentSignInUrl(signInUrl));
  return true;
}
