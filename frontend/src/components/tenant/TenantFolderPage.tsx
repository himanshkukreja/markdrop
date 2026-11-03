"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { fetchTenantFolderAsReader, type TenantFolderListing } from "./folderIndex";
import { TenantFolderIndex } from "./TenantFolderIndex";
import { Button, EmptyState, MarkdropLoader } from "@/components/ui";
import { HANDOFF_FRAGMENT, HANDOFF_NONE_FRAGMENT } from "@/lib/hosts";
import { startSilentHandoff, usableSessionToken } from "./handoff";
import { TenantFooter } from "./TenantFooter";
import { TenantHandoff } from "./TenantHandoff";
import { TenantHeader } from "./TenantHeader";
import { TenantHome } from "./TenantHome";
import { TenantLoading } from "./TenantLoading";

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
  const { user, loading: authLoading } = useAuth();
  const [listing, setListing] = useState<TenantFolderListing | null>(initial);
  // Whether the reader's own listing (with their token, if any) has been asked for yet. Until it
  // has, a sign-in-required site shows "Opening…", not "Sign in": the server render is anonymous,
  // and its gate is only the answer for a reader with no session.
  const [readerAsked, setReaderAsked] = useState(false);
  const key = path.join("/");

  useEffect(() => {
    let cancelled = false;
    void fetchTenantFolderAsReader(host, path).then((mine) => {
      if (cancelled) return;
      if (mine) setListing(mine);
      setReaderAsked(true);
    });
    return () => {
      cancelled = true;
    };
    // `user` re-runs this after a handoff signs the reader in on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, key, user?.id]);

  const returnPath = path.length ? `/${path.join("/")}` : "/";
  if (!listing && signInHref && !user) {
    if (authLoading || !readerAsked) {
      return (
        <>
          <TenantHandoff />
          <TenantLoading label="Opening" />
        </>
      );
    }
    return <TenantSignInGate siteName={siteName} signInHref={signInHref} />;
  }
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
  // Before asking anyone to sign in, check quietly (once per tab and page) whether they already
  // are on markdrop.in — see useDocumentViewer's handoff effect for the same rule on documents.
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith(`#${HANDOFF_NONE_FRAGMENT}=`)) {
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
      return;
    }
    if (hash.startsWith(`#${HANDOFF_FRAGMENT}=`)) return; // TenantHandoff takes it
    // A live tenant token: the reader fetch decides. An expired one is dropped here and does not
    // count (it used to, and kept a signed-in reader on this screen).
    if (usableSessionToken()) return;
    // At most once per page every couple of minutes (the loop guard is in startSilentHandoff).
    if (startSilentHandoff(signInHref)) setChecking(true);
  }, [signInHref]);

  if (checking) {
    return (
      <main className="flex w-full flex-1 items-center justify-center py-16">
        <MarkdropLoader label="Opening…" />
      </main>
    );
  }
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
