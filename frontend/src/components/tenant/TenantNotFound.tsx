"use client";

import { AttemptedPath } from "@/components/shell/NotFound";
import { Button, Icon } from "@/components/ui";
import { TenantFooter } from "./TenantFooter";
import { TenantHandoff } from "./TenantHandoff";
import { TenantHeader } from "./TenantHeader";
import { useTenant } from "./TenantProvider";

/**
 * 404 on a workspace's own domain (REVAMP_PLAN 7.22): the tenant's header and accent, "Nothing at
 * this address", and one way back to the tenant's root. No Markdrop mark, no "Publish a
 * document": this is the customer's site. On a host that never resolved there is no tenant to
 * brand with, so the page is just the message.
 */
export function TenantNotFound() {
  const tenant = useTenant();
  return (
    <>
      <TenantHandoff />
      <TenantHeader />
      <main
        id="main"
        tabIndex={-1}
        className="flex w-full min-w-0 flex-1 flex-col items-center justify-center px-4 py-16 outline-none sm:py-24"
      >
        <div className="flex w-full max-w-[30rem] flex-col items-center gap-5 text-center">
          <span className="grid size-16 place-items-center rounded-xl border border-border bg-surface text-text-muted" aria-hidden>
            <Icon name="search" size={28} />
          </span>
          <h1 className="text-h1 text-text">Nothing at this address</h1>
          <p className="text-body-lg text-text-secondary">
            It may have expired or been deleted, or the address has a typo.
          </p>
          <AttemptedPath />
          {tenant && (
            <Button variant="primary" size="lg" href="/" className="mt-2 max-w-full">
              <span dir="auto" className="truncate">Go to {tenant.name}</span>
            </Button>
          )}
        </div>
      </main>
      <TenantFooter />
    </>
  );
}

export default TenantNotFound;
