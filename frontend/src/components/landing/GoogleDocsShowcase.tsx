"use client";

import Reveal from "./Reveal";

const STEPS: [string, string][] = [
  ["Connect once", "Link your Google account from the dashboard. Markdrop only gets access to the Docs it creates — nothing else in your Drive."],
  ["Export in one click", "Hit “Google Docs” on any document. Your markdown becomes a fully-formatted Google Doc — headings, bold, lists, tables, links and code blocks all intact."],
  ["Keep it in sync", "Edit the markdown later and click “Update Doc”. The same Google Doc is refreshed in place — your markdown stays the source of truth."],
];

export default function GoogleDocsShowcase() {
  return (
    <section className="py-16 sm:py-20">
      <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center [&>*]:min-w-0">
        {/* Copy */}
        <Reveal className="lg:order-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 vscode:text-[#4fc1ff]">
            Google Docs · Export &amp; sync
          </span>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
            Turn your markdown into a Google Doc.
          </h2>
          <p className="mt-4 text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0] leading-relaxed">
            Write in markdown, share it as a polished{" "}
            <span className="font-medium text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4]">Google Doc</span> in one click —
            ready to comment on, hand off, or drop into a report. Change the markdown and push
            the update to the same Doc anytime.
          </p>

          <ol className="mt-6 space-y-4">
            {STEPS.map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                <span className="text-sm text-gray-700 dark:text-gray-300 vscode:text-[#c8c8c8]">
                  <strong className="font-semibold text-gray-900 dark:text-white vscode:text-[#e8e8e8]">{t}.</strong> {d}
                </span>
              </li>
            ))}
          </ol>

          <p className="mt-6 text-xs text-gray-500 dark:text-gray-500 leading-relaxed">
            Under the hood: Markdrop uses Google&apos;s own markdown importer, so formatting renders
            natively in Docs. Your Google credentials are encrypted at rest and revocable anytime.
          </p>

          <div className="mt-8">
            <a
              href="/dashboard"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
            >
              Export from your dashboard
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </a>
          </div>
        </Reveal>

        {/* Google Doc window mock — adapts to light / dark / vscode themes */}
        <Reveal className="lg:order-1">
          <div className="rounded-xl overflow-hidden border border-gray-300/70 dark:border-gray-700 vscode:border-[#3c3c3c] shadow-2xl shadow-blue-500/10 bg-white dark:bg-[#1e1e1e] vscode:bg-[#252526]">
            {/* Docs title bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[#f1f3f4] dark:bg-[#2a2a2a] vscode:bg-[#333333] border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c]">
              <svg className="w-4 h-4 text-[#4285f4]" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm0 2l4 4h-4V4zM8 13h8v1.5H8V13zm0 3h8v1.5H8V16zm0-6h4v1.5H8V10z" />
              </svg>
              <span className="text-xs font-medium text-gray-700 dark:text-gray-200 vscode:text-[#d4d4d4]">Release Notes</span>
              <span className="ml-1 text-[10px] text-gray-400 dark:text-gray-500">Google Docs</span>
              <span className="ml-auto flex items-center gap-1 text-[10px] text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-500/15 rounded-full px-2 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Synced
              </span>
            </div>

            {/* Toolbar hint */}
            <div className="flex items-center gap-3 px-4 py-1.5 bg-white dark:bg-[#252526] vscode:bg-[#2d2d2d] border-b border-gray-100 dark:border-gray-800 vscode:border-[#3c3c3c] text-[11px] text-gray-400 dark:text-gray-500">
              <span className="font-serif">Normal text</span>
              <span className="font-bold">B</span>
              <span className="italic">I</span>
              <span className="underline">U</span>
              <span>•</span>
              <span>1.</span>
            </div>

            {/* Rendered document body */}
            <div className="px-6 sm:px-8 py-6 text-gray-800 dark:text-gray-300 vscode:text-[#c8c8c8] max-h-[22rem] overflow-hidden">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white vscode:text-[#e8e8e8]">Release Notes</h1>
              <p className="mt-3 text-[13.5px] leading-relaxed text-gray-700 dark:text-gray-300 vscode:text-[#c8c8c8]">
                Markdrop <span className="font-bold">v2</span> is live. Highlights below.
              </p>
              <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-white vscode:text-[#e8e8e8]">What&apos;s new</h2>
              <ul className="mt-2 space-y-1 text-[13.5px] text-gray-700 dark:text-gray-300 vscode:text-[#c8c8c8] list-disc pl-5 marker:text-blue-500">
                <li>Publish markdown from VS Code</li>
                <li>Two-way sync on save</li>
                <li>One-click <span className="font-medium text-gray-900 dark:text-gray-100 vscode:text-[#e8e8e8]">Google Docs</span> export</li>
              </ul>
              <table className="mt-4 w-full text-[12.5px] border-collapse">
                <thead>
                  <tr className="bg-gray-50 dark:bg-white/5">
                    <th className="border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] px-2 py-1 text-left font-semibold text-gray-800 dark:text-gray-200">Feature</th>
                    <th className="border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] px-2 py-1 text-left font-semibold text-gray-800 dark:text-gray-200">Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] px-2 py-1">Docs export</td>
                    <td className="border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] px-2 py-1 text-green-700 dark:text-green-400">Shipped</td>
                  </tr>
                  <tr>
                    <td className="border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] px-2 py-1">Live sync</td>
                    <td className="border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] px-2 py-1 text-amber-600 dark:text-amber-400">Coming soon</td>
                  </tr>
                </tbody>
              </table>
              <pre className="mt-4 rounded-md bg-[#f6f8fa] dark:bg-[#161616] vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] px-3 py-2 text-[12px] font-mono text-gray-700 dark:text-gray-300 vscode:text-[#c8c8c8] overflow-hidden">npx markdrop publish notes.md</pre>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
