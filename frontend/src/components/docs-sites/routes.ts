/**
 * Docs Studio's addresses. The studio is its own area of the app, not a workspace page:
 *
 *   /docs-studio                    every site you can open, grouped by workspace (?ws=<id>|personal filters)
 *   /docs-studio/new                a new site (?ws=<id>|personal preselects where it lives)
 *   /docs-studio/<site>             the editor (?page=<id>)
 *   /docs-studio/<site>/import      the GitBook import (?job=<id>, else the site's last import)
 *   /docs-studio/<site>/design      themes, brand, fonts, custom CSS
 *   /docs-studio/<site>/publish     changes, publish, reviews, history
 *   /docs-studio/<site>/settings    address, Ask AI, access, redirects, people, delete
 *   /docs-studio/members            Docs Studio roles in a workspace (?ws=<id>; studio admins)
 *
 * The old /w/<ws>/docs… addresses redirect here (next.config.ts).
 */
export const STUDIO = "/docs-studio";

/** "personal" or a workspace id: the scope a site lives in. */
export type StudioScope = string;
export const PERSONAL = "personal";

export const scopeOf = (s: { workspace_id: string | null }): StudioScope => s.workspace_id ?? PERSONAL;

const withScope = (path: string, scope?: StudioScope | null) => (scope ? `${path}?ws=${encodeURIComponent(scope)}` : path);

/** The studio's home, optionally filtered to one workspace (or "personal"). */
export const studioHome = (scope?: StudioScope | null) => withScope(STUDIO, scope);
/** New site, optionally preselecting where it lives. */
export const studioNew = (scope?: StudioScope | null) => withScope(`${STUDIO}/new`, scope);
/** A site's screens hang off this (the editor itself is the bare address). */
export const siteBase = (siteId: string) => `${STUDIO}/${encodeURIComponent(siteId)}`;
/** Docs Studio › Members: a workspace's people and their Docs Studio roles (studio admins). */
export const studioMembers = (workspaceId?: string | null) => withScope(`${STUDIO}/members`, workspaceId);
