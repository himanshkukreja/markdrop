"use client";

import { Analytics } from "@vercel/analytics/next";

/**
 * Vercel Web Analytics, with document URLs redacted before they are sent.
 *
 * On Markdrop the page path *is* the document: `markdrop.in/bkwJuG4`. Those
 * slugs are capability URLs — holding one is what grants you the document — so
 * shipping every visited path to a third party would hand Vercel a browsable
 * index of everything published here, on a product that tells people we store
 * ciphertext we cannot read. The encryption key itself is never at risk (it
 * lives in the fragment, which is not part of the path and is never collected),
 * but the slugs alone are enough to undo the claim.
 *
 * So document and P2P-room paths collapse to their route shape before leaving
 * the browser. Aggregate traffic to `/[slug]` is still counted — which is the
 * only thing analytics was going to tell us anyway, since per-document view
 * counts already come from our own backend.
 */

/** Every real page. Anything else with a single path segment is a document. */
const APP_ROUTES = new Set([
  "",
  "admin",
  "auth",
  "builder",
  "dashboard",
  "extension",
  "login",
  "new",
  "settings",
  "share",
  "upload",
]);

/** Swap an identifier-bearing path for its route shape. Exported for testing. */
export function redactPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  // /share/<roomId> — an ephemeral P2P room, no more shareable than a document.
  if (segments[0] === "share" && segments.length > 1) return "/share/[id]";

  if (segments.length === 1 && !APP_ROUTES.has(segments[0])) return "/[slug]";
  return pathname;
}

export default function WebAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => {
        try {
          const url = new URL(event.url);
          url.pathname = redactPath(url.pathname);
          // The fragment is never in `event.url` to begin with; clearing the
          // query as well keeps ?new=1 and friends out of the record, since
          // those only ever appear alongside a document slug.
          url.search = "";
          url.hash = "";
          return { ...event, url: url.toString() };
        } catch {
          // An unparseable URL is not worth guessing at — drop the event.
          return null;
        }
      }}
    />
  );
}
