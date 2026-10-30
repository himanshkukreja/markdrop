"use client";

import { useEffect, useRef, useState } from "react";
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

/**
 * The tenant's logo and name, or its name alone when there is no logo (or it fails to load).
 *
 * A mark-style logo (square-ish) sits next to the site's name, the way people recognise a site;
 * a wide wordmark already spells the name, so it stands alone, a little larger. The logo gets a
 * tile only when the workspace chose one (light, dark or checker, for a logo that needs a
 * particular background to read); with no choice it sits straight on the header, so a light
 * logo is not boxed in a stray white square.
 */
export function TenantBrand({ tenant, className }: { tenant: TenantChrome; className?: string }) {
  const [broken, setBroken] = useState(false);
  // Decided from the image itself once it loads: ≥ 2.2:1 is a wordmark.
  const [wordmark, setWordmark] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const measure = (img: HTMLImageElement | null) => {
    if (img && img.naturalHeight > 0) setWordmark(img.naturalWidth / img.naturalHeight >= 2.2);
  };
  // A cached logo can finish loading before hydration, when React's onLoad never fires.
  useEffect(() => {
    if (imgRef.current?.complete) measure(imgRef.current);
  }, [tenant.logoUrl]);
  const showLogo = !!tenant.logoUrl && !broken;
  const tiled = showLogo && tenant.logoWell !== null;
  const showName = !showLogo || !wordmark;
  return (
    <Anchor
      href="/"
      className={cx(
        "md-focus inline-flex min-h-11 min-w-0 items-center gap-2.5 rounded-md text-text no-underline",
        className,
      )}
    >
      {showLogo && (
        <span
          className={cx(
            "inline-flex shrink-0 items-center justify-center",
            tiled && "h-9 rounded-lg px-1.5 ring-1 ring-border",
            tiled && wellClass(tenant.logoWell),
          )}
          style={tenant.logoWell === "checker" ? CHECKER : undefined}
        >
          {/* A customer-hosted image of unknown size: next/image would need its host allow-listed. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={tenant.logoUrl!}
            alt={showName ? "" : tenant.name}
            className={cx("block w-auto object-contain", wordmark ? "h-7 max-w-44" : "h-7 max-w-7 rounded-md")}
            referrerPolicy="no-referrer"
            ref={imgRef}
            onLoad={(e) => measure(e.currentTarget)}
            onError={() => setBroken(true)}
          />
        </span>
      )}
      {showName && (
        <span dir="auto" className="truncate text-[15px] font-semibold leading-6 text-text">
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
  // On a customer's domain the API answers /me with the display name only (never the address).
  const who = user ? user.name || user.email || "" : "";
  const signInHref = signInUrlFor(tenant.host, returnPath ?? path ?? "/");

  return (
    <header
      className={cx(
        // A layer above the sticky document bar under it, so this header's menus open over the bar.
        "no-print sticky top-0 z-[calc(var(--z-sticky)+1)] w-full shrink-0 border-b border-border bg-bg",
        tenant.accentColor && "border-t-2 border-t-accent",
        className,
      )}
    >
      <SkipLink />
      {/* The same container as the document bar below it (DocumentBar), so the brand and the
          document's title line up on one left edge. */}
      <div className="w-full">
        <div className="mx-auto flex h-14 min-w-0 max-w-marketing items-center gap-3 px-4 sm:px-6">
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
                      aria-label={who ? `Signed in as ${who}` : "Signed in"}
                      className="md-focus inline-flex size-11 items-center justify-center rounded-full"
                    >
                      <Avatar name={who || "?"} size="sm" />
                    </button>
                  }
                  items={[
                    { header: <span className="block max-w-60 truncate">{who || "Signed in"}</span> },
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
