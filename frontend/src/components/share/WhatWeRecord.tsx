"use client";

import { useEffect, useState } from "react";
import { Icon, Popover, cx } from "@/components/ui";
import { P2P_RELAY_LIVE } from "./relay";

/** D6 option A, verbatim (REVAMP_BUILD §5.5). */
export const D6_DISCLOSURE =
  "Your files go straight from your device to theirs and are never stored on our servers. We keep the name, type and size of the files, how many there were, a hashed IP, your account if you're signed in, and connection details (route, timing, browser).";
const RELAY_SENTENCE = "If a network blocks a direct path, an encrypted relay forwards the bytes and can't read them.";

/**
 * The "What we record" caption link and its Popover. `fromHash` opens it after mount when the URL
 * fragment is `#what-we-record` (the landing links to `/share#what-we-record`); the fragment is only
 * read, never rewritten.
 */
export default function WhatWeRecord({ fromHash, className, label = "What we record", arrow, placement = "bottom-start" }: {
  fromHash?: boolean;
  className?: string;
  label?: string;
  arrow?: boolean;
  placement?: "bottom-start" | "bottom-end" | "top-start" | "top-end";
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (fromHash && window.location.hash === "#what-we-record") setOpen(true);
  }, [fromHash]);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      title="What we record"
      width="min(340px, calc(100vw - 32px))"
      placement={placement}
      portal
      className={cx("inline-block align-baseline", className)}
      trigger={
        <button
          type="button"
          id={fromHash ? "what-we-record" : undefined}
          className="md-focus inline-flex scroll-mt-24 items-center gap-1 rounded-sm font-semibold text-accent-text underline-offset-2 hover:underline"
        >
          {label}
          {arrow && <Icon name="arrowRight" size={12} />}
        </button>
      }
    >
      <div className="space-y-2 text-caption text-text-secondary">
        <p>{D6_DISCLOSURE}</p>
        {P2P_RELAY_LIVE && <p>{RELAY_SENTENCE}</p>}
      </div>
    </Popover>
  );
}
