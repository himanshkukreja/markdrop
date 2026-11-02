/**
 * Third-party analytics settings: PostHog (product analytics and session replay) and Google
 * Analytics 4. Both are public identifiers, safe in client code. The PostHog personal API key the
 * admin Journeys tab reads with lives only on the backend.
 *
 * They run on Markdrop's own hosts only: markdrop.in, the Guides studio (guides.markdrop.in) and
 * Markdrop's docs (docs.markdrop.in). Never on a workspace's custom domain or a published guide
 * (<site>.guides.markdrop.in, a customer's own domain: those readers belong to the customer, not to
 * our analytics; the docs engine also turns Markdrop's trackers off there, docs/client/AppTrackers),
 * never on preview deployments, never locally unless NEXT_PUBLIC_ANALYTICS_DEV=1 (PostHog then
 * tags the traffic as a test user, and the admin hides it).
 */
import { STUDIO_DEV_HOST, STUDIO_HOST } from "./studioHost";
import { DOCS_DEV_HOST, DOCS_HOSTS } from "@/docs/host";
import { isAnalyticsHost } from "./analyticsPath";

export const POSTHOG_KEY = "phc_tWoebYDDYmHjSkzdH2CgLk8QRNKovDmkHTWYxxff6eHi";
/** Same-origin path next.config.ts rewrites to PostHog, so ad blockers don't drop the requests. */
export const POSTHOG_PROXY = "/mdp";
export const POSTHOG_UI_HOST = "https://us.posthog.com";
export const GA_ID = "G-LHZJBVBR9Q";

// The studio host and the docs host are Markdrop too: the same visitors, one PostHog project.
const PRODUCTION_HOSTS: ReadonlySet<string> = new Set([
  "markdrop.in",
  "www.markdrop.in",
  STUDIO_HOST,
  ...[...DOCS_HOSTS].filter((h) => h !== DOCS_DEV_HOST),
]);
// guides.localhost and docs.localhost: the studio and the docs as the middleware serves them locally.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", STUDIO_DEV_HOST, DOCS_DEV_HOST]);

export function thirdPartyAnalyticsHost(): boolean {
  if (typeof window === "undefined") return false;
  return isAnalyticsHost(window.location.hostname, PRODUCTION_HOSTS, LOCAL_HOSTS, process.env.NEXT_PUBLIC_ANALYTICS_DEV === "1");
}
