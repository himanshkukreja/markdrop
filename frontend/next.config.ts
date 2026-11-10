import path from "node:path";
import type { NextConfig } from "next";
import { docsHostsFromEnv, hostPattern, nextRedirects } from "./src/docs/siteFiles.mjs";

/** The docs content folder, as src/docs/content.ts reads it. */
const DOCS_CONTENT = process.env.DOCS_CONTENT_DIR || path.join(process.cwd(), "content", "docs");
const DOCS_HOSTS = docsHostsFromEnv();

/**
 * Content-Security-Policy, REPORT-ONLY for now: browsers log what it would block (devtools
 * console) and block nothing. It exists to find what enforcing it would break before it is
 * enforced — the encrypted reader's keys and plaintext live in this origin's pages, so an
 * enforced script-src is the next layer of defence after "user HTML never runs here".
 *
 * Why 'unsafe-inline' in script-src: Next 15 inlines its bootstrap scripts, and nonces need a
 * per-request middleware nonce, which makes every page dynamic (no ISR for documents). Enforcing
 * later means either hashes for those inline scripts or nonce + 'strict-dynamic' with dynamic
 * rendering. No report-uri on purpose: nothing about readers is collected while we look.
 */
function cspReportOnly(): string {
  const dev = process.env.NODE_ENV !== "production";
  const api = (() => {
    try {
      return new URL(process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in");
    } catch {
      return new URL("https://api.markdrop.in");
    }
  })();
  const apiWs = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
  const ga = ["https://www.googletagmanager.com", "https://*.google-analytics.com", "https://*.analytics.google.com"];
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""} ${ga[0]} https://cdnjs.cloudflare.com https://va.vercel-scripts.com`,
    `connect-src 'self' ${api.origin} ${apiWs} https://api.markdrop.in wss://api.markdrop.in https://*.r2.cloudflarestorage.com https://cdnjs.cloudflare.com ${ga.join(" ")}${dev ? " ws: http://localhost:* http://127.0.0.1:*" : ""}`,
    "img-src * data: blob:",
    "media-src * data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "frame-src 'self' blob: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${api.origin}`,
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * This build's id, for the service worker (app/sw.js, lib/pwa.ts): a deploy that changes it is a
 * new worker, and open apps offer "Reload". Set once per build in process.env so the static
 * generation workers, which load this config again, see the same value.
 */
process.env.MARKDROP_BUILD_ID ||=
  (process.env.MARKDROP_DOCS_BUILD_ID || process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || `local-${Date.now().toString(36)}`).replace(/[^\w.-]/g, "");

/** The Cloudflare Workers build (scripts/cf/build.sh); Vercel builds never set it. */
const CF_BUILD = process.env.MARKDROP_CF_BUILD === "1";

/**
 * Cloudflare build only (a Worker has a 10 MiB compressed size limit and no disk):
 * - browser-only libraries are compiled into the server chunks even though they only load inside effects
 *   (dynamic imports in DiagramFrame, thirdPartyAnalytics, the admin replay player); the server gets an empty
 *   module instead. Exact package entry points only ($).
 * - the docs content the server reads at request time (src/docs/contentFs.ts) comes from a build-time snapshot
 *   (scripts/cf/docs-snapshot.mjs) instead of the disk.
 */
const cfWebpack: NextConfig["webpack"] = (config, { isServer, webpack }) => {
  if (isServer) {
    config.resolve.alias = {
      ...config.resolve.alias,
      mermaid$: false,
      "posthog-js$": false,
      "@posthog/rrweb$": false,
      "@vercel/analytics/next$": false,
      "@vercel/speed-insights/next$": false,
    };
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/[\\/]contentSnapshot$/, path.join(process.cwd(), ".cf", "docs-snapshot.mjs")));
  }
  return config;
};

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: process.env.MARKDROP_BUILD_ID },
  ...(CF_BUILD ? { webpack: cfWebpack } : {}),
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
      // Report-only (see cspReportOnly): logs, never blocks.
      { source: "/:path*", headers: [{ key: "Content-Security-Policy-Report-Only", value: cspReportOnly() }] },
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
      // Signing out on markdrop.in clears the Guides studio host's session through this page in a
      // hidden frame (lib/studioSession clearStudioSession): only the app may frame it.
      {
        source: "/studio-signout.html",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors https://markdrop.in https://www.markdrop.in http://localhost:*" },
          { key: "Cache-Control", value: "public, max-age=3600" },
        ],
      },
      // The Markdrop Guides landing page's live demo (public/guides-demo, framed by /guides with
      // sandbox="allow-scripts"). The header repeats that sandbox, as Markdrop's file server does
      // for embeds, so the page runs in an opaque origin even when opened on its own: no cookies,
      // no storage, no markdrop.in. It may fetch nothing, and only markdrop.in may frame it.
      {
        source: "/guides-demo/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cache-Control", value: "public, max-age=3600" },
        ],
      },
      // The landing page's live renders (public/landing-demo, built by scripts/landing-samples/
      // build-demo.mjs): Markdrop's own PDF / spreadsheet / video viewers and the sample HTML page,
      // framed by / with sandbox="allow-scripts". Same rule as the guides demo: the header repeats
      // the sandbox, so each page runs in an opaque origin even when opened on its own. The viewers
      // load pdf.js / SheetJS from cdnjs (as on the file origin) and read only the sample files.
      {
        source: "/landing-demo/:page([a-z.-]+\\.html)",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com blob:; connect-src 'self' https://cdnjs.cloudflare.com; worker-src blob:; img-src 'self' data: blob:; media-src 'self'; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'self'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cache-Control", value: "public, max-age=3600" },
        ],
      },
      // The sample files those pages read. Their frames are opaque origins, so the reads are
      // cross-origin: public bytes, CORS * without credentials (as the file origin answers).
      {
        source: "/landing-demo/files/:file*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cache-Control", value: "public, max-age=86400" },
        ],
      },
    ];
  },
  /**
   * The docs site's redirects.json (src/docs/siteFiles.mjs): 308s on the docs hosts, answered
   * before the middleware and any page. None for a site without one (Markdrop's has none).
   */
  async redirects() {
    // Guides moved out of the workspace (/w/<ws>/docs…) into Markdrop Guides' studio. The query
    // string carries over (?ws=, ?page=, ?job=, ?new=). Never on a docs host: a page there may
    // legitimately live at /w/…. These land on the studio's app routes (/guides/home is its home);
    // the middleware (lib/studioHost studioRouting) then sends markdrop.in's to the studio host
    // (guides.markdrop.in), and also answers the old /docs-studio/… addresses and /guides/about.
    const notDocs = [{ type: "host" as const, value: hostPattern(DOCS_HOSTS) }];
    const app = { missing: notDocs, permanent: false };
    return [
      { source: "/w/:wsId/docs", destination: "/guides/home?ws=:wsId", ...app },
      { source: "/w/:wsId/docs/new", destination: "/guides/new?ws=:wsId", ...app },
      { source: "/w/:wsId/docs/:siteId/:rest*", destination: "/guides/:siteId/:rest*", ...app },
      ...nextRedirects(DOCS_CONTENT, DOCS_HOSTS),
    ];
  },
  async rewrites() {
    return [
      { source: "/mdp/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/mdp/array/:path*", destination: "https://us-assets.i.posthog.com/array/:path*" },
      { source: "/mdp/:path*", destination: "https://us.i.posthog.com/:path*" },
      // A /docs-assets/ file the app's public/ doesn't have, on a docs host: read from the site's
      // own assets (<content>/public/docs-assets, as an importer writes them), else a plain 404
      // (afterFiles: the app's own public files still win, so Markdrop's docs media, kept in
      // public/, never reaches the handler). Without this a missing file rendered the app's 404.
      { source: "/docs-assets/:path+", has: [{ type: "host" as const, value: hostPattern(DOCS_HOSTS) }], destination: "/docs-site/docs-assets/:path+" },
    ];
  },
};

export default nextConfig;
