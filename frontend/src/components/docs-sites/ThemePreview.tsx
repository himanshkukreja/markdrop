import type { CSSProperties } from "react";
import { guideLayout } from "./guideTheme";
import type { ThemeInput } from "./presets";
import { previewTokens } from "./presets";

/**
 * The Design panel's live preview (Themes board, right column): a Quickstart page drawn in the
 * chosen preset, fonts, corners and accent, light or dark. A drawing of the engine's layout per
 * preset (sidebar or not, centred measure, the help center's search hero), not the engine itself,
 * with the theme builder's layout choices as the engine resolves them (guideTheme.ts guideLayout,
 * the Preview's engineInput path): header alignment and style, section tabs and their style, the
 * sidebar's style and colour, the search box's shape, cards, callouts, links, code theme, reading
 * size and the content column's width. Drawn as themes.css draws them on a published guide.
 */
export function ThemePreview({ theme, dark, name, logo }: { theme: ThemeInput; dark: boolean; name: string; logo?: string | null }) {
  const p = previewTokens(theme, dark);
  const L = guideLayout(theme);
  const short = name.replace(/\s+docs$/i, "") || name;
  const centred = L.headerAlign === "center";
  const tabs = L.sectionTabs;
  // The design system's medium radius, which pills, tabs and the sidebar's items use (--radius-md).
  const md = `min(${p.r}, 8px)`;
  const searchR = L.buttons === "square" ? `min(${p.r}, 4px)` : L.buttons === "pill" ? "999px" : p.r;
  const tab = (current: boolean): CSSProperties =>
    L.tabStyle === "pills"
      ? { padding: "4px 9px", borderRadius: md, ...(current ? { color: p.text, fontWeight: 600, background: p.soft } : {}) }
      : current
        ? { color: p.accentText, fontWeight: 600, boxShadow: `inset 0 -2px 0 ${L.tabStyle === "underline" ? p.accent : p.accentText}` }
        : {};
  const card: CSSProperties =
    L.cards === "flat" ? { border: "1px solid transparent", background: `color-mix(in oklab, ${p.text} 4%, ${p.card})` }
      : L.cards === "raised" ? { border: `1px solid color-mix(in oklab, ${p.line} 60%, transparent)`, background: p.card, boxShadow: "0 4px 12px rgba(15,23,42,.10)" }
        : { border: `1px solid ${p.line}`, background: p.card };
  const callout: CSSProperties =
    L.callouts === "bordered" ? { borderRadius: p.r, background: "transparent", border: `1px solid color-mix(in oklab, ${p.accentText} 45%, transparent)` }
      : L.callouts === "bar" ? { borderRadius: `0 ${md} ${md} 0`, background: p.soft, borderLeft: `3px solid ${p.accentText}` }
        : { borderRadius: p.r, background: p.soft, border: p.calloutBorder };
  const link: CSSProperties = L.links === "accent" ? { color: p.accentText } : L.links === "plain" ? { color: p.accentText, fontWeight: 600 } : { color: p.accentText, textDecoration: "underline" };
  const reading: CSSProperties = L.baseSize || L.lineHeight
    ? { fontSize: L.baseSize ? `${L.baseSize}px` : undefined, lineHeight: L.lineHeight ? String(L.lineHeight) : undefined }
    : {};
  const navItem = (current: boolean): CSSProperties =>
    L.sidebarStyle === "lines"
      ? { marginLeft: -1, paddingLeft: 12, borderLeft: `2px solid ${current ? p.accent : "transparent"}`, ...(current ? { color: p.accentText, fontWeight: 600 } : {}) }
      : !current ? {}
        : L.sidebarStyle === "plain" ? { color: p.accentText, fontWeight: 600 }
          : { margin: "0 -8px", padding: "4px 8px", fontWeight: 600, borderRadius: L.sidebarStyle === "pills" ? md : p.r, background: p.soft, color: p.accentText };
  const group = (label: string, items: Array<[string, boolean?]>, first = false) => (
    <>
      <span className={first ? "text-[11px] font-bold uppercase tracking-[.08em]" : "mt-2 text-[11px] font-bold uppercase tracking-[.08em]"} style={{ color: p.muted }}>{label}</span>
      <span className="flex flex-col gap-1.5" style={L.sidebarStyle === "lines" ? { marginLeft: 2, borderLeft: `1px solid ${p.line}`, gap: 0 } : undefined}>
        {items.map(([t, current]) => (
          <span key={t} className={L.sidebarStyle === "lines" ? "py-1" : undefined} style={navItem(!!current)} aria-current={current ? "page" : undefined}>{t}</span>
        ))}
      </span>
    </>
  );
  return (
    <div
      // ph-no-capture: the customer's site name and logo, like any preview, stay out of replays.
      className="ph-no-capture overflow-hidden rounded-xl border border-border shadow-md"
      style={{ background: p.bg, color: p.text, fontFamily: p.body }}
      role="img"
      aria-label={`Preview of ${name} in this theme, ${dark ? "dark" : "light"} mode`}
      data-header-align={L.headerAlign}
      data-header-style={L.headerStyle}
      data-sidebar={L.sidebarStyle ?? undefined}
    >
      <div
        className="flex items-center gap-2.5 px-[18px] py-3"
        style={{
          borderBottom: `1px solid ${L.headerStyle === "transparent" ? "transparent" : p.line}`,
          background: L.headerStyle === "transparent" ? p.bg : p.header,
        }}
      >
        {/* Centred from sm up only, like the engine's header (a phone's header keeps its brand left). */}
        <span className={centred ? "flex min-w-0 items-center gap-2.5 sm:ml-auto" : "flex min-w-0 items-center gap-2.5"}>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="size-[26px] object-contain" style={{ borderRadius: p.logoR }} />
          ) : (
            <span className="grid size-[26px] shrink-0 place-items-center text-[13px] font-extrabold" style={{ borderRadius: p.logoR, background: p.accent, color: p.onAccent }}>
              {short.charAt(0).toUpperCase()}
            </span>
          )}
          <strong className="text-[16px]" style={{ fontFamily: p.head }}>{short}</strong>
          <span style={{ color: p.muted }}>Docs</span>
        </span>
        {tabs ? (
          <span className="ml-3 hidden items-center gap-4 text-[13px] sm:flex" style={{ color: p.muted, gap: L.tabStyle === "pills" ? 4 : undefined }}>
            <span style={tab(true)}>Getting started</span><span style={tab(false)}>Guides</span><span style={tab(false)}>Reference</span>
          </span>
        ) : !p.sidebar && !p.hero && (
          <span className="ml-3 hidden items-center gap-4 text-[13px] sm:flex" style={{ color: p.muted, gap: L.tabStyle === "pills" ? 4 : undefined }}>
            <span style={L.tabStyle === "pills" ? tab(true) : { color: p.accentText, fontWeight: 600 }}>Guides</span><span style={tab(false)}>Reference</span><span style={tab(false)}>Changelog</span>
          </span>
        )}
        <span className="ml-auto hidden w-[220px] max-w-[40%] px-2.5 py-1.5 text-[13px] sm:block" style={{ borderRadius: searchR, border: `1px solid ${p.line}`, color: p.muted }}>
          Search or ask…
        </span>
      </div>
      {p.hero && (
        <div className="flex flex-col items-center gap-3 px-6 pb-7 pt-10 text-center" style={{ background: p.soft }}>
          <h3 className="m-0 text-[30px] leading-[38px]" style={{ fontFamily: p.head, fontWeight: p.headW }}>How can we help?</h3>
          <span className="w-[70%] px-3.5 py-3 text-left" style={{ borderRadius: searchR, background: p.bg, border: `1px solid ${p.line}`, color: p.muted }}>Search articles</span>
        </div>
      )}
      <div className="flex">
        {p.sidebar && (
          <div
            className="hidden w-[180px] shrink-0 flex-col gap-1.5 px-3.5 py-[18px] text-[13px] sm:flex"
            style={{ borderRight: `1px solid ${p.line}`, ...(p.sidebarBg ? { background: p.sidebarBg } : {}) }}
          >
            {group("Getting started", [["Welcome"], ["Quickstart", true], ["Key concepts"]], true)}
            {group("Guides", [["Connect Postgres"], ["Build a dashboard"]])}
          </div>
        )}
        <div
          className="flex min-w-0 flex-1 flex-col gap-3.5 px-5 pb-[30px] pt-[26px] sm:px-[30px]"
          style={{ maxWidth: L.contentWidth ? `${L.contentWidth}px` : p.measure, margin: p.center ? "0 auto" : undefined }}
          data-content-width={L.contentWidth ?? undefined}
        >
          <h3 className="m-0 text-[30px] leading-[38px]" style={{ fontFamily: p.head, fontWeight: p.headW }}>Quickstart</h3>
          <p className="m-0 text-[16px] leading-[25px]" style={{ color: p.muted }}>Set up your first project and invite your team in about ten minutes.</p>
          <p className="m-0 text-[15px] leading-[25px]" style={reading}>
            This guide walks you through creating a project, connecting a data source and sharing your{" "}
            <span style={link}>first dashboard</span>.
          </p>
          <div className="flex gap-2.5 px-3.5 py-3 text-[14px] leading-[22px]" style={callout}>
            <strong style={{ color: p.accentText }}>Note</strong>
            <span>You need an Admin role to connect data sources.</span>
          </div>
          <pre className="m-0 overflow-x-auto px-3.5 py-3 text-[13px]" style={{ borderRadius: p.r, background: p.code, color: p.codeText, fontFamily: p.mono }}>
            {`${short.toLowerCase().replace(/[^a-z0-9]+/g, "")} login\n${short.toLowerCase().replace(/[^a-z0-9]+/g, "")} projects create "Growth"`}
          </pre>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {[["Connect Postgres", "Read-only user, 5 minutes."], ["Alert rules", "Get pinged when a metric moves."]].map(([t, d]) => (
              <div key={t} className="p-3" style={{ borderRadius: p.r, ...card }}>
                <strong style={{ fontFamily: p.head }}>{t}</strong>
                <p className="m-0 mt-1 text-[13px]" style={{ color: p.muted }}>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ThemePreview;
