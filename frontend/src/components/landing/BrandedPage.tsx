/**
 * The page body inside every custom-domain mock.
 *
 * This used to be three grey bars and an empty rectangle, which is the exact
 * shape of a loading skeleton — so the graphic read as "still loading" rather
 * than "here is your document on your domain". Real words, a real heading and
 * real figures fix that, and they cost nothing: the mock is decorative either
 * way, but only one of the two says what the feature does.
 *
 * Accent handling has two modes. Given `hueClass`, accent-filled elements take
 * that class and inherit a CSS animation — that's how the landing mocks crossfade
 * between Markdrop's blue and a customer's purple. Given a plain `accent`, they
 * take it as a static inline colour.
 */
export default function BrandedPage({
  accent,
  hueClass,
  tone = "dark",
  compact = false,
}: {
  accent?: string;
  hueClass?: string;
  tone?: "dark" | "auto";
  compact?: boolean;
}) {
  // `auto` follows the page's own light/dark theme; `dark` is for mocks that sit
  // on a dark panel regardless of the visitor's theme.
  const muted = tone === "dark" ? "text-gray-500" : "text-gray-500 dark:text-gray-400";
  const body = tone === "dark" ? "text-gray-400" : "text-gray-600 dark:text-gray-400";
  const heading = tone === "dark" ? "text-gray-100" : "text-gray-900 dark:text-gray-100";
  const cell =
    tone === "dark"
      ? "bg-white/[0.04] border-white/10"
      : "bg-gray-50 dark:bg-white/[0.04] border-gray-200 dark:border-white/10";

  const accentStyle = hueClass ? undefined : { background: accent };
  const accentClass = hueClass ?? "";

  const KPIS = [
    { k: "ARR", v: "$4.2M", d: "+18%" },
    { k: "Net retention", v: "118%", d: "+6pt" },
    { k: "Burn", v: "$310k", d: "−9%" },
  ];

  return (
    <div className={compact ? "px-3.5 py-3.5" : "px-4 py-4"}>
      {/* Accent rule — the one element that is unmistakably "your colour" */}
      <div className={`h-1 w-10 rounded-full ${accentClass}`} style={accentStyle} />

      <h4 className={`mt-2.5 font-semibold tracking-tight ${heading} ${compact ? "text-[13px]" : "text-sm"}`}>
        Quarterly plan
      </h4>
      <p className={`mt-0.5 text-[10px] ${muted}`}>Updated 12 Sep · Finance · 4 min read</p>

      <p className={`mt-2.5 text-[10.5px] leading-[1.6] ${body}`}>
        Revenue grew 18% quarter over quarter, led by enterprise renewals in EMEA.
        Headcount stays flat through Q4 while we absorb the new support load.
      </p>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {KPIS.map((m) => (
          <div key={m.k} className={`rounded-md border px-2 py-1.5 ${cell}`}>
            <p className={`text-[8px] uppercase tracking-wide truncate ${muted}`}>{m.k}</p>
            <p className={`text-[12px] font-semibold leading-tight mt-0.5 ${heading}`}>{m.v}</p>
            <p className="text-[8px] text-emerald-500 leading-tight">{m.d}</p>
          </div>
        ))}
      </div>

      {!compact && (
        <div className={`mt-3 rounded-md border px-2.5 py-2 ${cell}`}>
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${accentClass}`} style={accentStyle} />
            <p className={`text-[9.5px] font-medium ${heading}`}>Next review — 3 October</p>
          </div>
          <p className={`mt-1 text-[9.5px] leading-snug ${body}`}>
            Board pack due the Friday before. Owner: Priya.
          </p>
        </div>
      )}
    </div>
  );
}
