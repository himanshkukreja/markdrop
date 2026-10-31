/** Responses for the docs' text outputs (static at build time; the CDN caches them). */
export function textResponse(body: string, type: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

/** A text output the site doesn't have (the changelog feeds of a site with no changelog). */
export function notFoundText(): Response {
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Markdown for agents: varies on Accept (the HTML page and this share an address), may be used as AI input. */
export function markdownResponse(body: string, canonical: string): Response {
  return textResponse(body, "text/markdown", {
    vary: "Accept",
    link: `<${canonical}>; rel="canonical"`,
    "content-signal": "search=yes, ai-input=yes",
    "x-robots-tag": "noindex",
  });
}
