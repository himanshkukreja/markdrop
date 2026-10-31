"use client";

import { cx } from "@/components/ui";
import { assetPreviewUrl, type SiteBrand, type SiteSummary, type SummaryTheme } from "@/lib/docsSites";
import { useTheme } from "@/lib/theme";
import { previewTokens } from "../presets";

/** Light or dark, as the guide shows it: its own mode, or (both) the one you're looking at the app in. */
export function usePreviewDark(theme: SummaryTheme | undefined): boolean {
  const { resolved } = useTheme();
  if (theme?.mode === "dark") return true;
  if (theme?.mode === "light") return false;
  return resolved === "dark";
}

function tokensFor(site: SiteSummary, dark: boolean) {
  const theme = site.theme ?? { preset: site.preset, mode: "both" as const, brand: { enabled: false, colors: [] } };
  return previewTokens({
    preset: theme.preset ?? site.preset,
    brand: { ...theme.brand, colors: theme.brand.colors ?? [] } as SiteBrand,
    fonts: {},
    corners: theme.corners ?? null,
  }, dark);
}

/** The guide's logo (Match my brand), else its initial on the accent. */
export function GuideMark({ site, size, dark }: { site: SiteSummary; size: number; dark: boolean }) {
  const t = tokensFor(site, dark);
  const brand = site.theme?.brand;
  const logo = brand?.enabled ? assetPreviewUrl(site.id, (dark && brand.logo_dark_url) || brand.logo_url) : null;
  const box = { width: size, height: size, borderRadius: Math.max(4, Math.round(size * 0.27)) };
  if (logo) {
    return (
      <span className="ph-no-capture grid shrink-0 place-items-center overflow-hidden" style={{ ...box, background: t.header }} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" className="size-full object-contain" loading="lazy" />
      </span>
    );
  }
  return (
    <span className="grid shrink-0 place-items-center font-extrabold leading-none" style={{ ...box, background: t.accent, color: t.onAccent, fontSize: Math.round(size * 0.6) }} aria-hidden>
      {(site.name || "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * The card's little drawing of the guide in its own theme (preset palette, light or dark, the
 * brand accent and logo when "Match my brand" is on): header with its name and search, a sidebar
 * when the theme has one, a page title, lines and a callout. Decorative (aria-hidden).
 */
export function GuidePreview({ site, className }: { site: SiteSummary; className?: string }) {
  const dark = usePreviewDark(site.theme);
  const t = tokensFor(site, dark);
  const bar = (w: number | string, h: number, bg: string, r = 3) => <span className="block shrink-0" style={{ width: w, height: h, borderRadius: r, background: bg }} />;
  return (
    <div aria-hidden className={cx("ph-no-capture flex h-[132px] flex-col overflow-hidden rounded-t-[10px] border border-b-0", className)} style={{ background: t.bg, borderColor: t.line }}>
      <div className="flex h-[26px] shrink-0 items-center gap-1.5 border-b px-2.5" style={{ background: t.header, borderColor: t.line }}>
        <GuideMark site={site} size={14} dark={dark} />
        <span className="ph-sensitive ph-mask min-w-0 truncate text-[10px] font-bold leading-none" style={{ color: t.text, fontFamily: t.head }} dir="auto">{site.name}</span>
        <span className="flex-1" />
        {bar(56, 12, t.line, 6)}
      </div>
      <div className="flex min-h-0 flex-1 gap-2.5 p-2.5">
        {t.sidebar && (
          <div className="flex w-[54px] shrink-0 flex-col gap-[5px]">
            {bar(38, 5, t.accentText)}
            {bar(46, 5, t.line)}
            {bar(30, 5, t.line)}
            {bar(42, 5, t.line)}
          </div>
        )}
        <div className={cx("flex min-w-0 flex-1 flex-col gap-1.5", !t.sidebar && "mx-auto max-w-[78%]")}>
          {bar("70%", 9, t.text)}
          {bar("92%", 5, t.line)}
          {bar("84%", 5, t.line)}
          <span className="mt-0.5 block h-[22px] w-full shrink-0" style={{ background: t.soft, borderLeft: `3px solid ${t.accent}`, borderRadius: `min(${t.r}, 6px)` }} />
        </div>
      </div>
    </div>
  );
}

export default GuidePreview;
