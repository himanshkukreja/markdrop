"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { FocusState } from "@/components/auth/FocusState";
import { appHref } from "@/lib/studioHost";
import { HANDOFF_FAILED_ATTR, studioSignInHref, studioSignedIn } from "@/lib/studioSession";

/** True once the studio host's sign-in hand-off has given up (lib/studioSession marks <html>). */
export function useHandoffStuck(): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const html = document.documentElement;
    const check = () => setStuck(html.hasAttribute(HANDOFF_FAILED_ATTR));
    check();
    const mo = new MutationObserver(check);
    mo.observe(html, { attributes: true, attributeFilter: [HANDOFF_FAILED_ATTR] });
    return () => mo.disconnect();
  }, []);
  return stuck;
}

/**
 * In place of a studio screen when signing in on the studio host kept failing (three hand-offs
 * from markdrop.in in two minutes without a session that works here): a way out instead of a loop.
 * Sign in starts over (the guard is reset) through markdrop.in's sign-in.
 */
export function StudioSignInFailed() {
  const signIn = () => {
    studioSignedIn();
    window.location.assign(studioSignInHref(window.location.pathname + window.location.search));
  };
  return (
    <main id="main" tabIndex={-1} className="flex flex-1 items-center justify-center px-4 py-16 outline-none">
      <FocusState
        icon="lock"
        title="We couldn't sign you in to Markdrop Guides"
        description="Your Markdrop session didn't carry over to guides.markdrop.in. Sign in again, or check that this browser allows storage for markdrop.in."
        actions={
          <>
            <Button variant="primary" size="lg" onClick={signIn}>Sign in</Button>
            <Button variant="secondary" size="lg" href={appHref("/dashboard")}>Go to Markdrop</Button>
          </>
        }
      />
    </main>
  );
}
