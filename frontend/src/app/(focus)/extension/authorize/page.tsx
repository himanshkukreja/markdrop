import { Suspense } from "react";
import type { Metadata } from "next";
import AuthorizeClient from "./AuthorizeClient";

export const metadata: Metadata = {
  title: "Connect VS Code · Markdrop",
  robots: { index: false, follow: false },
};

/** Opened by the VS Code extension ("Markdrop: Sign in") to mint an API token for it (REVAMP_PLAN 7.15). */
export default function AuthorizePage() {
  // AuthorizeClient reads `state`/`redirect` with useSearchParams, so it sits in Suspense (the route prerenders).
  return (
    <div className="flex flex-1 items-center justify-center py-6 sm:py-10">
      <Suspense fallback={null}>
        <AuthorizeClient />
      </Suspense>
    </div>
  );
}
