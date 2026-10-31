"use client";

import { Anchor, Badge, cx } from "@/components/ui";
import { parseHex } from "@/components/tenant/branding";
import { assetPreviewUrl, type Site, type SiteSummary } from "@/lib/docsSites";
import { thumbColours } from "./presets";
import { useSite } from "./SiteContext";

export type SiteSection = "pages" | "design" | "publish" | "settings";

/** The site's letter tile on its accent (the brand's when "Match my brand" is on). */
export function SiteTile({ site, size = 22 }: {
  site: Pick<SiteSummary, "id" | "name" | "preset"> & {
    settings?: { theme: { preset: Site["settings"]["theme"]["preset"]; brand?: Partial<Site["settings"]["theme"]["brand"]> } };
  };
  size?: number;
}) {
  const brand = site.settings?.theme.brand;
  const accent = (brand?.enabled && (brand.accent || brand.colors?.[0])) || null;
  const c = thumbColours(site.settings?.theme.preset ?? site.preset, parseHex(accent) ? accent : null);
  const logo = brand?.enabled ? assetPreviewUrl(site.id, brand.logo_url) : null;
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

/** The site bar's height on large screens, where it is one row (the editor's side panels sit under it). */
export const SITE_BAR_H = 52;
/** Studio header (56) + site bar: the top of anything sticky under both. */
export const STUDIO_CHROME_H = 56 + SITE_BAR_H;

/**
 * The site's bar under the studio header (boards 4–7): the site tabs, then whatever the screen
 * adds (a breadcrumb, a status badge) and its actions on the right. The site itself (name,
 * switcher, workspace) is in the studio header above. Wraps on phones: the tabs get their own
 * scrolling row.
 */
export function SiteBar({ section, crumb, status, actions, className }: {
  section: SiteSection | null;
  crumb?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  const { base, role } = useSite();
  return (
    <div className={cx("sticky top-14 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-3 py-2 sm:px-5 lg:h-[52px] lg:flex-nowrap lg:py-0", className)}>
      <nav aria-label="Guide" className="order-last -mx-1 flex w-full gap-1 overflow-x-auto px-1 md:order-none md:w-auto">
        {TABS.map((t) => {
          const on = t.id === section;
          return (
            <Anchor
              key={t.id}
              href={`${base}${t.path}`}
              aria-current={on ? "page" : undefined}
              className={cx(
                "md-focus shrink-0 rounded-md px-2.5 py-1.5 text-body no-underline transition-colors",
                on ? "bg-accent-soft font-semibold text-accent-text" : "text-text-secondary hover:bg-surface-hover hover:text-text",
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
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2 lg:flex-nowrap">{actions}</div>}
    </div>
  );
}

export default SiteBar;
