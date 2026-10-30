import { buildSearchIndex } from "@/docs/outputs";

/** The ⌘K palette's index: sections, pages and changelog entries, searched in the browser. */
export const dynamic = "force-static";

export function GET() {
  return new Response(JSON.stringify(buildSearchIndex()), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
