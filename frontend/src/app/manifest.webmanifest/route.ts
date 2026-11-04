import { appManifest, manifestResponse } from "@/lib/pwaManifest";

/**
 * Markdrop's web app manifest (lib/pwaManifest.ts): installable as an app that opens on the
 * dashboard. On the Guides studio host the middleware answers this address with
 * app/studio.webmanifest instead.
 *
 * A route rather than the file convention (app/manifest.ts): a file-based manifest is linked from
 * every page under the root, and its static metadata wins over a layout's `manifest: null`, so
 * the docs pages linked Markdrop's manifest (a 404 on the docs host). The root layout links this
 * route instead (metadata.manifest) and the docs layout turns that off. Same body and headers as
 * the convention's generated route.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return manifestResponse(appManifest());
}
