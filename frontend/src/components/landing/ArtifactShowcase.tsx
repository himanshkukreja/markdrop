"use client";

import Reveal from "./Reveal";

const TYPES = [
  { label: "HTML", tint: "from-orange-500/20 to-orange-500/5", ring: "ring-orange-500/30", text: "text-orange-400" },
  { label: "PDF", tint: "from-red-500/20 to-red-500/5", ring: "ring-red-500/30", text: "text-red-400" },
  { label: "Excel", tint: "from-emerald-500/20 to-emerald-500/5", ring: "ring-emerald-500/30", text: "text-emerald-400" },
  { label: "Word", tint: "from-blue-500/20 to-blue-500/5", ring: "ring-blue-500/30", text: "text-blue-400" },
  { label: "Site", tint: "from-teal-500/20 to-teal-500/5", ring: "ring-teal-500/30", text: "text-teal-400" },
];

export default function ArtifactShowcase() {
  return (
    <section className="py-16 sm:py-20">
      <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center [&>*]:min-w-0">
        {/* Copy — first on desktop, keeping the text/image alternation going */}
        <Reveal className="lg:order-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider bg-orange-500/10 text-orange-500 ring-1 ring-orange-500/25">
            Artifacts
          </span>
          <h2 className="mt-4 text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
            Share more than markdown
          </h2>
          <p className="mt-3 text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d] leading-relaxed">
            Paste an HTML page or drop in a PDF, spreadsheet, Word doc — even a
            zipped site with its own CSS and JS. You get one clean link that
            <span className="text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] font-medium"> renders </span>
            the file, instead of downloading it.
          </p>
          <ul className="mt-5 space-y-2.5 text-sm text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d]">
            {[
              "Rendered live — not a download prompt",
              "Runs on an isolated domain, so a page can never touch your account",
              "Password, expiry and view counts, same as any document",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <svg className="w-4 h-4 mt-0.5 shrink-0 text-orange-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                {t}
              </li>
            ))}
          </ul>
          <a
            href="/upload"
            className="mt-7 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-sm font-medium transition-colors"
          >
            Publish an artifact
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M7.3 14.7a1 1 0 010-1.4L10.58 10 7.3 6.7a1 1 0 111.4-1.4l4 4a1 1 0 010 1.4l-4 4a1 1 0 01-1.4 0z" clipRule="evenodd" />
            </svg>
          </a>
        </Reveal>

        {/* Browser mock showing a rendered artifact */}
        <Reveal className="lg:order-2">
          <div className="rounded-xl overflow-hidden border border-gray-300/70 dark:border-gray-700 vscode:border-[#3c3c3c] shadow-2xl shadow-orange-500/10 bg-[#0b1220]">
            <div className="flex items-center gap-2 px-3 py-2.5 bg-[#161f33] border-b border-white/5">
              <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <span className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 flex-1 truncate rounded-md bg-black/30 px-2.5 py-1 text-[11px] font-mono text-gray-400">
                markdrop.in/q3-dashboard
              </span>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex flex-wrap gap-1.5">
                {TYPES.map((t) => (
                  <span
                    key={t.label}
                    className={`rounded-md bg-gradient-to-b ${t.tint} ${t.ring} ${t.text} px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1`}
                  >
                    {t.label}
                  </span>
                ))}
              </div>

              {/* A rendered chart standing in for "your file, live" */}
              <div className="rounded-lg border border-white/5 bg-[#111c33] p-4">
                <div className="text-xs font-semibold text-gray-300">Revenue by region</div>
                {/* Bar heights are in px, not percentages. A percentage height
                    resolves against the parent's height, and the parent here was
                    a flex item with an indefinite height — so every bar computed
                    to zero and the chart rendered empty. */}
                <div className="mt-4 flex items-end gap-3">
                  {[
                    { px: 62, c: "from-orange-500 to-orange-400", l: "APAC" },
                    { px: 43, c: "from-orange-400 to-orange-300", l: "EMEA" },
                    { px: 96, c: "from-orange-500 to-orange-400", l: "AMER" },
                    { px: 70, c: "from-orange-400 to-orange-300", l: "LATAM" },
                  ].map((b) => (
                    <div key={b.l} className="flex-1 flex flex-col items-center gap-1.5">
                      <div
                        className={`w-full rounded-t bg-gradient-to-t ${b.c}`}
                        style={{ height: `${b.px}px` }}
                      />
                      <span className="text-[9px] text-gray-500">{b.l}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 text-[11px] text-gray-500">
                <svg className="w-3.5 h-3.5 text-emerald-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                </svg>
                Sandboxed on a separate domain
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
