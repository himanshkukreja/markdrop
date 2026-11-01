"use client";

import { useEffect, useState } from "react";
import { Anchor, Badge, Button, Icon, Spinner, cx } from "@/components/ui";
import { guideEvents } from "@/lib/guidesEvents";
import { getFixCount } from "@/lib/guideFixes";
import { assetPreviewUrl, primaryAddress, type SiteSummary, type SiteTheme } from "@/lib/docsSites";
import { plural } from "./format";
import { opensDark } from "./guideTheme";
import { previewTokens } from "./presets";
import { liveUrl, usePublishState } from "./PublishState";
import { useSite } from "./SiteContext";

export type SiteSection = "pages" | "fixes" | "changelog" | "design" | "publish" | "insights" | "settings";

/**
 * The site's letter tile on its accent, as the guide draws it (presets.ts previewTokens: the
 * brand's when "Match my brand" is on, a custom theme's when it sets one), in the guide's opening mode.
 */
export function SiteTile({ site, size = 22 }: {
  site: Pick<SiteSummary, "id" | "name" | "preset"> & {
    settings?: { theme: Pick<SiteTheme, "preset"> & Partial<Pick<SiteTheme, "mode" | "custom">> & { brand?: Partial<SiteTheme["brand"]> } };
  };
  size?: number;
}) {
  const theme = site.settings?.theme;
  const brand = theme?.brand;
  const look = { preset: theme?.preset ?? site.preset, mode: theme?.mode };
  const c = previewTokens({
    ...look,
    brand: { enabled: !!brand?.enabled, colors: brand?.colors ?? [], accent: brand?.accent ?? null, accent_dark: brand?.accent_dark ?? null },
    fonts: {},
    corners: null,
    custom: theme?.custom ?? null,
  }, opensDark(look));
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
    <span className="grid shrink-0 place-items-center font-extrabold leading-none" style={{ ...box, background: c.accent, color: c.onAccent, fontSize: Math.round(size * 0.55) }} aria-hidden>
      {(site.name || "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

const TABS: Array<{ id: SiteSection; label: string; path: string }> = [
  { id: "pages", label: "Pages", path: "" },
  { id: "fixes", label: "Fix list", path: "/fixes" },
  { id: "changelog", label: "Changelog", path: "/changelog" },
  { id: "design", label: "Design", path: "/design" },
  { id: "publish", label: "Publish", path: "/publish" },
  { id: "insights", label: "Insights", path: "/insights" },
  { id: "settings", label: "Settings", path: "/settings" },
];

/** The site bar's height on large screens, where it is one row (the editor's side panels sit under it). */
export const SITE_BAR_H = 52;
/** Studio header (56) + site bar: the top of anything sticky under both. */
export const STUDIO_CHROME_H = 56 + SITE_BAR_H;

/** The Fix list's open count per guide, shared by every tab's site bar (re-read at most every 30 s). */
const fixCounts = new Map<string, { n: number; at: number }>();

function useFixCount(siteId: string, on: boolean): number {
  const [n, setN] = useState(() => fixCounts.get(siteId)?.n ?? 0);
  useEffect(() => {
    if (!on) return;
    const hit = fixCounts.get(siteId);
    if (hit && Date.now() - hit.at < 30_000) { setN(hit.n); return; }
    let live = true;
    getFixCount(siteId).then((c) => {
      fixCounts.set(siteId, { n: c.open, at: Date.now() });
      if (live) setN(c.open);
    }).catch(() => {});
    return () => { live = false; };
  }, [siteId, on]);
  return n;
}

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
          className="md-focus inline-flex h-[30px] min-w-0 max-w-[340px] shrink items-center gap-1.5 rounded-full bg-success-soft px-2.5 text-[12px] font-semibold text-success no-underline hover:underline"
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
  const fixes = useFixCount(site.id, site.settings.insights?.enabled !== false && (site.status === "live" || !!site.last_published_at));

  useEffect(() => {
    if (section !== "insights") return;
    try { localStorage.setItem(insightsSeenKey(site.id), "1"); } catch { /* a convenience only */ }
  }, [section, site.id]);

  // The guide's layout stays mounted across tabs, so the window keeps the last tab's scroll and the
  // next one would open part-way down. A new tab starts at the top, unless the address asks for a
  // section (#…).
  useEffect(() => {
    if (!window.location.hash) window.scrollTo({ top: 0 });
  }, [section]);

  return (
    <div className={cx("sticky top-14 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-3 py-2 sm:px-5 lg:h-[52px] lg:flex-nowrap lg:py-0", className)}>
      <nav aria-label="Guide" className="relative order-last -mx-1 flex w-full gap-0.5 overflow-x-auto px-1 md:order-none md:w-auto md:shrink-0">
        {TABS.map((t) => {
          const on = t.id === section;
          const badge = t.id === "publish" && !on && count > 0 ? count : t.id === "fixes" && fixes > 0 ? fixes : 0;
          return (
            <Anchor
              key={t.id}
              href={`${base}${t.path}`}
              aria-current={on ? "page" : undefined}
              className={cx(
                "md-focus relative inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-body no-underline transition-colors",
                on ? "bg-surface-active font-semibold text-text" : "text-text-secondary hover:bg-surface-hover hover:text-text",
              )}
            >
              {t.label}
              {badge > 0 && (
                <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-[5px] text-[11px] font-bold leading-none text-on-accent">
                  {badge > 99 ? "99+" : badge}
                  <span className="md-visually-hidden"> {t.id === "fixes" ? (badge === 1 ? "thing to fix" : "things to fix") : badge === 1 ? "change" : "changes"}{t.id === "fixes" ? "" : " to publish"}</span>
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
