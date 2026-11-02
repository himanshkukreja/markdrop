"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { FocusState } from "@/components/auth/FocusState";
import { useAuth } from "@/contexts/AuthContext";
import { getToken } from "@/lib/api";
import { STUDIO_ROUTE, handoffStudioOrigin, studioRoute } from "@/lib/studioHost";
import { STATE_RE, STUDIO_STATE_FRAGMENT, STUDIO_TOKEN_FRAGMENT } from "@/lib/studioSession";
import { HandoffError, mintStudioToken } from "./handoffApi";

/**
 * markdrop.in's half of signing in on Markdrop Guides' studio host (lib/studioSession has the
 * whole flow):
 *
 *   ?studio=1&next=<path>&state=<state>   signed in here: mint a studio session and go back to
 *                                         <studio host><path>#mdt=<token>&mds=<state>. Signed out:
 *                                         /login first, then here again. No state (a plain "Sign
 *                                         in" link from the studio): back without a token, and the
 *                                         studio asks again with one.
 *   ?signout=studio                       signed out on the studio host: offer to sign out here too.
 *
 * Where it goes back to is never a parameter: the studio host belongs to the host this runs on
 * (lib/studioHost handoffStudioOrigin), and `next` must be a path.
 */
function safePath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.length > 2000) return "/";
  return raw;
}

function Waiting({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center py-10">
      <VisuallyHidden as="h1">{label}</VisuallyHidden>
      <MarkdropLoader label={label} />
    </div>
  );
}

function SignInToStudio() {
  const params = useSearchParams();
  const [label, setLabel] = useState("Opening Markdrop Guides…");
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const next = safePath(params.get("next"));
    const raw = params.get("state");
    const state = raw && STATE_RE.test(raw) ? raw : null;
    const origin = handoffStudioOrigin(window.location);
    const toLogin = () => {
      setLabel("Taking you to sign in…");
      window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    };
    // A preview deployment: the studio is right here, under /guides, sharing this session.
    if (!origin) return void window.location.replace(studioRoute(next));
    if (!getToken()) return toLogin();
    if (!state) return void window.location.replace(`${origin}${next}`);
    mintStudioToken()
      .then((token) => {
        window.location.replace(`${origin}${next}#${STUDIO_TOKEN_FRAGMENT}=${encodeURIComponent(token)}&${STUDIO_STATE_FRAGMENT}=${state}`);
      })
      .catch((e) => {
        if (e instanceof HandoffError && e.status === 401) toLogin();
        else setFailed(true);
      });
  }, [params]);

  if (failed) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <FocusState
          icon="layers"
          title="Couldn't open Markdrop Guides"
          description="Markdrop couldn't sign you in to the Guides studio just now. Try again in a moment."
          actions={
            <>
              <Button variant="primary" size="lg" onClick={() => window.location.reload()}>Try again</Button>
              <Button variant="secondary" size="lg" href="/dashboard">Go to your documents</Button>
            </>
          }
        />
      </div>
    );
  }
  return <Waiting label={label} />;
}

function SignedOutOfStudio() {
  const { user, loading, signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Not signed in here either: nothing to offer. The landing page.
    if (!loading && !user && !getToken()) window.location.replace(STUDIO_ROUTE);
  }, [loading, user]);

  if (!user) return <Waiting label="Signing out…" />;
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <FocusState
        icon="logOut"
        title="You're signed out of Markdrop Guides"
        description={<>You&apos;re still signed in to Markdrop as <span className="break-words">{user.email}</span>. Opening Markdrop Guides again signs you back in with it.</>}
        actions={
          <>
            <Button
              variant="primary"
              size="lg"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                if (await signOut()) window.location.replace(STUDIO_ROUTE);
                else setBusy(false);
              }}
            >
              Sign out of Markdrop too
            </Button>
            <Button variant="secondary" size="lg" href="/dashboard" disabled={busy}>Stay signed in</Button>
          </>
        }
      />
    </div>
  );
}

export default function StudioHandoff() {
  const params = useSearchParams();
  return params.get("signout") === "studio" ? <SignedOutOfStudio /> : <SignInToStudio />;
}
