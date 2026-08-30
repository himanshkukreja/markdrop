"use client";

import Reveal from "./Reveal";

/* Tinted markdown source lines — the "input" that renders to the diagram/math below. */
const SRC: { parts: { t: string; c?: string }[] }[] = [
  { parts: [{ t: "```mermaid", c: "text-gray-400 dark:text-gray-500 vscode:text-[#6a6a6a]" }] },
  { parts: [{ t: "graph LR", c: "text-violet-500 dark:text-violet-400" }] },
  { parts: [{ t: "  A", c: "text-sky-600 dark:text-sky-400" }, { t: "[Write] ", c: "text-gray-600 dark:text-gray-300 vscode:text-[#c8c8c8]" }, { t: "--> ", c: "text-gray-400 dark:text-gray-500" }, { t: "B", c: "text-sky-600 dark:text-sky-400" }, { t: "{Render?}", c: "text-gray-600 dark:text-gray-300 vscode:text-[#c8c8c8]" }] },
  { parts: [{ t: "  B ", c: "text-sky-600 dark:text-sky-400" }, { t: "-->|yes| ", c: "text-gray-400 dark:text-gray-500" }, { t: "C", c: "text-sky-600 dark:text-sky-400" }, { t: "[Ship 🚀]", c: "text-gray-600 dark:text-gray-300 vscode:text-[#c8c8c8]" }] },
  { parts: [{ t: "```", c: "text-gray-400 dark:text-gray-500 vscode:text-[#6a6a6a]" }] },
  { parts: [{ t: "$$ ", c: "text-amber-500 dark:text-amber-400" }, { t: "E = mc^2 ", c: "text-gray-600 dark:text-gray-300 vscode:text-[#c8c8c8]" }, { t: "$$", c: "text-amber-500 dark:text-amber-400" }] },
];

/* A compact mermaid-style rendered flowchart (hand-drawn SVG). */
function RenderedFlowchart() {
  return (
    <svg viewBox="0 0 380 70" className="w-full h-auto" role="img" aria-label="Rendered flowchart">
      <defs>
        <linearGradient id="node-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#0ea5e9" />
        </linearGradient>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="fill-gray-400 dark:fill-gray-500" />
        </marker>
      </defs>

      {/* edges */}
      <line x1="86" y1="35" x2="150" y2="35" className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="1.5" markerEnd="url(#arrow)" />
      <line x1="238" y1="35" x2="300" y2="35" className="stroke-gray-300 dark:stroke-gray-600" strokeWidth="1.5" markerEnd="url(#arrow)" />
      <text x="266" y="28" textAnchor="middle" className="fill-gray-400 dark:fill-gray-500 text-[9px]">yes</text>

      {/* A [Write] */}
      <rect x="10" y="20" width="76" height="30" rx="8" fill="url(#node-grad)" />
      <text x="48" y="39" textAnchor="middle" className="fill-white text-[12px] font-medium">Write</text>

      {/* B {Render?} — diamond */}
      <polygon points="194,14 240,35 194,56 148,35" fill="url(#node-grad)" />
      <text x="194" y="39" textAnchor="middle" className="fill-white text-[11px] font-medium">Render?</text>

      {/* C [Ship] */}
      <rect x="300" y="20" width="72" height="30" rx="8" fill="url(#node-grad)" />
      <text x="336" y="39" textAnchor="middle" className="fill-white text-[12px] font-medium">Ship 🚀</text>
    </svg>
  );
}

/* A KaTeX-style typeset equation, built from styled spans (no runtime math lib). */
function RenderedMath() {
  return (
    <div className="flex items-center justify-center gap-6 font-serif text-gray-800 dark:text-gray-100 vscode:text-[#e8e8e8] text-lg italic">
      <span>
        E = mc<sup className="text-[0.7em] not-italic">2</sup>
      </span>
      <span className="flex items-center gap-1">
        <span className="text-2xl not-italic">∫</span>
        <span className="flex flex-col items-center leading-none">
          <span className="text-xs not-italic">x<sup className="text-[0.6em]">3</sup></span>
          <span className="w-6 border-t border-current my-0.5" />
          <span className="text-xs not-italic">3</span>
        </span>
        <span className="not-italic text-sm text-gray-400">dx</span>
      </span>
    </div>
  );
}

/* A tiny bar chart to represent Mermaid xychart / pie output. */
function RenderedChart() {
  const bars = [
    { h: 26, c: "from-violet-500 to-indigo-500" },
    { h: 40, c: "from-blue-500 to-sky-500" },
    { h: 18, c: "from-sky-500 to-cyan-400" },
    { h: 33, c: "from-indigo-500 to-blue-500" },
  ];
  return (
    <div className="flex items-end justify-center gap-2 h-12">
      {bars.map((b, i) => (
        <div key={i} className={`w-4 rounded-t bg-gradient-to-t ${b.c}`} style={{ height: `${b.h}px` }} />
      ))}
    </div>
  );
}

