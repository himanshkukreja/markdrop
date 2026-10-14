import { Suspense } from "react";
import type { Metadata } from "next";
import HandoffClient, { HandoffFallback } from "./HandoffClient";

export const metadata: Metadata = {
  title: "Opening · Markdrop",
  robots: { index: false, follow: false },
};

/** Carries a signed-in reader onto a workspace's own domain (see HandoffClient). */
export default function HandoffPage() {
  // HandoffClient reads `host`/`next` with useSearchParams, so it sits in Suspense (the route prerenders).
  return (
    <Suspense fallback={<HandoffFallback />}>
      <HandoffClient />
    </Suspense>
  );
}
