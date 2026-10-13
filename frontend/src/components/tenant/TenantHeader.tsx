"use client";

import { useEffect, useState } from "react";
import { Anchor, Avatar, Button, Dropdown, Skeleton, SkipLink, cx } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { getToken } from "@/lib/api";
import { signInUrlFor } from "@/lib/hosts";
import type { LogoWell, TenantChrome } from "./branding";
import { useTenant } from "./TenantProvider";

export interface TenantHeaderProps {
  /** Defaults to the `TenantProvider` value. */
  tenant?: TenantChrome | null;
  /**
   * The tenant path to come back to after signing in (e.g. "/handbook/onboarding/ab12cd").
   * Defaults to the current path, read after mount.
   */
  returnPath?: string;
  /** Hide the sign-in / account slot, e.g. while a gate shows its own sign-in button. */
  hideAuth?: boolean;
  className?: string;
}

/** Well background per D38. `null` follows the theme through `--tenant-logo-well` (set by TenantStyle). */
function wellClass(well: LogoWell | null): string {
  if (well === "light") return "bg-logo-well-light";
  if (well === "dark") return "bg-logo-well-dark";
  if (well === "checker") return "";
  return "bg-(--tenant-logo-well,var(--logo-well-dark))";
}

const CHECKER: React.CSSProperties = {
  background:
    "repeating-conic-gradient(var(--logo-well-light) 0 25%, color-mix(in oklab, var(--logo-well-light) 78%, var(--logo-well-dark)) 0 50%) 0 0 / 10px 10px",
};

/** The tenant's logo on its well, or its name as text when there is no logo (or it fails to load). */
export function TenantBrand({ tenant, className }: { tenant: TenantChrome; className?: string }) {
  const [broken, setBroken] = useState(false);
  const showLogo = !!tenant.logoUrl && !broken;
  return (
    <Anchor
      href="/"
      className={cx(
        "md-focus inline-flex min-h-11 min-w-0 items-center gap-2 rounded-md text-text no-underline",
        className,
      )}
    >
      {showLogo ? (
        <span
          className={cx("inline-flex h-9 shrink-0 items-center rounded-md px-2", wellClass(tenant.logoWell))}
          style={tenant.logoWell === "checker" ? CHECKER : undefined}
        >
          {/* A customer-hosted image of unknown size: next/image would need its host allow-listed. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={tenant.logoUrl!}
            alt={tenant.name}
            className="block h-6 w-auto max-w-36 object-contain"
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
          />
        </span>
      ) : (
        <span dir="auto" className="truncate text-h4 text-text">
          {tenant.name}
        </span>
      )}
    </Anchor>
  );
}

/**
 * The header on a workspace's own domain (REVAMP_PLAN 7.8, D23). The tenant's logo or name and a
 * way to sign in, nothing else: no Create, no GitHub, no theme toggle (the page follows the
 * system), never Markdrop's logo. Sign-in goes through markdrop.in's handoff (`signInUrlFor`),
 * which comes back to this host with a `#mdt=` session.
 */
export function TenantHeader({ tenant: override, returnPath, hideAuth, className }: TenantHeaderProps) {
  const fromContext = useTenant();
  const tenant = override === undefined ? fromContext : override;
  const { user, loading, logout } = useAuth();
  const [mounted, setMounted] = useState(false);
  const [path, setPath] = useState<string | null>(returnPath ?? null);

  useEffect(() => {
    setMounted(true);
    if (!returnPath) setPath(window.location.pathname || "/");
  }, [returnPath]);

  if (!tenant) return null;
  const authPending = mounted && loading && !!getToken();
  const signInHref = signInUrlFor(tenant.host, returnPath ?? path ?? "/");

  return (
    <header
      className={cx(
        "no-print sticky top-0 z-(--z-sticky) w-full shrink-0 border-b border-border bg-bg",
        tenant.accentColor && "border-t-2 border-t-accent",
        className,
      )}
    >
      <SkipLink />
      <div className="w-full px-4 sm:px-6">
        <div className="mx-auto flex h-14 min-w-0 max-w-tool items-center gap-3">
          <TenantBrand tenant={tenant} className="min-w-0" />

          {!hideAuth && (
            <div className="ml-auto flex shrink-0 items-center">
              {authPending ? (
                <Skeleton variant="circle" width={32} height={32} />
              ) : user ? (
                <Dropdown
                  align="right"
                  aria-label="Account"
                  trigger={
                    <button
                      type="button"
                      aria-label={`Signed in as ${user.email}`}
                      className="md-focus inline-flex size-11 items-center justify-center rounded-full"
                    >
                      <Avatar name={user.name || user.email} size="sm" />
                    </button>
                  }
                  items={[
                    { header: <span className="block max-w-60 truncate">{user.email}</span> },
                    { label: "Sign out", icon: "logOut", onClick: () => void logout() },
                  ]}
                />
              ) : (
                <Button
                  variant="secondary"
                  href={signInHref}
                  iconLeft="user"
                  className="max-w-[min(22rem,60vw)] max-md:h-11"
                >
                  <span className="sm:hidden">Sign in</span>
                  <span dir="auto" className="hidden truncate sm:inline">
                    Sign in to read {tenant.name}
                  </span>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default TenantHeader;
