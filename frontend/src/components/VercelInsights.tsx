"use client";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { redactUrl } from "@/lib/analyticsPath";

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
          const url = redactUrl(event.url);
          return url ? { ...event, url } : null;
        }}
      />
      <SpeedInsights
        beforeSend={(event) => {
          const url = redactUrl(event.url);
          // `route` is already the Next route shape (/[slug]), so it needs no
          // redaction — but drop the event entirely if the URL looked wrong.
          return url ? { ...event, url } : null;
        }}
      />
    </>
  );
}
