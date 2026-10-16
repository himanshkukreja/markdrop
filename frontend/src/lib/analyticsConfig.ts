/**
 * Third-party analytics settings: PostHog (product analytics and session replay) and Google
 * Analytics 4. Both are public identifiers, safe in client code. The PostHog personal API key the
 * admin Journeys tab reads with lives only on the backend.
 *
 * They run on markdrop.in only: never on a workspace's custom domain (those readers belong to the
 * workspace, not to our analytics), never on preview deployments, never locally unless
 * NEXT_PUBLIC_ANALYTICS_DEV=1 (PostHog then tags the traffic as a test user, and the admin hides it).
 */
export const POSTHOG_KEY = "phc_tWoebYDDYmHjSkzdH2CgLk8QRNKovDmkHTWYxxff6eHi";
/** Same-origin path next.config.ts rewrites to PostHog, so ad blockers don't drop the requests. */
export const POSTHOG_PROXY = "/mdp";
export const POSTHOG_UI_HOST = "https://us.posthog.com";
export const GA_ID = "G-LHZJBVBR9Q";

const PRODUCTION_HOSTS = new Set(["markdrop.in", "www.markdrop.in"]);

export function thirdPartyAnalyticsHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  if (PRODUCTION_HOSTS.has(h)) return true;
  return process.env.NEXT_PUBLIC_ANALYTICS_DEV === "1" && (h === "localhost" || h === "127.0.0.1");
}
