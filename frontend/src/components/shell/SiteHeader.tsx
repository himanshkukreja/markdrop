"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Anchor, Button, Icon, MarkdropLogo, SkipLink, VisuallyHidden, cx } from "@/components/ui";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import CreateMenu from "@/components/CreateMenu";
import { useAuth } from "@/contexts/AuthContext";
import { getToken } from "@/lib/api";
import { HeaderAuthSlot } from "./AccountMenu";
import { MobileNav } from "./MobileNav";
import { NAV_LINKS } from "./links";
import { useMounted } from "./useLocation";

export type SiteHeaderVariant = "default" | "marketing" | "minimal";

export interface SiteHeaderProps {
  /**
   * - "default" (tools, app, 404, framed viewer): 56px, sticky, on bg with a hairline.
   *   Right: ThemeToggle · CreateMenu · Sign in / AccountMenu.
   * - "marketing" (/, /enterprise): 72px, transparent over the hero until 8px of scroll, then bg
   *   at 85% with a 12px backdrop blur and the hairline. Nav Enterprise · VS Code extension ↗ ·
   *   GitHub ↗; right: ThemeToggle · Sign in / AccountMenu · "Start writing" (primary).
   * - "minimal" (focus pages): the logo and ThemeToggle only.
   */
  variant?: SiteHeaderVariant;
  /** "contained" centres the row at 1280 (marketing, tools); "full" spans the viewport (app shell). */
  width?: "contained" | "full";
  /** Override the Create trigger; default primary on /dashboard, secondary elsewhere (REVAMP_PLAN 4.4). */
  createVariant?: "primary" | "secondary";
  className?: string;
}

/** Scrolled past `px`? false on the server and the first client render. */
function useScrolledPast(px: number, active: boolean): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!active) return;
    const on = () => setPast(window.scrollY > px);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [px, active]);
  return past;
}

/**
 * The global header (REVAMP_PLAN 4.2, PlayFinal / Landing / Dashboard boards). Starts with the
 * "Skip to content" link. Auth state is client-only (the server renders "Sign in", see
 * HeaderAuthSlot), so marketing pages stay static. No #anchors, no useSearchParams. Phones
 * (< 768px): logo · Create · Sign in or avatar · Menu (the Menu drawer carries the nav, sign in,
 * feedback and theme; signed-in people get it on marketing pages only). Below 360px Create is the
 * plus alone.
 */
export function SiteHeader({ variant = "default", width = "contained", createVariant, className }: SiteHeaderProps) {
  const pathname = usePathname() || "/";
  const { user, loading } = useAuth();
  const mounted = useMounted();
  const marketing = variant === "marketing";
  const minimal = variant === "minimal";
  const scrolled = useScrolledPast(8, marketing);
  const create = createVariant ?? (pathname === "/dashboard" ? "primary" : "secondary");
  // Phones show the Menu while signed out (or unknown) and always on marketing pages.
  const authPending = mounted && loading && !!getToken();
  const signedOut = !user && !authPending;
  const showPhoneMenu = marketing || signedOut;

  return (
    <header
      className={cx(
        "no-print sticky top-0 z-(--z-sticky) w-full shrink-0 border-b",
        marketing
          ? cx(
              "h-14 md:h-18 transition-[background-color,border-color,backdrop-filter] duration-(--duration-fast) ease-(--ease-out)",
              scrolled ? "border-border bg-bg/85 backdrop-blur-md" : "border-transparent bg-transparent",
            )
          : "h-14 border-border bg-bg",
        className,
      )}
    >
      <SkipLink />
      <div className="h-full w-full px-4 sm:px-6">
        <div className={cx("mx-auto flex h-full min-w-0 items-center gap-2", width === "contained" && (marketing ? "max-w-marketing" : "max-w-tool"))}>
          <MarkdropLogo size={24} className="shrink-0 md:hidden" />
          <MarkdropLogo size={28} className="hidden shrink-0 md:inline-flex" />

          {marketing && (
            <nav aria-label="Primary" className="ml-8 hidden items-center gap-1 lg:flex">
              {NAV_LINKS.map((l) => (
                <Anchor
                  key={l.href}
                  href={l.href}
                  {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  aria-current={!l.external && pathname === l.href ? "page" : undefined}
                  className="md-focus inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-body font-medium text-text-secondary no-underline hover:bg-surface-hover hover:text-text aria-[current=page]:text-text"
                >
                  {l.label}
                  {l.external && (
                    <>
                      <Icon name="external" size={14} className="text-text-muted" />
                      <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
                    </>
                  )}
                </Anchor>
              ))}
            </nav>
          )}

          <div className="ml-auto flex min-w-0 items-center gap-1 md:gap-2">
            {minimal ? (
              <ThemeToggle />
            ) : marketing ? (
              <>
                <ThemeToggle className="hidden md:inline-flex" />
                <CreateMenu variant="secondary" className="md:hidden max-md:[&_.md-create]:h-11" />
                <HeaderAuthSlot signInClassName="max-md:px-2" />
                <Button variant="primary" href="/new" className="hidden md:inline-flex">Start writing</Button>
                <MobileNav className="lg:hidden" />
              </>
            ) : (
              <>
                <ThemeToggle className="hidden md:inline-flex" />
                <CreateMenu variant={create} className="max-md:[&_.md-create]:h-11" />
                <HeaderAuthSlot signInClassName="max-md:px-2" />
                {showPhoneMenu && <MobileNav className="md:hidden" />}
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

export default SiteHeader;
