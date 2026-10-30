import type { ThemePreset } from "@/lib/docsSites";
import { thumbColours } from "./presets";

/** The card's little drawing of the site in its theme (Main board): a sidebar, a page, a callout. */
export function SiteThumb({ preset, accent, className }: { preset?: ThemePreset; accent?: string | null; className?: string }) {
  const c = thumbColours(preset, accent);
  const bar = (w: number | string, h: number, bg: string, r = 3) => (
    <span className="block" style={{ width: w, height: h, borderRadius: r, background: bg }} />
  );
  return (
    <div aria-hidden className={`flex h-[132px] gap-2.5 p-3.5 ${className ?? ""}`} style={{ background: c.ground }}>
      {c.sidebar && (
        <div className="flex w-16 shrink-0 flex-col gap-1.5">
          {bar(40, 8, c.accent, 4)}
          {bar(56, 6, c.line)}
          {bar(48, 6, c.line)}
          {bar(52, 6, c.line)}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-[7px] rounded-lg p-3" style={{ background: c.card }}>
        {bar("60%", 10, c.ink, 4)}
        {bar("90%", 6, c.line)}
        {bar("80%", 6, c.line)}
        {bar("70%", 18, c.callout, 5)}
      </div>
    </div>
  );
}

export default SiteThumb;
