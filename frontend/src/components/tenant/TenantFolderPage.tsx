"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { fetchTenantFolderAsReader, type TenantFolderListing } from "./folderIndex";
import { TenantFolderIndex } from "./TenantFolderIndex";
import { Button, EmptyState } from "@/components/ui";
import { TenantFooter } from "./TenantFooter";
import { TenantHandoff } from "./TenantHandoff";
import { TenantHeader } from "./TenantHeader";
import { TenantHome } from "./TenantHome";

/**
 * A folder (or the site root) on a workspace's own domain, for whoever is reading.
 *
 * The server render is anonymous so it can be cached: it lists only what a signed-out visitor may
 * open. A signed-in reader (a tenant token on this domain) may be able to open more — a members-
 * only document, one shared with them by name — so their browser asks once more with the token
 * and swaps in that listing. Nothing is hidden by the swap; it only ever adds what the API says
 * this reader may open.
 */
export interface TenantFolderPageProps {
  host: string;
  siteName: string;
  /** Folder path segments; [] for the site root. */
  path: string[];
  /** The anonymous listing; null when there is none (the root then shows the site's name). */
  initial: TenantFolderListing | null;
  /** Set when the workspace requires sign-in to view: where "Sign in" goes (the handoff). */
  signInHref?: string | null;
}

export function TenantFolderPage({ host, siteName, path, initial, signInHref = null }: TenantFolderPageProps) {
  const { user } = useAuth();
  const [listing, setListing] = useState<TenantFolderListing | null>(initial);
  const key = path.join("/");

  useEffect(() => {
    let cancelled = false;
    void fetchTenantFolderAsReader(host, path).then((mine) => {
      if (!cancelled && mine) setListing(mine);
    });
    return () => {
      cancelled = true;
    };
    // `user` re-runs this after a handoff signs the reader in on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, key, user?.id]);

  const returnPath = path.length ? `/${path.join("/")}` : "/";
  if (!listing && signInHref && !user) return <TenantSignInGate siteName={siteName} signInHref={signInHref} />;
  if (!listing) return <TenantHome siteName={siteName} />;
  return (
    <TenantFolderIndex
      siteName={siteName}
      folder={path.length ? listing.folder : null}
      trail={listing.trail}
      folders={listing.folders}
      documents={listing.documents}
      returnPath={returnPath}
    />
  );
}

/** A sign-in-required workspace (D3), seen signed out: say so and offer the way in. */
function TenantSignInGate({ siteName, signInHref }: { siteName: string; signInHref: string }) {
  return (
    <>
      <TenantHandoff />
      <TenantHeader returnPath="/" hideAuth />
      <main
        id="main"
        tabIndex={-1}
        className="flex w-full min-w-0 flex-1 flex-col items-center justify-center px-4 py-16 outline-none sm:py-24"
      >
        <h1 className="md-visually-hidden">{siteName}</h1>
        <EmptyState
          icon="lock"
          title={`Sign in to read ${siteName}`}
          description="Only people who have been given access can see what's here."
          actions={<Button variant="primary" href={signInHref} iconLeft="user">Sign in</Button>}
        />
      </main>
      <TenantFooter />
    </>
  );
}

export default TenantFolderPage;
