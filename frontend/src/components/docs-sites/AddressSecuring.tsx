"use client";

import { Badge, Spinner, cx } from "@/components/ui";

/**
 * A new guide's free address (`<slug>.guides.markdrop.in`) for the minute or three after its first
 * publish, while Cloudflare issues its certificate (the site's `address_state` is "securing"):
 * opening it would fail with a browser TLS error, so every place that offers the address says so
 * instead of a link (Copy stays). PublishState polls the guide meanwhile and says when it opens.
 * The same visual language as an own domain's "Issuing certificate" (settings/domainStatus.tsx).
 */
export const SECURING_TITLE = "Securing your address";
export const SECURING_TEXT = "Usually 1–3 minutes. It opens as soon as it's ready.";
/** Copy while securing: the address is fine to share, it just doesn't open yet. */
export const SECURING_COPIED = "Copied. It opens in 1–3 minutes, once the address is secured.";

/** "Securing" with a lock: an address whose certificate is on its way. */
export function SecuringBadge({ className }: { className?: string }) {
  return (
    <Badge tone="info" size="sm" icon="lock" className={cx("shrink-0", className)} title={`${SECURING_TITLE}. ${SECURING_TEXT}`}>
      Securing
    </Badge>
  );
}

/**
 * "Securing your address. Usually 1–3 minutes. It opens as soon as it's ready." with a spinner,
 * announced politely. `short`: the title only (narrow places; the full text is its title).
 */
export function SecuringNote({ className, short, id }: { className?: string; short?: boolean; id?: string }) {
  return (
    <p id={id} role="status" className={cx("m-0 flex min-w-0 items-start gap-2 text-[13px] leading-5 text-text-secondary", className)} title={short ? SECURING_TEXT : undefined}>
      <Spinner size={14} className="mt-[3px] shrink-0 text-accent-text" />
      <span className="min-w-0">
        <strong className="font-semibold text-text">{SECURING_TITLE}{short ? "…" : "."}</strong>
        {short ? <span className="md-visually-hidden"> {SECURING_TEXT}</span> : <> {SECURING_TEXT}</>}
      </span>
    </p>
  );
}
