"use client";

import { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { HANDOFF_FRAGMENT } from "@/lib/hosts";

/**
 * Consumes a sign-in handoff (`#mdt=<token>`) on tenant pages that are *not* a document: the
 * folder index, the site root and the 404. Document pages leave it to DocumentView, which reads
 * the fragment itself before its gate retry; do not mount this there.
 *
 * Touches the hash only when it starts with `#mdt=`, so `#k=` and `#token=` are never read or
 * rewritten here.
 */
export function TenantHandoff() {
  const { refresh } = useAuth();
  useEffect(() => {
    const marker = `#${HANDOFF_FRAGMENT}=`;
    const hash = window.location.hash;
    if (!hash.startsWith(marker)) return;
    let token = "";
    try {
      token = decodeURIComponent(hash.slice(marker.length));
    } catch {
      token = "";
    }
    try {
      if (token) localStorage.setItem("markdrop_token", token);
    } catch {
      /* storage blocked: stay signed out */
    }
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
    void refresh();
  }, [refresh]);
  return null;
}

export default TenantHandoff;
