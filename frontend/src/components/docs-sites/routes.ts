/**
 * Markdrop Guides' addresses. The studio is its own area of the app, not a workspace page:
 *
 *   /guides                    every site you can open, grouped by workspace (?ws=<id>|personal filters)
 *   /guides/new                a new site (?ws=<id>|personal preselects where it lives,
 *                              ?start=blank|template|gitbook|openapi how it starts)
 *   /guides/<site>             the editor (?page=<id>)
 *   /guides/<site>/import      the GitBook import (?job=<id>, else the site's last import)
 *   /guides/<site>/design      themes, brand, fonts, custom CSS
 *   /guides/<site>/publish     changes, publish, reviews, history
 *   /guides/<site>/insights    readers: views, searches, Ask AI questions, feedback (?range=7d|30d|90d)
 *   /guides/<site>/settings    address, Ask AI, access, redirects, people, delete
 *   /guides/members            Guides roles in a workspace (?ws=<id>; studio admins)
 *
 * The old /w/<ws>/docs… addresses redirect here (next.config.ts).
 */
export const STUDIO = "/guides";

/** "personal" or a workspace id: the scope a site lives in. */
export type StudioScope = string;
export const PERSONAL = "personal";

export const scopeOf = (s: { workspace_id: string | null }): StudioScope => s.workspace_id ?? PERSONAL;

const withScope = (path: string, scope?: StudioScope | null) => (scope ? `${path}?ws=${encodeURIComponent(scope)}` : path);

/** The studio's home, optionally filtered to one workspace (or "personal"). */
export const studioHome = (scope?: StudioScope | null) => withScope(STUDIO, scope);
/** How a new guide starts (?start= on /guides/new preselects it): openapi = the API reference template. */
export type NewGuideStart = "blank" | "template" | "gitbook" | "openapi";
export const NEW_GUIDE_STARTS: readonly NewGuideStart[] = ["blank", "template", "gitbook", "openapi"];
/** New site, optionally preselecting where it lives and how it starts. */
export const studioNew = (scope?: StudioScope | null, start?: NewGuideStart | null) => {
  const path = withScope(`${STUDIO}/new`, scope);
  return start ? `${path}${path.includes("?") ? "&" : "?"}start=${start}` : path;
};
/** A site's screens hang off this (the editor itself is the bare address). */
export const siteBase = (siteId: string) => `${STUDIO}/${encodeURIComponent(siteId)}`;
/** Guides › Members: a workspace's people and their Guides roles (studio admins). */
export const studioMembers = (workspaceId?: string | null) => withScope(`${STUDIO}/members`, workspaceId);
