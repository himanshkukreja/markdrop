"use client";

import { copyText, Icon, useToast } from "@/components/ui";
import { sectionUrl, setSectionHash } from "./navigate";

export interface HeadingAnchorProps {
  /** The heading's DOM id (`user-content-…`). */
  id: string;
  /** The heading text, for the accessible name. */
  label?: string;
  /** Hide the control (E2E documents: a section link without the key is useless, with it it leaks). */
  disabled?: boolean;
  /** Encrypted document: never touch the hash (implies nothing is rendered either). */
  encrypted?: boolean;
  /** Base of the copied link (default origin + pathname). */
  baseUrl?: string;
  className?: string;
}

/**
 * The link icon in a heading's left margin (REVAMP_PLAN 7.6 "Heading anchors"). Shows on hover of
 * the heading or on focus (always in the tab order). Click copies `<base>#<slug>` and toasts
 * "Link to section copied"; the address bar follows only when the hash holds no secret.
 * Render it as a sibling of the heading inside a `.md-heading-wrap` so the heading's accessible
 * name stays just its text.
 */
export function HeadingAnchor({ id, label, disabled, encrypted, baseUrl, className }: HeadingAnchorProps) {
  const toasts = useToast();
  if (disabled || encrypted) return null;
  async function copy() {
    const ok = await copyText(sectionUrl(id, baseUrl));
    if (ok) {
      toasts.success("Link to section copied");
      setSectionHash(id, { encrypted });
    } else {
      toasts.error("Couldn't copy the link. Copy it from the address bar instead.");
    }
  }
  return (
    <button
      type="button"
      className={["md-anchor no-print", className].filter(Boolean).join(" ")}
      aria-label={label ? `Copy link to section: ${label}` : "Copy link to section"}
      title="Copy link to section"
      onClick={copy}
    >
      <Icon name="link" size={16} />
    </button>
  );
}
