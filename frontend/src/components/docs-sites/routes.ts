/**
 * Markdrop Guides' addresses. The studio is its own area of the app, not a workspace page:
 *
 *   /guides                    every site you can open, grouped by workspace (?ws=<id>|personal filters)
 *   /guides/new                a new site (?ws=<id>|personal preselects where it lives,
 *                              ?start=blank|template|gitbook|github|openapi how it starts)
 *   /guides/github/installed   back from github.com after installing (or linking) the Markdrop Guides
 *                              app (?code=&state=&installation_id=&setup_action=): finishes linking,
 *                              then goes back where it started (a /guides address). A static segment,
 *                              so it wins over [siteId]; a site id is never "github".
 *   /guides/<site>             the editor (?page=<id>)
 *   /guides/<site>/import      the GitBook or GitHub import (?job=<id>, else the site's last import)
 *   /guides/<site>/changelog   the changelog: entries (?entry=<id>|new), Coming next, products, preview
 *   /guides/<site>/design      themes, brand, fonts, custom CSS
 *   /guides/<site>/publish     changes, publish, reviews, history
 *   /guides/<site>/fixes       the Fix list: what to fix next (?status=…&type=…&page=<path>&item=<id>,
 *                              ?sample=1 the sample list)
 *   /guides/<site>/insights    readers: views, searches, Ask AI questions, feedback (?range=7d|30d|90d)
 *   /guides/<site>/settings    → /settings/general (an old #anchor → its section, settings/sections.ts)
 *   /guides/<site>/settings/<section>  general, domains (…/new, …/<host>), access, ask-ai, api-reference,
 *                              github, redirects, people, danger
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
export type NewGuideStart = "blank" | "template" | "gitbook" | "github" | "openapi";
export const NEW_GUIDE_STARTS: readonly NewGuideStart[] = ["blank", "template", "gitbook", "github", "openapi"];
/** New site, optionally preselecting where it lives and how it starts. */
export const studioNew = (scope?: StudioScope | null, start?: NewGuideStart | null) => {
  const path = withScope(`${STUDIO}/new`, scope);
  return start ? `${path}${path.includes("?") ? "&" : "?"}start=${start}` : path;
};
/** A site's screens hang off this (the editor itself is the bare address). */
export const siteBase = (siteId: string) => `${STUDIO}/${encodeURIComponent(siteId)}`;
/** Guides › Members: a workspace's people and their Guides roles (studio admins). */
export const studioMembers = (workspaceId?: string | null) => withScope(`${STUDIO}/members`, workspaceId);
/** Back from github.com: the app's setup URL and its sign-in callback point here. */
export const STUDIO_GITHUB_INSTALLED = `${STUDIO}/github/installed`;
