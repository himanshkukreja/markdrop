"use client";

import { Anchor, Badge, IconButton, cx } from "@/components/ui";
import { parseHex } from "@/components/tenant/branding";
import type { Site, SiteSummary } from "@/lib/docsSites";
import { thumbColours } from "./presets";
import { useSite } from "./SiteContext";

export type SiteSection = "pages" | "design" | "publish" | "settings";

/** The site's letter tile on its accent (the brand's when "Match my brand" is on). */
export function SiteTile({ site, size = 22 }: { site: Pick<SiteSummary, "name" | "preset" | "theme"> & { settings?: Site["settings"] }; size?: number }) {
  const brand = site.settings?.theme.brand;
  const accent = (brand?.enabled && (brand.accent || brand.colors?.[0])) || site.theme?.accent || null;
  const c = thumbColours(site.settings?.theme.preset ?? site.preset ?? site.theme?.preset, parseHex(accent) ? accent : null);
  const logo = brand?.enabled ? brand.logo_url : null;
  const box = { width: size, height: size, borderRadius: Math.max(4, Math.round(size * 0.27)) };
  if (logo) {
    return (
      <span className="grid shrink-0 place-items-center overflow-hidden bg-logo-well-light" style={box} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" className="size-full object-contain" />
      </span>
    );
  }
  return (
    <span className="grid shrink-0 place-items-center font-extrabold leading-none text-white" style={{ ...box, background: c.accent, fontSize: Math.round(size * 0.55) }} aria-hidden>
      {(site.name || "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

const TABS: Array<{ id: SiteSection; label: string; path: string }> = [
  { id: "pages", label: "Pages", path: "" },
  { id: "design", label: "Design", path: "/design" },
  { id: "publish", label: "Publishes", path: "/publish" },
  { id: "settings", label: "Settings", path: "/settings" },
];

/**
 * The studio's top bar (boards 4–7): back to the workspace's Docs sites, the site's tile and name,
 * the site tabs, then whatever the screen adds (a breadcrumb, a status badge) and its actions on the
 * right. Wraps on phones: the tabs get their own scrolling row.
 */
export function SiteBar({ section, crumb, status, actions, className }: {
  section: SiteSection | null;
  crumb?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  const { site, base, listHref, role } = useSite();
  return (
    <header className={cx("sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-3 py-2 sm:px-5", className)}>
      <IconButton icon="chevronLeft" label="Back to Docs sites" href={listHref} />
      <SiteTile site={site} />
      <span className="min-w-0 max-w-[40vw] truncate text-body-strong text-text sm:max-w-[240px]" dir="auto">{site.name}</span>
      <nav aria-label="Site" className="order-last -mx-1 flex w-full gap-1 overflow-x-auto px-1 md:order-none md:ml-3 md:w-auto">
        {TABS.map((t) => {
          const on = t.id === section;
          return (
            <Anchor
              key={t.id}
              href={`${base}${t.path}`}
              aria-current={on ? "page" : undefined}
              className={cx(
                "md-focus shrink-0 rounded-md px-2.5 py-1.5 text-body no-underline transition-colors",
                on ? "bg-surface-active font-semibold text-text" : "text-text-secondary hover:bg-surface-hover hover:text-text",
              )}
            >
              {t.label}
            </Anchor>
          );
        })}
      </nav>
      {crumb && <span className="hidden min-w-0 truncate text-body text-text-muted lg:inline" dir="auto">{crumb}</span>}
      {status}
      {role === "viewer" && <Badge size="sm" icon="eye">View only</Badge>}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export default SiteBar;
