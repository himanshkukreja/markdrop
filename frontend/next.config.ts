import path from "node:path";
import type { NextConfig } from "next";
import { docsHostsFromEnv, hasSiteAssets, hostPattern, nextRedirects } from "./src/docs/siteFiles.mjs";

/** The docs content folder, as src/docs/content.ts reads it. */
const DOCS_CONTENT = process.env.DOCS_CONTENT_DIR || path.join(process.cwd(), "content", "docs");
const DOCS_HOSTS = docsHostsFromEnv();

const nextConfig: NextConfig = {
  // Lets a dev server (NEXT_DIST_DIR=.next-dev) run alongside `next build` without the two
  // overwriting each other's output. Vercel builds use the default.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // PostHog's capture endpoints end in a slash; a redirect would drop the request body.
  skipTrailingSlashRedirect: true,
  // The docs MCP server (app/docs-site/mcp) reads the docs content at request time; every other
  // docs route is static, so only this one needs the content folder in its function.
  outputFileTracingIncludes: { "/docs-site/mcp": ["./content/docs/**/*"] },
  /**
   * First-party path for PostHog (lib/analyticsConfig.ts, POSTHOG_PROXY). Requests to
   * posthog.com are on ad-block lists; the same requests to our own origin are not. The
   * rewrite forwards them unchanged, including the client's IP for geolocation.
   */
  /**
   * The OAuth consent screen must never render inside another site's frame: a page that framed it
   * could trick a click on Approve (clickjacking). Headers only; rendering is unchanged.
   */
  async headers() {
    return [
      {
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
      // The custom-domain handoff ("Continue to <host> as you?") hands a session to another
      // origin on one click: same clickjacking rule as the consent screen.
      {
        source: "/auth/handoff",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  /**
   * The docs site's redirects.json (src/docs/siteFiles.mjs): 308s on the docs hosts, answered
   * before the middleware and any page. None for a site without one (Markdrop's has none).
   */
  async redirects() {
    return nextRedirects(DOCS_CONTENT, DOCS_HOSTS);
  },
  async rewrites() {
    return [
      { source: "/mdp/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/mdp/array/:path*", destination: "https://us-assets.i.posthog.com/array/:path*" },
      { source: "/mdp/:path*", destination: "https://us.i.posthog.com/:path*" },
      // A docs site with its own assets (<content>/public/docs-assets, as an importer writes them):
      // a /docs-assets/ file the app's public/ doesn't have is read from there (afterFiles: the
      // app's own public files still win). Markdrop's docs keep theirs in public/ and skip this.
      ...(hasSiteAssets(DOCS_CONTENT)
        ? [{ source: "/docs-assets/:path+", has: [{ type: "host" as const, value: hostPattern(DOCS_HOSTS) }], destination: "/docs-site/docs-assets/:path+" }]
        : []),
    ];
  },
};

export default nextConfig;
