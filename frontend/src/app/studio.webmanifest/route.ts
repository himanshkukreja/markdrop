import { manifestResponse, studioManifest } from "@/lib/pwaManifest";

/**
 * Markdrop Guides' web app manifest (lib/pwaManifest.ts). The studio host (guides.markdrop.in)
 * serves it as its /manifest.webmanifest (middleware), so the root layout's manifest link installs
 * "Markdrop Guides" there and "Markdrop" on markdrop.in.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return manifestResponse(studioManifest());
}
