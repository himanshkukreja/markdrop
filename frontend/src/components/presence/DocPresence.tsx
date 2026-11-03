"use client";

import type { usePresenceChannel } from "@/lib/presence";
import { PresenceStack } from "./PresenceStack";

/**
 * The stack for a document or file page, from its presence channel (lib/presence). Nothing until
 * the socket has said who's here, and nothing while the owner has "Show who's viewing" off.
 */
export function DocPresence({
  presence, signedIn, variant = "bar", corner, hideWhenAlone, className,
}: {
  presence: ReturnType<typeof usePresenceChannel>;
  /** Signed in: offer "Show me as anonymous". */
  signedIn: boolean;
  variant?: "bar" | "float";
  corner?: "bottom-right" | "top-right";
  hideWhenAlone?: boolean;
  className?: string;
}) {
  const snap = presence.snapshot;
  if (!snap || !snap.on) return null;
  return (
    <PresenceStack
      viewers={snap.viewers}
      me={snap.me}
      total={snap.total}
      countOnly={snap.countOnly}
      anon={signedIn && !snap.countOnly ? { on: presence.anon, onChange: presence.setAnon } : null}
      variant={variant}
      corner={corner}
      hideWhenAlone={hideWhenAlone}
      note="Shown live and never stored."
      className={className}
    />
  );
}
