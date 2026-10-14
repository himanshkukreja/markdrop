"use client";

import { Anchor, MarkdropMark } from "@/components/ui";
import { TenantFooter, useTenant } from "@/components/tenant";

/**
 * The end of a document (D18): a hairline, the mark, "Published with Markdrop" and "Publish your
 * own" → /new. On a workspace's own domain the tenant footer stands in for it (its own name, and
 * "Published with Markdrop" only when the workspace shows Markdrop branding) — never "Publish your
 * own" there.
 */
export function Colophon() {
  const tenant = useTenant();
  if (tenant) return <TenantFooter className="no-print mt-16" />;
  return (
    <footer className="no-print mt-16 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-6 text-caption text-text-muted">
      <MarkdropMark size={20} />
      <span>Published with Markdrop</span>
      <span aria-hidden>·</span>
      <Anchor href="/new" className="font-semibold text-accent-text underline-offset-4 hover:underline">
        Publish your own
      </Anchor>
    </footer>
  );
}
