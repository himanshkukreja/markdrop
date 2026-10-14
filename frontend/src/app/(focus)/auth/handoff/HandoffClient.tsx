"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { FocusState } from "@/components/auth/FocusState";
import { mintTenantToken } from "@/lib/api";
import { HANDOFF_FRAGMENT } from "@/lib/hosts";

/**
 * Carry a signed-in reader from markdrop.in onto a workspace's own domain.
 *
 * A browser scopes storage per origin, so a session on markdrop.in is simply
 * invisible on cdn.acme.com — the reader looks logged out there no matter how
 * recently they signed in here. This page is the one place that can see both:
 * it runs on the primary host, where the real session lives, and hands the
 * other origin a credential minted for it.
 *
 * What it hands over is deliberately small. A custom domain is an origin we do
 * not control — its owner controls the DNS and could point it anywhere — so the
 * token is scoped to that one workspace, accepted only for reading documents,
 * and expires in hours. Someone who captured one would hold read access to
 * documents belonging to the workspace whose domain they already own, and
 * nothing of the reader's own.
 *
 * It comes back on the URL fragment rather than the query string: fragments are
 * never sent to a server, so the credential stays out of access logs, proxies
 * and Referer headers on the way in.
 */
const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

type Failure = "invalid" | "mint";

export function HandoffFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-10">
      <VisuallyHidden as="h1">Opening</VisuallyHidden>
      <MarkdropLoader label="Opening…" />
    </div>
  );
}

export default function HandoffClient() {
  const params = useSearchParams();
  const [error, setError] = useState<Failure | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const started = useRef(false);

  const rawHost = (params.get("host") || "").trim().toLowerCase();
  // Only ever show a host that passes the same check the redirect uses.
  const shownHost = HOST_RE.test(rawHost) ? rawHost : null;

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const host = (params.get("host") || "").trim().toLowerCase();
    const next = params.get("next") || "/";

    // Only ever a path on the target host, and only ever that host. Both are
    // attacker-supplied — this page is reachable by URL — so neither is allowed
    // to redirect anywhere of the caller's choosing.
    const hostOk = HOST_RE.test(host);
    const nextOk = next.startsWith("/") && !next.startsWith("//");
    if (!hostOk || !nextOk) { setError("invalid"); return; }

    const token = localStorage.getItem("markdrop_token");
    if (!token) {
      // Not signed in here either. Sign in first, then come back and finish.
      setSigningIn(true);
      const here = `/auth/handoff?host=${encodeURIComponent(host)}&next=${encodeURIComponent(next)}`;
      window.location.replace(`/login?next=${encodeURIComponent(here)}`);
      return;
    }

    mintTenantToken(host)
      .then(({ token: scoped }) => {
        window.location.replace(
          `https://${host}${next}#${HANDOFF_FRAGMENT}=${encodeURIComponent(scoped)}`
        );
      })
      .catch(() => setError("mint"));
  }, [params]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center py-10">
        {error === "invalid" ? (
          <FocusState
            icon="link"
            title="That link isn't valid"
            description="It's missing the site it should open. Go back to the page you came from and choose Sign in there again."
            actions={<Button href="/dashboard" variant="primary" size="lg">Go to your documents</Button>}
          />
        ) : (
          <FocusState
            icon="globe"
            title={shownHost ? <>Couldn&apos;t open <span className="break-words">{shownHost}</span></> : "Couldn't open that site"}
            description="The site may not be connected to Markdrop yet, or your session has ended. Open the document from your documents, or sign in again."
            actions={<Button href="/dashboard" variant="primary" size="lg">Go to your documents</Button>}
          />
        )}
      </div>
    );
  }

  const label = signingIn ? "Taking you to sign in…" : shownHost ? `Opening ${shownHost}…` : "Opening…";
  return (
    <div className="flex flex-1 items-center justify-center py-10">
      <VisuallyHidden as="h1">{label}</VisuallyHidden>
      <MarkdropLoader label={label} />
    </div>
  );
}
