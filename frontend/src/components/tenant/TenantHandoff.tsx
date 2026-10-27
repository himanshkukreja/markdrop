"use client";

import { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { consumeHandoffToken } from "./handoff";

/**
 * Consumes a sign-in handoff (`#mdt=<token>`) on tenant pages that are *not* a document: the
 * folder index, the site root and the 404. Document pages leave it to DocumentView, which reads
 * the fragment itself before its gate retry; do not mount this there.
 *
 * Only a tenant token minted for this very host is taken (see `handoff.ts`); anything else is
 * stripped from the address bar and ignored. Touches the hash only when it starts with `#mdt=`,
 * so `#k=` and `#token=` are never read or rewritten here.
 */
export function TenantHandoff() {
  const { refresh } = useAuth();
  useEffect(() => {
    if (consumeHandoffToken()) void refresh();
  }, [refresh]);
  return null;
}

export default TenantHandoff;
