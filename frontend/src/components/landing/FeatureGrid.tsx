"use client";

import Reveal from "./Reveal";
import type { ReactNode } from "react";

type Feature = {
  title: string;
  desc: string;
  icon: ReactNode;
  href: string;
  cta: string;
};

const FEATURES: Feature[] = [
  {
    title: "Instant Markdown publishing",
    desc: "Paste or write markdown and get a clean markdrop.in link in one click. Live preview, formatting toolbar, syntax highlighting, and PDF export.",
    href: "/new",
    cta: "Create a document",
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    ),
  },
  {
    title: "Peer-to-peer file sharing",
    desc: "Send any file directly browser-to-browser over WebRTC. Nothing is uploaded to a server — the transfer is end-to-end encrypted and size is limited only by your device.",
    href: "/share",
    cta: "Share a file",
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
    ),
  },
  {
    title: "VS Code Sync extension",
    desc: "Publish and two-way sync your markdown straight from VS Code. Save locally to push, edit on the web to pull back — with safe, side-by-side conflict diffs.",
    href: "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop",
    cta: "Get the extension",
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
    ),
  },
  {
    title: "Export to Google Docs",
    desc: "Connect your Google account and turn any markdown document into a fully-formatted Google Doc in one click — headings, tables, lists and code included. Edit later and push the update to the same Doc.",
    href: "/dashboard",
    cta: "Export a document",
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    ),
  },
  {
    title: "Diagrams, charts & math",
    desc: "Write a ```mermaid block or LaTeX between $$ … $$ and Markdrop renders flowcharts, sequence & Gantt diagrams, pie/bar charts and typeset KaTeX math — live in the browser, no plugins.",
    href: "/new",
    cta: "Render a diagram",
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    ),
  },
  {
    title: "Accounts & analytics",
    desc: "Optional passwordless login unlocks a dashboard of all your docs, view counts, and geographic analytics. Everything works fully without an account too.",
    href: "/dashboard",
    cta: "Open dashboard",
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    ),
  },
];

const CHIPS = [
  "Custom slugs",
  "Password protection",
  "Expiring links",
  "Live preview / split view",
  "Mermaid diagrams",
  "LaTeX / KaTeX math",
  "Syntax highlighting",
  "Export to PDF",
  "Export to Google Docs",
  "VS Code & dark themes",
  "View counts",
  "Edit & delete via secret",
  "Rate-limited & abuse-reported",
];

export default function FeatureGrid() {
  return (
    <section className="py-16 sm:py-20">
      <Reveal className="text-center max-w-2xl mx-auto">
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
          One tool, six <span className="md-gradient-text">superpowers</span>
        </h2>
        <p className="mt-3 text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0]">
          Markdrop started as a markdown pastebin and grew into a full sharing suite — all still no-login by default.
        </p>
      </Reveal>

      <div className="mt-12 grid sm:grid-cols-2 gap-5">
        {FEATURES.map((f, i) => {
          const external = f.href.startsWith("http");
          return (
            <Reveal key={f.title} delay={i * 80}>
              <a
                href={f.href}
                {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="group block h-full rounded-2xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white/60 dark:bg-gray-900/40 vscode:bg-[#252526]/80 backdrop-blur-sm p-6 transition-all duration-300 hover:-translate-y-1 hover:border-blue-500/50 hover:shadow-xl hover:shadow-blue-500/20"
              >
                <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-gradient-to-br from-blue-500/15 to-sky-500/15 text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff] group-hover:from-blue-600 group-hover:to-sky-600 group-hover:text-white transition-all">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
                    {f.icon}
                  </svg>
                </div>
                <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0]">
                  {f.desc}
                </p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff]">
                  {f.cta}
                  <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </span>
              </a>
            </Reveal>
          );
        })}
      </div>

      {/* Capability chips */}
      <Reveal className="mt-10 flex flex-wrap justify-center gap-2" delay={120}>
        {CHIPS.map((c) => (
          <span
            key={c}
            className="px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900/50 vscode:bg-[#2d2d2d] text-gray-600 dark:text-gray-400 vscode:text-[#b0b0b0]"
          >
            {c}
          </span>
        ))}
      </Reveal>
    </section>
  );
}
