import { Suspense } from "react";
import type { Metadata } from "next";
import DocsAccessClient, { DocsAccessFallback } from "./DocsAccessClient";

export const metadata: Metadata = {
  title: "Signing in · Markdrop",
  robots: { index: false, follow: false },
};

/** Signs a reader in to a members-only Docs Studio site (see DocsAccessClient). */
export default function DocsAccessPage() {
  // The client reads its parameters with useSearchParams, so it sits in Suspense (the route prerenders).
  return (
    <Suspense fallback={<DocsAccessFallback />}>
      <DocsAccessClient />
    </Suspense>
  );
}
