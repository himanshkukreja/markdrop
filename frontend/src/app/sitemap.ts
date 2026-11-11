import type { MetadataRoute } from "next";

/**
 * markdrop.in's sitemap: its public marketing pages. Documents are capability links and never
 * listed. Only answered on markdrop.in: the docs host rewrites /sitemap.xml to its own
 * (app/docs-site/sitemap.xml) and a customer's domain gets a 404 for it (middleware.ts).
 */
const ORIGIN = "https://markdrop.in";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages: Array<{ path: string; priority: number; changeFrequency: "weekly" | "monthly" | "yearly" }> = [
    { path: "/", priority: 1, changeFrequency: "weekly" },
    { path: "/guides", priority: 0.9, changeFrequency: "weekly" },
    { path: "/mcp", priority: 0.6, changeFrequency: "monthly" },
    { path: "/enterprise", priority: 0.6, changeFrequency: "monthly" },
    { path: "/builder", priority: 0.5, changeFrequency: "monthly" },
    { path: "/privacy", priority: 0.2, changeFrequency: "yearly" },
    { path: "/terms", priority: 0.2, changeFrequency: "yearly" },
  ];
  return pages.map((p) => ({ url: `${ORIGIN}${p.path === "/" ? "" : p.path}`, changeFrequency: p.changeFrequency, priority: p.priority }));
}
