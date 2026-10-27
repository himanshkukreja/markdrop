"use client";

import { useEffect, useState } from "react";
import { AttemptedPath } from "@/components/shell/NotFound";
import { Button, Icon } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { fetchTenantFolderAsReader, type TenantFolderListing } from "./folderIndex";
import { TenantFolderIndex } from "./TenantFolderIndex";
import { TenantFooter } from "./TenantFooter";
import { TenantHandoff } from "./TenantHandoff";
import { TenantHeader } from "./TenantHeader";
import { useTenant } from "./TenantProvider";

/** Folder segments of the current address (no slug check: the API decides what exists). */
function pathSegments(): string[] {
  try {
    return window.location.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
  } catch {
    return [];
  }
}

/**
 * 404 on a workspace's own domain (REVAMP_PLAN 7.22): the tenant's header and accent, "Nothing at
 * this address", and one way back to the tenant's root. No Markdrop mark, no "Publish a
 * document": this is the customer's site. On a host that never resolved there is no tenant to
 * brand with, so the page is just the message.
 *
 * The anonymous server render can 404 a folder that only members can see into. A signed-in
 * reader's browser asks once more with its token, and shows the folder if the API lists it for
 * them.
 */
export function TenantNotFound() {
  const tenant = useTenant();
  const { user } = useAuth();
  const [listing, setListing] = useState<{ path: string[]; data: TenantFolderListing } | null>(null);

  useEffect(() => {
    if (!tenant) return;
    const path = pathSegments();
    if (!path.length) return;
    let cancelled = false;
    void fetchTenantFolderAsReader(tenant.host, path).then((data) => {
      if (!cancelled && data?.folder) setListing({ path, data });
    });
    return () => {
      cancelled = true;
    };
  }, [tenant, user?.id]);

  if (tenant && listing) {
    return (
      <TenantFolderIndex
        siteName={tenant.name}
        folder={listing.data.folder}
        trail={listing.data.trail}
        folders={listing.data.folders}
        documents={listing.data.documents}
        returnPath={`/${listing.path.join("/")}`}
      />
    );
  }

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
