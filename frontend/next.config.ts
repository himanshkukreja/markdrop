import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a dev server (NEXT_DIST_DIR=.next-dev) run alongside `next build` without the two
  // overwriting each other's output. Vercel builds use the default.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // PostHog's capture endpoints end in a slash; a redirect would drop the request body.
  skipTrailingSlashRedirect: true,
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
    ];
  },
  async rewrites() {
    return [
      { source: "/mdp/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/mdp/array/:path*", destination: "https://us-assets.i.posthog.com/array/:path*" },
      { source: "/mdp/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
  },
};

export default nextConfig;
