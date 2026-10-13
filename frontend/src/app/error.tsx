"use client";

import { useEffect } from "react";
import { Button, Disclosure, MarkdropMark } from "@/components/ui";
import { SiteHeader } from "@/components/shell/SiteHeader";

/**
 * Route-segment error boundary (REVAMP_PLAN 7.22). It sits under the root layout, so it replaces
 * the group layouts too and brings its own header. Never shows a stack trace: only the digest Next
 * gives the server error, for bug reports. Also what /[slug] shows when the API is down (F7), so
 * ISR keeps serving the last good copy instead of caching a 404.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surfaces in the browser console for whoever is debugging; the UI never shows the message.
    console.error(error);
  }, [error]);

  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="flex w-full min-w-0 flex-1 flex-col items-center justify-center px-4 py-16 outline-none sm:py-24">
        <div className="flex w-full max-w-[30rem] flex-col items-center gap-5 text-center">
          <MarkdropMark size={40} />
          <h1 className="text-h1 text-text">Something went wrong on this page</h1>
          <p className="text-body-lg text-text-secondary">Your work in other tabs is safe. Try again, or go back to where you were.</p>
          <div className="flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Button variant="primary" size="lg" iconLeft="refresh" onClick={() => reset()}>Try again</Button>
            <Button variant="secondary" size="lg" href="/">Go to the home page</Button>
          </div>
          <Disclosure summary="Details" className="w-full text-left text-body text-text-secondary">
            <p className="pt-2">
              {error.digest ? (
                <>
                  Error reference{" "}
                  <code className="font-mono text-code rounded-md bg-code-inline-bg px-1.5 py-0.5 text-code-inline">{error.digest}</code>
                  . Include it if you report this.
                </>
              ) : (
                "This happened in your browser, so there's no server reference. Reloading the page usually clears it."
              )}
            </p>
          </Disclosure>
        </div>
      </main>
    </>
  );
}
