"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import MarkdropLoader from "@/components/MarkdropLoader";
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
function Handoff() {
  const params = useSearchParams();
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const host = (params.get("host") || "").trim().toLowerCase();
    const next = params.get("next") || "/";

    // Only ever a path on the target host, and only ever that host. Both are
    // attacker-supplied — this page is reachable by URL — so neither is allowed
    // to redirect anywhere of the caller's choosing.
    const hostOk = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host);
    const nextOk = next.startsWith("/") && !next.startsWith("//");
    if (!hostOk || !nextOk) { setError("That link isn't valid."); return; }

    const token = localStorage.getItem("markdrop_token");
    if (!token) {
      // Not signed in here either. Sign in first, then come back and finish.
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
      .catch(() => setError("Couldn't open that document on its own domain."));
  }, [params]);

  if (error) {
    return (
      <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-gray-600 dark:text-gray-300">{error}</p>
        <a href="/dashboard" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          Go to your documents
        </a>
      </main>
    );
  }
  return (
    <main className="flex min-h-[60vh] items-center justify-center">
      <MarkdropLoader label="Opening…" />
    </main>
  );
}

export default function HandoffPage() {
  return (
    <Suspense fallback={
      <main className="flex min-h-[60vh] items-center justify-center">
        <MarkdropLoader label="Opening…" />
      </main>
    }>
      <Handoff />
    </Suspense>
  );
}
