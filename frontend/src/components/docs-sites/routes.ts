/**
 * Markdrop Guides' addresses. The studio is its own area, on its own host (guides.markdrop.in;
 * lib/studioHost has where it lives on every host). Studio paths, as on the studio host:
 *
 *   /                    every site you can open, grouped by workspace (?ws=<id>|personal filters)
 *   /new                 a new site (?ws=<id>|personal preselects where it lives,
 *                        ?start=blank|template|gitbook|github|openapi how it starts)
 *   /github/installed    back from github.com after installing (or linking) the Markdrop Guides
 *                        app (?code=&state=&installation_id=&setup_action=): finishes linking,
 *                        then goes back where it started. A static segment, so it wins over
 *                        [siteId]; a site id is never "github".
 *   /<site>              the editor (?page=<id>)
 *   /<site>/import       the GitBook or GitHub import (?job=<id>, else the site's last import)
 *   /<site>/changelog    the changelog: entries (?entry=<id>|new), Coming next, products, preview
 *   /<site>/design       themes, brand, fonts, custom CSS
 *   /<site>/publish      changes, publish, reviews, history
 *   /<site>/fixes        the Fix list: what to fix next (?status=…&type=…&page=<path>&item=<id>,
 *                        ?sample=1 the sample list)
 *   /<site>/insights     readers: views, searches, Ask AI questions, feedback (?range=7d|30d|90d)
 *   /<site>/settings     → /settings/general (an old #anchor → its section, settings/sections.ts)
 *   /<site>/settings/<section>  general, domains (…/new, …/<host>), access, ask-ai, api-reference,
 *                        github, redirects, people, danger
 *   /members             Guides roles in a workspace (?ws=<id>; studio admins)
 *
 * Each is the app route /guides<path> (the home: /guides/home; /guides itself is the landing
 * page). The helpers below give the address on the current host: the bare path on
 * guides.markdrop.in, /guides<path> on localhost and previews. The old /w/<ws>/docs… and
 * /docs-studio… addresses redirect here (next.config.ts, middleware).
 */
import { STUDIO_ROUTE, studioHref } from "@/lib/studioHost";

/** The studio's app route tree (for checks on app routes, e.g. the API's GitHub return_to). */
export const STUDIO = STUDIO_ROUTE;

/** "personal" or a workspace id: the scope a site lives in. */
export type StudioScope = string;
export const PERSONAL = "personal";

export const scopeOf = (s: { workspace_id: string | null }): StudioScope => s.workspace_id ?? PERSONAL;

const withScope = (path: string, scope?: StudioScope | null) => (scope ? `${path}?ws=${encodeURIComponent(scope)}` : path);

/** The studio's home, optionally filtered to one workspace (or "personal"). */
export const studioHome = (scope?: StudioScope | null) => studioHref(withScope("/", scope));
/** How a new guide starts (?start= on /new preselects it): openapi = the API reference template. */
export type NewGuideStart = "blank" | "template" | "gitbook" | "github" | "openapi";
export const NEW_GUIDE_STARTS: readonly NewGuideStart[] = ["blank", "template", "gitbook", "github", "openapi"];
/** New site, optionally preselecting where it lives and how it starts. */
export const studioNew = (scope?: StudioScope | null, start?: NewGuideStart | null) => {
  const path = withScope("/new", scope);
  return studioHref(start ? `${path}${path.includes("?") ? "&" : "?"}start=${start}` : path);
};
/** A site's screens hang off this (the editor itself is the bare address). */
export const siteBase = (siteId: string) => studioHref(`/${encodeURIComponent(siteId)}`);
/** Guides › Members: a workspace's people and their Guides roles (studio admins). */
export const studioMembers = (workspaceId?: string | null) => studioHref(withScope("/members", workspaceId));
/** Back from github.com, as a studio path (the app route is /guides/github/installed). */
export const STUDIO_GITHUB_INSTALLED_PATH = "/github/installed";
/** Back from github.com: the address on this host. */
export const studioGithubInstalled = () => studioHref(STUDIO_GITHUB_INSTALLED_PATH);
