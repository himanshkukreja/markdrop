"use client";

import { Button, Disclosure } from "@/components/ui";
import { TenantFooter } from "./TenantFooter";
import { TenantHeader } from "./TenantHeader";
import { useTenant } from "./TenantProvider";

/**
 * A route error on a workspace's own domain (REVAMP_PLAN 7.22 `error.tsx`, in tenant chrome so
 * Markdrop's header never appears there). Never shows a stack trace; the digest is for reports.
 */
export function TenantError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tenant = useTenant();
  return (
    <>
      <TenantHeader />
      <main
        id="main"
        tabIndex={-1}
        className="flex w-full min-w-0 flex-1 flex-col items-center justify-center px-4 py-16 outline-none sm:py-24"
      >
        <div className="flex w-full max-w-[30rem] flex-col items-center gap-5 text-center">
          <h1 className="text-h1 text-text">Something went wrong on this page</h1>
          <p className="text-body-lg text-text-secondary">Try again, or go back to where you were.</p>
          <div className="mt-2 flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Button variant="primary" size="lg" onClick={reset}>Try again</Button>
            {tenant && (
              <Button variant="secondary" size="lg" href="/" className="max-w-full">
                <span dir="auto" className="truncate">Go to {tenant.name}</span>
              </Button>
            )}
          </div>
          {error.digest && (
            <Disclosure summary="Details" className="w-full text-left">
              <p className="text-caption text-text-secondary">
                Reference{" "}
                <code className="rounded-md bg-code-inline-bg px-1.5 py-0.5 font-mono text-code text-code-inline">{error.digest}</code>
              </p>
            </Disclosure>
          )}
        </div>
      </main>
      <TenantFooter />
    </>
  );
}

export default TenantError;
