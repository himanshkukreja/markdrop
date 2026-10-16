/**
 * Analytics consent for the third-party tools (PostHog, Google Analytics; lib/thirdPartyAnalytics).
 * Our own first-party analytics (lib/track) set no cookies and are unaffected.
 *
 * - Visitors in the EU, EEA, UK or Switzerland (app/api/geo) are asked. Until they accept, PostHog
 *   counts them without cookies or storage and records nothing, and Google Analytics doesn't load.
 * - A browser sending Global Privacy Control or Do Not Track is treated as having declined, without
 *   a prompt. Anyone can change their choice later from the footer's "Privacy choices".
 * - Everyone else gets full analytics; the privacy page explains it and offers the same opt-out.
 *
 * The choice is kept in localStorage `md_consent` ("granted" | "denied").
 */
export type Consent = "granted" | "denied";
/** full: cookies, session replay, GA. limited: cookieless PostHog only. */
export type AnalyticsMode = "full" | "limited";

const KEY = "md_consent";
const GEO_KEY = "md_geo";
export const CONSENT_EVENT = "md-consent";
export const CONSENT_OPEN_EVENT = "md-consent-open";

function ls(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getConsent(): Consent | null {
  const v = ls()?.getItem(KEY);
  return v === "granted" || v === "denied" ? v : null;
}

export function setConsent(v: Consent) {
  try {
    ls()?.setItem(KEY, v);
  } catch {
    /* blocked storage: the choice holds for this page only */
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: v }));
}

/** Footer "Privacy choices": show the prompt again, whatever the region. */
export function openPrivacyChoices() {
  window.dispatchEvent(new Event(CONSENT_OPEN_EVENT));
}

export function privacySignal(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || navigator.doNotTrack === "1";
}

async function consentRequired(): Promise<boolean> {
  try {
    const cached = window.sessionStorage.getItem(GEO_KEY);
    if (cached === "1" || cached === "0") return cached === "1";
  } catch {
    /* fall through to the network */
  }
  try {
    const res = await fetch("/api/geo", { cache: "no-store" });
    const { consentRequired: required } = (await res.json()) as { consentRequired: boolean };
    try {
      window.sessionStorage.setItem(GEO_KEY, required ? "1" : "0");
    } catch {
      /* not cached; asked again next page load */
    }
    return required;
  } catch {
    return true; // unknown region: ask
  }
}

/** The mode to start in, and whether to show the prompt. */
export async function resolveConsent(): Promise<{ mode: AnalyticsMode; ask: boolean }> {
  const stored = getConsent();
  if (stored) return { mode: stored === "granted" ? "full" : "limited", ask: false };
  if (privacySignal()) return { mode: "limited", ask: false };
  if (await consentRequired()) return { mode: "limited", ask: true };
  return { mode: "full", ask: false };
}
