"use client";

import { useEffect, useState } from "react";

/**
 * Read `?flag=1` style query flags after mount.
 *
 * `useSearchParams` is the idiomatic way to do this and it is what these views
 * used to call. The problem is what it does to a *statically prerendered* route:
 * the subtree that reads it cannot be prerendered, so Next emits the Suspense
 * fallback into the HTML and renders the real thing only once the client
 * hydrates. On `/[slug]` that meant the page shipped with an empty <main> — app
 * chrome and nothing in it — until hydration finished, which on a slow device is
 * most of a second of looking like a broken page before the document appears.
 *
 * Reading `location.search` in an effect keeps the route static and lets the
 * document itself be server-rendered. The cost is that flags are unknown for the
 * first commit, so anything that branches on them has to wait for `ready` rather
 * than treating "not set yet" as "not set".
 *
 * `get(name)` returns a parameter's raw value (or null) for the few pages that take a value
 * rather than a flag, e.g. `/new?slug=` and `/new?sample=diagrams`. Same rule: null until
 * `ready`.
 */
export function useQueryFlags(): { ready: boolean; has: (name: string) => boolean; get: (name: string) => string | null } {
  const [params, setParams] = useState<URLSearchParams | null>(null);

  useEffect(() => {
    setParams(new URLSearchParams(window.location.search));
  }, []);

  return {
    ready: params !== null,
    has: (name: string) => params?.get(name) === "1",
    get: (name: string) => params?.get(name) ?? null,
  };
}
