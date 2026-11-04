import type { MetadataRoute } from "next";
import { APP_START_URL, STUDIO_START_URL } from "@/lib/pwa";
import { THEME_COLOR } from "@/lib/themeScript";

/**
 * The two web app manifests (lib/pwa.ts): Markdrop on markdrop.in (app/manifest.webmanifest) and
 * Markdrop Guides on guides.markdrop.in (app/studio.webmanifest, which the middleware serves as
 * that host's /manifest.webmanifest). Both open full screen like an app (standalone), cover their
 * whole origin, and start on the signed-in home: a signed-out launch goes through sign-in and back.
 *
 * Colours: light is the default theme, so the manifest (splash screen, title bar before the page
 * loads) is light; the page's own theme-color meta (lib/themeScript) then follows the theme.
 * `id` is "/" for both: they live on different origins, so they are different apps.
 * Icons: PNGs rendered from the app mark by .work/pwa/icons.mjs (any + maskable), plus the SVG.
 */

const ICONS: MetadataRoute.Manifest["icons"] = [
  { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
  { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
];

const shortcutIcon = (name: string) => [{ src: `/icons/shortcut-${name}.png`, sizes: "96x96", type: "image/png" }];

const COMMON = {
  display: "standalone",
  scope: "/",
  orientation: "any",
  dir: "ltr",
  lang: "en",
  background_color: THEME_COLOR.light,
  theme_color: THEME_COLOR.light,
  icons: ICONS,
  categories: ["productivity", "business"],
  prefer_related_applications: false,
  // A second launch focuses the open window instead of opening another.
  launch_handler: { client_mode: ["navigate-existing", "auto"] },
} satisfies Partial<MetadataRoute.Manifest>;

export function appManifest(): MetadataRoute.Manifest {
  return {
    ...COMMON,
    id: "/",
    name: "Markdrop",
    short_name: "Markdrop",
    description: "Your documents, files, pages and workspaces, as links that render.",
    start_url: APP_START_URL,
    shortcuts: [
      { name: "New page", short_name: "New page", url: "/pages/new?source=pwa", icons: shortcutIcon("page") },
      { name: "Search", short_name: "Search", url: "/search?source=pwa", icons: shortcutIcon("search") },
      // Out of this app's scope on markdrop.in (the studio has its own host), so it opens there.
      { name: "Markdrop Guides", short_name: "Guides", url: "/guides/home?source=pwa", icons: shortcutIcon("guides") },
      { name: "Analytics", short_name: "Analytics", url: "/dashboard/analytics?source=pwa", icons: shortcutIcon("analytics") },
    ],
  };
}

export function studioManifest(): MetadataRoute.Manifest {
  return {
    ...COMMON,
    id: "/",
    name: "Markdrop Guides",
    short_name: "Guides",
    description: "Write, design and publish help centers, product guides and handbooks with your team.",
    start_url: STUDIO_START_URL,
    shortcuts: [
      { name: "New guide", short_name: "New guide", url: "/new?source=pwa", icons: shortcutIcon("page") },
      { name: "Members", short_name: "Members", url: "/members?source=pwa", icons: shortcutIcon("guides") },
    ],
  };
}

export function manifestResponse(m: MetadataRoute.Manifest): Response {
  return new Response(JSON.stringify(m), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=0, must-revalidate" },
  });
}
