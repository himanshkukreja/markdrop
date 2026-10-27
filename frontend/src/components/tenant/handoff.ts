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

import { HANDOFF_FRAGMENT } from "@/lib/hosts";
import { isPrimaryHost, normalizeHost } from "./hosts";

const MARKER = `#${HANDOFF_FRAGMENT}=`;

function payloadOf(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const data = JSON.parse(json);
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether `token` is a tenant token for `host` (claims only; the API checks the signature). */
export function isTenantTokenFor(token: string, host: string): boolean {
  const p = payloadOf(token);
  if (!p || p.typ !== "tenant" || typeof p.host !== "string") return false;
  const h = normalizeHost(host);
  if (!h || isPrimaryHost(h)) return false;
  if (normalizeHost(p.host) !== h) return false;
  return typeof p.exp !== "number" || p.exp * 1000 > Date.now();
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
    if (token) localStorage.setItem("markdrop_token", token);
  } catch {
    /* storage blocked: stay signed out */
  }
  history.replaceState(history.state, "", window.location.pathname + window.location.search);
  return token;
}
