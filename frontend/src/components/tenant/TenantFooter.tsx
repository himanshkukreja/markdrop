"use client";

import { cx } from "@/components/ui";
import type { TenantChrome } from "./branding";
import { useTenant } from "./TenantProvider";

/**
 * The quiet footer on a workspace's own domain: its name, and the caption "Published with
 * Markdrop" unless the workspace hides Markdrop branding (REVAMP_PLAN 7.8, D18).
 */
export function TenantFooter({ tenant: override, className }: { tenant?: TenantChrome | null; className?: string }) {
  const fromContext = useTenant();
  const tenant = override === undefined ? fromContext : override;
  if (!tenant) return null;
  return (
    <footer className={cx("no-print mt-auto w-full border-t border-border px-4 sm:px-6", className)}>
      <div className="mx-auto flex min-w-0 max-w-tool flex-wrap items-center justify-between gap-x-6 gap-y-2 py-6 text-caption text-text-muted">
        <span dir="auto" className="min-w-0 truncate">{tenant.name}</span>
        {!tenant.hideMarkdropBranding && (
          <span>
            Published with{" "}
            <a
              href="https://markdrop.in"
              className="md-focus rounded-sm text-text-secondary underline decoration-border-strong underline-offset-2 hover:text-text"
            >
              Markdrop
            </a>
          </span>
        )}
      </div>
    </footer>
  );
}

export default TenantFooter;
