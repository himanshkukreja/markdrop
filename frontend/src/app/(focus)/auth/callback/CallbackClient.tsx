"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Button, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { FocusState } from "@/components/auth/FocusState";

/**
 * The token arrives in the URL fragment (`#token=…&next=…`), which browsers never send to a
 * server. It is stored through AuthContext.login(), then router.replace() moves on, so the
 * history entry carrying the token is replaced (REVAMP_PLAN 7.14; keep this order).
 */
export default function CallbackClient() {
  const router = useRouter();
  const { login } = useAuth();
  const [error, setError] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    const next = params.get("next");

    if (!token) {
      setError(true);
      return;
    }

    (async () => {
      await login(token);
      // Only a path on this site (open-redirect guard).
      const dest = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
      router.replace(dest);
    })();
  }, [login, router]);

  return (
    <div className="flex flex-1 items-center justify-center py-10">
      {error ? (
        <FocusState
          icon="clock"
          title="That sign-in link has expired"
          description="Sign-in links work once and only for a short time. Sign in again to get a new one."
          actions={<Button href="/login" variant="primary" size="lg" iconRight="arrowRight">Sign in again</Button>}
        />
      ) : (
        <>
          <VisuallyHidden as="h1">Signing you in</VisuallyHidden>
          <MarkdropLoader label="Signing you in…" />
        </>
      )}
    </div>
  );
}
