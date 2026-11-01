"use client";

/**
 * The way into a locked private section: the docs edge's sign-in page for its rule
 * (`/_access/page`, docs-platform/edge/readers.mjs), which comes back to this page once the reader
 * is in. The link is a plain address, so it works before hydration too (it then returns home).
 */
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui";

const LABELS: Record<string, string> = { members: "Sign in", people: "Sign in with email", password: "Enter password" };

export function LockedAction({ rule, kind }: { rule: string; kind: string }) {
  const base = `/_access/page?rule=${encodeURIComponent(rule)}`;
  const [href, setHref] = useState(base);
  useEffect(() => {
    setHref(`${base}&next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [base]);
  const label = LABELS[kind];
  if (!label) return null;
  return (
    <a className="dx-locked__action" href={href} rel="nofollow">
      <Icon name="lock" />
      {label}
    </a>
  );
}
