"use client";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { redactPath, redactUrl } from "@/lib/analyticsPath";
import { analyticsRoute, isStudioHost, studioPathOf } from "@/lib/studioHost";
import { isDocsHost } from "@/docs/host";

/**
 * redactUrl, and on the studio host (guides.markdrop.in/<site>/…, no /guides) the same shapes:
 * /[site]/…. The docs host's pages are public: their paths stay (docs.markdrop.in/get-started is
 * not a document's slug).
 */
function redact(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (isDocsHost(u.hostname)) {
      u.search = "";
      u.hash = "";
      return u.toString();
    }
    if (!isStudioHost(u.hostname)) return redactUrl(raw);
    u.pathname = studioPathOf(redactPath(analyticsRoute(u.pathname, u.hostname))) ?? "/";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Vercel Web Analytics + Speed Insights, with document URLs redacted.
 *
 * Both report the page they measured, and on this app that page is the
 * document — see lib/analyticsPath for why that matters and what it would give
 * away. They share one redaction so a rule can't protect one report and miss
 * the other.
 *
 * `beforeSend` is registered through `window.va` / `window.si` and applied by
 * Vercel's remote script, not by these packages, so it cannot be exercised
 * locally: the script only exists on a Vercel deployment with the feature
 * enabled. Verify against production, by reading the beacon payload.
 */
export default function VercelInsights() {
  return (
    <>
      <Analytics
        beforeSend={(event) => {
          const url = redact(event.url);
          return url ? { ...event, url } : null;
        }}
      />
      <SpeedInsights
        beforeSend={(event) => {
          const url = redact(event.url);
          // `route` is already the Next route shape (/[slug]), so it needs no
          // redaction — but drop the event entirely if the URL looked wrong.
          return url ? { ...event, url } : null;
        }}
      />
    </>
  );
}
