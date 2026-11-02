/**
 * Server-safe bits of the Markdrop Guides landing page (markdrop.in/guides, the same page for
 * everyone; the studio is on its own host, lib/studioHost).
 */
import { STUDIO_ROUTE, appHref } from "@/lib/studioHost";

/** lib/api's TOKEN_KEY (where sign-in lives); repeated here so this file stays server-safe. */
export const TOKEN_KEY_FOR_VIEW = "markdrop_token";

/** "About Markdrop Guides" from the studio: the landing page, on markdrop.in. */
export const guidesAboutHref = () => appHref(STUDIO_ROUTE);
