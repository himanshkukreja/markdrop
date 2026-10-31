"use client";

import { useEffect } from "react";
import { Anchor, Badge, Button, Icon, Spinner, cx } from "@/components/ui";
import { parseHex } from "@/components/tenant/branding";
import { guideEvents } from "@/lib/guidesEvents";
import { assetPreviewUrl, primaryAddress, type Site, type SiteSummary } from "@/lib/docsSites";
import { plural } from "./format";
import { thumbColours } from "./presets";
import { liveUrl, usePublishState } from "./PublishState";
import { useSite } from "./SiteContext";

export type SiteSection = "pages" | "design" | "publish" | "insights" | "settings";

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
      <span className="ph-no-capture grid shrink-0 place-items-center overflow-hidden bg-logo-well-light" style={box} aria-hidden>
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
  { id: "publish", label: "Publish", path: "/publish" },
  { id: "insights", label: "Insights", path: "/insights" },
  { id: "settings", label: "Settings", path: "/settings" },
];

/** The site bar's height on large screens, where it is one row (the editor's side panels sit under it). */
export const SITE_BAR_H = 52;
/** Studio header (56) + site bar: the top of anything sticky under both. */
export const STUDIO_CHROME_H = 56 + SITE_BAR_H;

/** Insights was opened on this device (the Publish screen's "Check what readers look for"). */
export const insightsSeenKey = (siteId: string) => `guides:insights-seen:${siteId}`;

/**
 * "Live · help.acme.com" (opens the live guide in a new tab), "Preview", and "Publish N changes"
 * ("Up to date" when there's nothing to publish, "Publishing… 40%" while a publish runs, "Send for
 * review" for an editor when the guide requires one). Publishing from any tab goes to the Publish
 * screen's progress.
 */
function PublishControls({ preview }: { preview: boolean }) {
  const { site, base, canEdit } = useSite();
  const { status, running, count, publish, starting, mustReview } = usePublishState();
  const host = primaryAddress(site);

  if (running) {
    const pct = running.progress?.percent ?? 2;
    return (
      <Anchor
        href={`${base}/publish`}
        className="md-focus inline-flex h-[30px] shrink-0 items-center gap-2 rounded-full bg-accent-soft px-3 text-[12px] font-semibold text-accent-text no-underline"
        aria-label={`Publishing, ${pct}%. Show the progress`}
      >
        <Spinner size={12} /> Publishing… {pct}%
      </Anchor>
    );
  }

  const live = site.status === "live";
  return (
    <>
      {live ? (
        <a
          href={liveUrl(host)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => guideEvents.liveOpened("site_bar")}
          className="md-focus inline-flex h-[30px] min-w-0 max-w-[260px] shrink items-center gap-1.5 rounded-full bg-success-soft px-2.5 text-[12px] font-semibold text-success no-underline hover:underline"
          title={`Open ${host} in a new tab`}
        >
          <span className="size-[7px] shrink-0 rounded-full bg-success" aria-hidden />
          <span className="min-w-0 truncate">Live · <span className="ph-sensitive ph-mask">{host}</span></span>
          <Icon name="external" size={12} className="shrink-0" />
          <span className="md-visually-hidden">(opens in a new tab)</span>
        </a>
      ) : (
        <span className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-full bg-surface-inset px-2.5 text-[12px] font-semibold text-text-secondary">
          <span className="size-[7px] rounded-full bg-border-strong" aria-hidden />
          {site.status === "unpublished" ? "Unpublished" : "Not published yet"}
        </span>
      )}
      {preview && <Button variant="secondary" size="sm" iconLeft="eye" href={`${base}?preview=1`} className="max-sm:hidden">Preview</Button>}
      {canEdit && (
        mustReview ? (
          <Button variant="primary" size="sm" iconLeft="send" href={`${base}/publish`} disabled={!count}>
            {count ? "Send for review" : "Up to date"}
          </Button>
        ) : status && count === 0 ? (
          <Button variant="secondary" size="sm" iconLeft="check" disabled>Up to date</Button>
        ) : (
          <Button variant="primary" size="sm" iconLeft="upload" loading={starting} disabled={!status} onClick={() => void publish({ from: "site_bar" })}>
            {status ? `Publish ${plural(count, "change")}` : "Publish"}
          </Button>
        )
      )}
    </>
  );
}

/**
 * The site's bar under the studio header: the site tabs (Publish with a count of the changes
 * waiting), then whatever the screen adds (a breadcrumb, a status badge, its own actions), then the
 * guide's publish controls. The site itself (name, switcher, workspace) is in the studio header
 * above. Wraps on phones: the tabs get their own scrolling row.
 *
 * `preview={false}`: the screen has its own Preview (the editor). `section={null}` (the import
 * screen): no publish controls.
 */
export function SiteBar({ section, crumb, status, actions, className, preview = true }: {
  section: SiteSection | null;
  crumb?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  preview?: boolean;
}) {
  const { site, base, role } = useSite();
  const { count } = usePublishState();

  useEffect(() => {
    if (section !== "insights") return;
    try { localStorage.setItem(insightsSeenKey(site.id), "1"); } catch { /* a convenience only */ }
  }, [section, site.id]);

  return (
    <div className={cx("sticky top-14 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-3 py-2 sm:px-5 lg:h-[52px] lg:flex-nowrap lg:py-0", className)}>
      <nav aria-label="Guide" className="order-last -mx-1 flex w-full gap-0.5 overflow-x-auto px-1 md:order-none md:w-auto md:shrink-0">
        {TABS.map((t) => {
          const on = t.id === section;
          const badge = t.id === "publish" && !on && count > 0 ? count : 0;
          return (
            <Anchor
              key={t.id}
              href={`${base}${t.path}`}
              aria-current={on ? "page" : undefined}
              className={cx(
                "md-focus inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-body no-underline transition-colors",
                on ? "bg-surface-active font-semibold text-text" : "text-text-secondary hover:bg-surface-hover hover:text-text",
              )}
            >
              {t.label}
              {badge > 0 && (
                <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-[5px] text-[11px] font-bold leading-none text-on-accent">
                  {badge > 99 ? "99+" : badge}
                  <span className="md-visually-hidden"> {badge === 1 ? "change" : "changes"} to publish</span>
                </span>
              )}
            </Anchor>
          );
        })}
      </nav>
      {crumb && <span className="ph-sensitive ph-mask hidden min-w-0 truncate text-body text-text-muted lg:inline" dir="auto" title={typeof crumb === "string" ? crumb : undefined}>{crumb}</span>}
      {status}
      {role === "viewer" && <Badge size="sm" icon="eye">View only</Badge>}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 lg:flex-nowrap">
        {actions}
        {section !== null && <PublishControls preview={preview} />}
      </div>
    </div>
  );
}

export default SiteBar;
