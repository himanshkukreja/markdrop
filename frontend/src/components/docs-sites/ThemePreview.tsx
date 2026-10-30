import type { ThemeInput } from "./presets";
import { previewTokens } from "./presets";

/**
 * The Design panel's live preview (Themes board, right column): a Quickstart page drawn in the
 * chosen preset, fonts, corners and accent, light or dark. A drawing of the engine's layout per
 * preset (sidebar or not, centred measure, the help center's search hero), not the engine itself.
 */
export function ThemePreview({ theme, dark, name, logo }: { theme: ThemeInput; dark: boolean; name: string; logo?: string | null }) {
  const p = previewTokens(theme, dark);
  const short = name.replace(/\s+docs$/i, "") || name;
  return (
    <div
      className="overflow-hidden rounded-xl border border-border shadow-md"
      style={{ background: p.bg, color: p.text, fontFamily: p.body }}
      role="img"
      aria-label={`Preview of ${name} in this theme, ${dark ? "dark" : "light"} mode`}
    >
      <div className="flex items-center gap-2.5 px-[18px] py-3" style={{ borderBottom: `1px solid ${p.line}`, background: p.header }}>
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
        {!p.sidebar && !p.hero && (
          <span className="ml-3 hidden gap-4 text-[13px] sm:flex" style={{ color: p.muted }}>
            <span style={{ color: p.accentText, fontWeight: 600 }}>Guides</span><span>Reference</span><span>Changelog</span>
          </span>
        )}
        <span className="ml-auto hidden w-[220px] max-w-[40%] px-2.5 py-1.5 text-[13px] sm:block" style={{ borderRadius: p.r, border: `1px solid ${p.line}`, color: p.muted }}>
          Search or ask…
        </span>
      </div>
      {p.hero && (
        <div className="flex flex-col items-center gap-3 px-6 pb-7 pt-10 text-center" style={{ background: p.soft }}>
          <h3 className="m-0 text-[30px] leading-[38px]" style={{ fontFamily: p.head, fontWeight: p.headW }}>How can we help?</h3>
          <span className="w-[70%] px-3.5 py-3 text-left" style={{ borderRadius: p.r, background: p.bg, border: `1px solid ${p.line}`, color: p.muted }}>Search articles</span>
        </div>
      )}
      <div className="flex">
        {p.sidebar && (
          <div className="hidden w-[180px] shrink-0 flex-col gap-1.5 px-3.5 py-[18px] text-[13px] sm:flex" style={{ borderRight: `1px solid ${p.line}` }}>
            <span className="text-[11px] font-bold uppercase tracking-[.08em]" style={{ color: p.muted }}>Getting started</span>
            <span>Welcome</span>
            <span className="-mx-2 px-2 py-1 font-semibold" style={{ borderRadius: p.r, background: p.soft, color: p.accentText }}>Quickstart</span>
            <span>Key concepts</span>
            <span className="mt-2 text-[11px] font-bold uppercase tracking-[.08em]" style={{ color: p.muted }}>Guides</span>
            <span>Connect Postgres</span>
            <span>Build a dashboard</span>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-3.5 px-5 pb-[30px] pt-[26px] sm:px-[30px]" style={{ maxWidth: p.measure, margin: p.center ? "0 auto" : undefined }}>
          <h3 className="m-0 text-[30px] leading-[38px]" style={{ fontFamily: p.head, fontWeight: p.headW }}>Quickstart</h3>
          <p className="m-0 text-[16px] leading-[25px]" style={{ color: p.muted }}>Set up your first project and invite your team in about ten minutes.</p>
          <p className="m-0 text-[15px] leading-[25px]">
            This guide walks you through creating a project, connecting a data source and sharing your{" "}
            <span style={{ color: p.accentText, textDecoration: "underline" }}>first dashboard</span>.
          </p>
          <div className="flex gap-2.5 px-3.5 py-3 text-[14px] leading-[22px]" style={{ borderRadius: p.r, background: p.soft, border: p.calloutBorder }}>
            <strong style={{ color: p.accentText }}>Note</strong>
            <span>You need an Admin role to connect data sources.</span>
          </div>
          <pre className="m-0 overflow-x-auto px-3.5 py-3 text-[13px]" style={{ borderRadius: p.r, background: p.code, color: p.codeText, fontFamily: p.mono }}>
            {`${short.toLowerCase().replace(/[^a-z0-9]+/g, "")} login\n${short.toLowerCase().replace(/[^a-z0-9]+/g, "")} projects create "Growth"`}
          </pre>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {[["Connect Postgres", "Read-only user, 5 minutes."], ["Alert rules", "Get pinged when a metric moves."]].map(([t, d]) => (
              <div key={t} className="p-3" style={{ borderRadius: p.r, border: `1px solid ${p.line}`, background: p.card }}>
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
