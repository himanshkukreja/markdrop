import type { MetadataRoute } from "next";

/**
 * Web app manifest (REVAMP_BUILD R40): name, the system mark, and theme colours for both themes.
 *
 * A route rather than the file convention (app/manifest.ts): a file-based manifest is linked from
 * every page under the root, and its static metadata wins over a layout's `manifest: null`, so
 * the docs pages linked Markdrop's manifest (a 404 on the docs host). The root layout links this
 * route instead (metadata.manifest) and the docs layout turns that off. Same body and headers as
 * the convention's generated route.
 */
export const dynamic = "force-static";

function manifest(): MetadataRoute.Manifest {
  return {
    name: "Markdrop",
    short_name: "Markdrop",
    description: "Docs and files as links that render",
    start_url: "/",
    display: "browser",
    background_color: "#030712",
    theme_color: "#030712",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/apple-icon", type: "image/png", sizes: "180x180" },
    ],
  };
}

export function GET(): Response {
  return new Response(JSON.stringify(manifest()), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=0, must-revalidate" },
  });
}
