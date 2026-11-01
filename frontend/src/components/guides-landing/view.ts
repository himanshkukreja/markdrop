/**
 * Server-safe half of the /guides switch (GuidesFrame): which view /guides shows, decided before
 * first paint by an inline script, so a signed-in visitor never sees the landing page flash.
 */

/** lib/api's TOKEN_KEY (where sign-in lives); repeated here so this file stays server-safe. */
export const TOKEN_KEY_FOR_VIEW = "markdrop_token";

/** Set on <html> while /guides shows the studio: the landing page hides, its loader shows. */
export const GUIDES_VIEW_ATTR = "data-guides-view";

/** The landing page for signed-in visitors ("About Markdrop Guides"); /guides/about redirects here. */
export const GUIDES_ABOUT_HREF = "/guides?about=1";

/** `?about=1` asks for the landing page even when signed in. */
export function isAboutQuery(search: string): boolean {
  return new URLSearchParams(search).get("about") === "1";
}

/**
 * Inline, first thing in the landing page's HTML: a browser with a sign-in token (and no
 * ?about=1) marks <html> so CSS hides the landing page until the studio takes over. Storage
 * errors mean "signed out".
 */
export const GUIDES_VIEW_SCRIPT = `try{if(new URLSearchParams(location.search).get('about')!=='1'&&localStorage.getItem('${TOKEN_KEY_FOR_VIEW}'))document.documentElement.setAttribute('${GUIDES_VIEW_ATTR}','studio')}catch(e){}`;
