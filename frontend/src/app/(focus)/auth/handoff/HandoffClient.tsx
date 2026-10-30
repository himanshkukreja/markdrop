"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Checkbox, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { FocusState } from "@/components/auth/FocusState";
import { HANDOFF_FRAGMENT, HANDOFF_NONE_FRAGMENT } from "@/lib/hosts";
import { getHandoffConsent, HandoffError, mintHandoffToken, type HandoffConsent } from "./handoffApi";

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
 * token is scoped to that one workspace, accepted only for reading documents
 * and only from that host, carries no email address, and expires in hours.
 *
 * It is never silent for a stranger: handing it over tells the domain's owner
 * who visited, and this page is reachable by any link. Unless the reader is a
 * member of the workspace (it is their own site) or said yes for this host
 * before, it asks first: "Continue to <host> as you?". The API enforces the
 * same rule, so skipping this screen gets nothing.
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

function loginUrl(host: string, next: string): string {
  const here = `/auth/handoff?host=${encodeURIComponent(host)}&next=${encodeURIComponent(next)}`;
  return `/login?next=${encodeURIComponent(here)}`;
}

export default function HandoffClient() {
  const params = useSearchParams();
  const [error, setError] = useState<Failure | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [consent, setConsent] = useState<HandoffConsent | null>(null);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const rawHost = (params.get("host") || "").trim().toLowerCase().replace(/\.+$/, "");
  // Only ever show a host that passes the same check the redirect uses.
  const shownHost = HOST_RE.test(rawHost) ? rawHost : null;
  const next = params.get("next") || "/";
  // Silent: a gated page checking whether the reader is already signed in here. It never shows
  // the login page or the consent screen; anything short of a straight hand-over goes back with
  // "nothing to hand over", and the page shows its own Sign in.
  const silent = params.get("silent") === "1";

  const giveUp = useCallback(
    (host: string) => window.location.replace(`https://${host}${next}#${HANDOFF_NONE_FRAGMENT}=1`),
    [next],
  );

  const handOver = useCallback(
    async (host: string, agreed: boolean, keep: boolean) => {
      try {
        const scoped = await mintHandoffToken(host, agreed, keep);
        window.location.replace(`https://${host}${next}#${HANDOFF_FRAGMENT}=${encodeURIComponent(scoped)}`);
      } catch (e) {
        if (silent) { giveUp(host); return; }
        if (e instanceof HandoffError && e.status === 401) {
          setSigningIn(true);
          window.location.replace(loginUrl(host, next));
          return;
        }
        setError("mint");
        setBusy(false);
      }
    },
    [next, silent, giveUp],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const host = rawHost;
    // Only ever a path on the target host, and only ever that host. Both are
    // attacker-supplied — this page is reachable by URL — so neither is allowed
    // to redirect anywhere of the caller's choosing.
    const hostOk = HOST_RE.test(host);
    const nextOk = next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\");
    if (!hostOk || !nextOk) { setError("invalid"); return; }

    if (!localStorage.getItem("markdrop_token")) {
      if (silent) { giveUp(host); return; }
      // Not signed in here either. Sign in first, then come back and finish.
      setSigningIn(true);
      window.location.replace(loginUrl(host, next));
      return;
    }

    getHandoffConsent(host)
      .then((info) => {
        if (info.needs_consent) {
          // Asking is the reader's call, never a silent one.
          if (silent) { giveUp(host); return; }
          setConsent(info);
        } else void handOver(host, false, false);
      })
      .catch((e) => {
        if (silent) { giveUp(host); return; }
        if (e instanceof HandoffError && e.status === 401) {
          setSigningIn(true);
          window.location.replace(loginUrl(host, next));
          return;
        }
        setError("mint");
      });
  }, [rawHost, next, handOver, silent, giveUp]);

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
            description="The site may not be connected to Markdrop right now, or your session has ended. Open the document from your documents, or sign in again."
            actions={<Button href="/dashboard" variant="primary" size="lg">Go to your documents</Button>}
          />
        )}
      </div>
    );
  }

  if (consent && shownHost) {
    const site = consent.site_name?.trim();
    const who = consent.name?.trim() || consent.email;
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <FocusState
          icon="globe"
          title={
            <>
              Continue to <span className="break-words">{shownHost}</span> as {who}?
            </>
          }
          description={
            <>
              {site ? <><span className="break-words">{site}</span> ({shownHost})</> : shownHost} is a site published
              with Markdrop. Continuing signs you in there so you can read what&apos;s been shared with you. The
              site can see your display name, never your email address, and can&apos;t change anything in your
              account.
            </>
          }
          actions={
            <div className="flex w-full flex-col items-center gap-4">
              <Checkbox
                label={`Don't ask again for ${shownHost}`}
                checked={remember}
                onChange={(e) => setRemember((e.target as HTMLInputElement).checked)}
              />
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="primary"
                  size="lg"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void handOver(shownHost, true, remember);
                  }}
                >
                  Continue
                </Button>
                <Button variant="secondary" size="lg" href="/dashboard" disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          }
        />
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
