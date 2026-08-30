"use client";

import Reveal from "./Reveal";

const CODE_LINES: { n: number; parts: { t: string; c?: string }[] }[] = [
  { n: 1, parts: [{ t: "# Release Notes", c: "text-[#4fc1ff]" }] },
  { n: 2, parts: [] },
  { n: 3, parts: [{ t: "Markdrop ", c: "text-gray-300" }, { t: "**v2**", c: "text-[#ce9178]" }, { t: " is live.", c: "text-gray-300" }] },
  { n: 4, parts: [] },
  { n: 5, parts: [{ t: "- ", c: "text-[#4fc1ff]" }, { t: "Publish from VS Code", c: "text-gray-300" }] },
  { n: 6, parts: [{ t: "- ", c: "text-[#4fc1ff]" }, { t: "Two-way sync on save", c: "text-gray-300" }] },
  { n: 7, parts: [{ t: "- ", c: "text-[#4fc1ff]" }, { t: "Conflict-safe ", c: "text-gray-300" }, { t: "`diffs`", c: "text-[#ce9178]" }] },
];

export default function VSCodeShowcase() {
  return (
    <section className="py-16 sm:py-20">
      <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center [&>*]:min-w-0">
        {/* VS Code window mock */}
        <Reveal>
          <div className="rounded-xl overflow-hidden border border-gray-300/70 dark:border-gray-700 vscode:border-[#3c3c3c] shadow-2xl shadow-blue-500/10 bg-[#1e1e1e]">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[#323233]">
              <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <span className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 text-xs font-mono text-[#9d9d9d]">Release-Notes.md — Visual Studio Code</span>
            </div>

            <div className="flex">
              {/* Activity bar */}
              <div className="hidden sm:flex flex-col items-center gap-4 py-3 w-11 bg-[#333333] text-[#858585]">
                {[
                  "M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5",
                  "M15.75 15.75V18a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 18v-8.25A2.25 2.25 0 016.75 7.5h2.25",
                  "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94",
                ].map((d, i) => (
                  <svg key={i} className={`w-5 h-5 ${i === 0 ? "text-white" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d={d} />
                  </svg>
                ))}
                <span className="mt-auto w-6 h-6 rounded-full bg-blue-500 text-white text-xs flex items-center justify-center font-bold">M</span>
              </div>

              {/* Editor */}
              <div className="flex-1 py-3 font-mono text-[12.5px] leading-[1.7] overflow-hidden">
                {CODE_LINES.map((line) => (
                  <div key={line.n} className="flex">
                    <span className="w-9 shrink-0 text-right pr-3 text-[#6a6a6a] select-none">{line.n}</span>
                    <span className="whitespace-pre">
                      {line.parts.map((p, i) => (
                        <span key={i} className={p.c ?? "text-gray-300"}>{p.t}</span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Status bar */}
            <div className="flex items-center justify-between px-3 py-1 bg-[#007acc] text-white text-[11px] font-mono">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6L9 12.75l-4.286 4.286" />
                  </svg>
                  main
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green-300 animate-pulse" />
                  Markdrop: Synced
                </span>
              </div>
              <span className="hidden sm:block">Markdown · UTF-8 · Ln 7</span>
            </div>
          </div>
        </Reveal>

        {/* Copy */}
        <Reveal>
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300 vscode:text-[#4fc1ff]">
            Markdrop Sync · VS Code extension
          </span>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
            Stop copy-pasting docs into a browser.
          </h2>
          <p className="mt-4 text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0] leading-relaxed">
            Write markdown in VS Code — from Claude Code, Codex, or your own notes — hit save,
            and it publishes to a <span className="font-mono text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff]">markdrop.in</span> link.
            Edit it on the web and the change flows back into your file.
          </p>
          <ul className="mt-6 space-y-3">
            {[
              ["Publish in one click", "The active .md becomes a shareable link owned by your account."],
              ["True two-way sync", "Save pushes; remote edits pull automatically into your file."],
              ["Conflict-safe", "Both sides changed? A side-by-side diff lets you choose — never a silent overwrite."],
              ["Secure by default", "Token lives in VS Code's encrypted Secret Storage and is revocable anytime."],
            ].map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <svg className="w-5 h-5 mt-0.5 shrink-0 text-blue-500" viewBox="0 0 20 20" fill="currentColor">
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
              href="https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M23.15 2.587L18.21.21a1.494 1.494 0 00-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 00-1.276.057L.327 7.261A1 1 0 00.326 8.74L3.899 12 .326 15.26a1 1 0 00.001 1.479l1.32 1.203a.999.999 0 001.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 001.704.29l4.942-2.377A1.5 1.5 0 0024 19.964V4.036a1.5 1.5 0 00-.85-1.449zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>
              Get it on the Marketplace
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
