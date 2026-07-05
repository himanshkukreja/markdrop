"use client";

import Reveal from "./Reveal";

const SECTIONS = ["Title", "Badges", "Features", "Installation", "Flowchart", "License"];

const POINTS: [string, string][] = [
  ["45+ sections", "Everything a README needs — titles, badges, install, usage, API tables — plus Mermaid diagrams, charts and KaTeX math."],
  ["Drag to reorder", "Rearrange sections by dragging; edit each one's markdown inline."],
  ["Live rendered preview", "See the assembled README exactly as it'll look — diagrams and math included."],
  ["Publish or download", "One click to a shareable markdrop.in link, or export a README.md file."],
];

export default function BuilderShowcase() {
  return (
    <section className="py-16 sm:py-20">
      <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">
        {/* Copy */}
        <Reveal>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-300 vscode:text-[#4ec9b0]">
            README builder · drag &amp; drop
          </span>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
            Build a README without staring at a blank file.
          </h2>
          <p className="mt-4 text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0] leading-relaxed">
            Pick from 45+ ready-made section templates, drag them into order, and edit the markdown
            with a live preview beside you. When it&apos;s ready, publish it to a{" "}
            <span className="font-mono text-teal-600 dark:text-teal-400 vscode:text-[#4ec9b0]">markdrop.in</span>{" "}
            link or download the <span className="font-mono">.md</span>.
          </p>

          <ul className="mt-6 space-y-3">
            {POINTS.map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <svg className="w-5 h-5 mt-0.5 shrink-0 text-teal-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                <span className="text-sm text-gray-700 dark:text-gray-300 vscode:text-[#c8c8c8]">
                  <strong className="font-semibold text-gray-900 dark:text-white vscode:text-[#e8e8e8]">{t}.</strong> {d}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-8">
            <a
              href="/builder"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
            >
              Open the builder
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </a>
          </div>
        </Reveal>

        {/* Builder UI mock */}
        <Reveal>
          <div className="rounded-xl overflow-hidden border border-gray-300/70 dark:border-gray-700 vscode:border-[#3c3c3c] shadow-2xl shadow-teal-500/10 bg-white dark:bg-[#1e1e1e] vscode:bg-[#252526]">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[#f1f3f4] dark:bg-[#2a2a2a] vscode:bg-[#333333] border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c]">
              <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <span className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 text-xs font-mono text-gray-500 dark:text-[#9d9d9d]">README builder</span>
              <span className="ml-auto text-[10px] rounded-full bg-teal-100 dark:bg-teal-500/15 text-teal-700 dark:text-teal-300 px-2 py-0.5">Live</span>
            </div>

            <div className="grid grid-cols-[7.5rem_1fr] min-h-[18rem]">
              {/* Section list */}
              <div className="border-r border-gray-100 dark:border-gray-800 vscode:border-[#3c3c3c] p-2 space-y-1.5 bg-gray-50/60 dark:bg-gray-900/30 vscode:bg-[#1e1e1e]">
                {SECTIONS.map((s, i) => (
                  <div
                    key={s}
                    className={`flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] ${
                      i === 4
                        ? "border-teal-400/60 bg-teal-50 dark:bg-teal-950/30 text-teal-700 dark:text-teal-300"
                        : "border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900/50 vscode:bg-[#252526] text-gray-600 dark:text-gray-300 vscode:text-[#c8c8c8]"
                    }`}
                  >
                    <svg className="w-2.5 h-2.5 text-gray-300 dark:text-gray-600 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <circle cx="7" cy="5" r="1.3" /><circle cx="13" cy="5" r="1.3" />
                      <circle cx="7" cy="10" r="1.3" /><circle cx="13" cy="10" r="1.3" />
                      <circle cx="7" cy="15" r="1.3" /><circle cx="13" cy="15" r="1.3" />
                    </svg>
                    <span className="truncate">{s}</span>
                  </div>
                ))}
              </div>

              {/* Rendered preview */}
              <div className="p-4 text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] overflow-hidden">
                <h1 className="text-lg font-bold">My Project</h1>
                <div className="mt-2 flex gap-1.5">
                  <span className="text-[9px] rounded bg-green-600 text-white px-1.5 py-0.5">MIT</span>
                  <span className="text-[9px] rounded bg-blue-600 text-white px-1.5 py-0.5">v1.0.0</span>
                  <span className="text-[9px] rounded bg-amber-500 text-white px-1.5 py-0.5">PRs welcome</span>
                </div>
                <p className="mt-3 text-[11px] font-semibold text-gray-500 dark:text-gray-400">Features</p>
                <ul className="mt-1 text-[11px] space-y-0.5 list-disc pl-4 marker:text-teal-500 text-gray-600 dark:text-gray-300">
                  <li>Fast, no-login publishing</li>
                  <li>Diagrams &amp; math</li>
                </ul>

                {/* mini flowchart to show diagram rendering */}
                <p className="mt-3 text-[11px] font-semibold text-gray-500 dark:text-gray-400">Flowchart</p>
                <svg viewBox="0 0 240 40" className="mt-1 w-full h-auto max-w-[13rem]">
                  <defs>
                    <linearGradient id="bld-node" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0d9488" />
                      <stop offset="100%" stopColor="#0ea5e9" />
                    </linearGradient>
                  </defs>
                  <line x1="58" y1="20" x2="96" y2="20" className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="1.5" />
                  <line x1="150" y1="20" x2="188" y2="20" className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="1.5" />
                  <rect x="6" y="8" width="52" height="24" rx="6" fill="url(#bld-node)" />
                  <text x="32" y="24" textAnchor="middle" className="fill-white text-[10px]">Write</text>
                  <rect x="96" y="8" width="54" height="24" rx="6" fill="url(#bld-node)" />
                  <text x="123" y="24" textAnchor="middle" className="fill-white text-[10px]">Render</text>
                  <rect x="188" y="8" width="48" height="24" rx="6" fill="url(#bld-node)" />
                  <text x="212" y="24" textAnchor="middle" className="fill-white text-[10px]">Ship</text>
                </svg>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