const POINTS: [string, string][] = [
  ["Mermaid diagrams", "Flowcharts, sequence, Gantt, class and state diagrams — straight from a text fence."],
  ["Charts", "Pie and XY/bar charts render inline — perfect for a quick data snapshot."],
  ["LaTeX math (KaTeX)", "Inline $E = mc^2$ and display $$…$$ blocks become beautifully typeset math."],
  ["Zero setup", "Rendered right in the browser on any document — in light, dark and VS Code themes."],
];

export default function DiagramShowcase() {
  return (
    <section className="py-16 sm:py-20">
      <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center [&>*]:min-w-0">
        {/* Document mock — source renders to diagram + math + chart */}
        <Reveal className="lg:order-2">
          <div className="rounded-xl overflow-hidden border border-gray-300/70 dark:border-gray-700 vscode:border-[#3c3c3c] shadow-2xl shadow-violet-500/10 bg-white dark:bg-[#1e1e1e] vscode:bg-[#252526]">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-3 py-2 bg-[#f1f3f4] dark:bg-[#2a2a2a] vscode:bg-[#333333] border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c]">
              <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <span className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-2 text-xs font-mono text-gray-500 dark:text-[#9d9d9d]">architecture.md</span>
              <span className="ml-auto flex items-center gap-1 text-[10px] text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-500/15 rounded-full px-2 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500" /> Rendered
              </span>
            </div>

            {/* Source strip */}
            <div className="px-4 py-3 font-mono text-[12px] leading-[1.7] bg-[#f6f8fa] dark:bg-[#161616] vscode:bg-[#1e1e1e] border-b border-gray-100 dark:border-gray-800 vscode:border-[#3c3c3c] overflow-hidden">
              {SRC.map((line, i) => (
                <div key={i} className="whitespace-pre">
                  {line.parts.map((p, j) => (
                    <span key={j} className={p.c ?? "text-gray-600 dark:text-gray-300"}>{p.t}</span>
                  ))}
                </div>
              ))}
            </div>

            {/* "renders to" divider */}
            <div className="flex items-center gap-2 px-4 py-1.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
              <span className="flex-1 h-px bg-gray-200 dark:bg-gray-800 vscode:bg-[#3c3c3c]" />
              renders to
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
              <span className="flex-1 h-px bg-gray-200 dark:bg-gray-800 vscode:bg-[#3c3c3c]" />
            </div>

            {/* Rendered output */}
            <div className="px-5 py-4 space-y-4">
              <RenderedFlowchart />
              <div className="border-t border-gray-100 dark:border-gray-800 vscode:border-[#3c3c3c] pt-4">
                <RenderedMath />
              </div>
              <div className="border-t border-gray-100 dark:border-gray-800 vscode:border-[#3c3c3c] pt-4">
                <RenderedChart />
              </div>
            </div>
          </div>
        </Reveal>

        {/* Copy */}
        <Reveal className="lg:order-1">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300 vscode:text-[#c586c0]">
            Mermaid · LaTeX · Charts
          </span>
          <h2 className="mt-4 text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
            Diagrams and math, rendered right in your doc.
          </h2>
          <p className="mt-4 text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0] leading-relaxed">
            Drop a{" "}
            <span className="font-mono text-violet-600 dark:text-violet-400 vscode:text-[#c586c0]">```mermaid</span>{" "}
            block or wrap LaTeX in{" "}
            <span className="font-mono text-violet-600 dark:text-violet-400 vscode:text-[#c586c0]">$$ … $$</span>{" "}
            and Markdrop turns it into a crisp diagram or typeset equation — no plugins, no build step,
            rendered live as you publish.
          </p>

          <ul className="mt-6 space-y-3">
            {POINTS.map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <svg className="w-5 h-5 mt-0.5 shrink-0 text-violet-500" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                <span className="text-sm text-gray-700 dark:text-gray-300 vscode:text-[#c8c8c8]">
                  <strong className="font-semibold text-gray-900 dark:text-white vscode:text-[#e8e8e8]">{t}.</strong> {d}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-xs text-gray-500 dark:text-gray-500 leading-relaxed">
            Under the hood: Mermaid and KaTeX run client-side, so your markdown stays plain text —
            the diagrams are generated fresh in the browser every time the doc loads.
          </p>

          <div className="mt-8">
            <a
              href="/new?sample=diagrams"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
            >
              Try it in a new doc
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
