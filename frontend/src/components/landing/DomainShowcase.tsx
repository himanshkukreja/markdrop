"use client";

import BrandedPage from "./BrandedPage";
import Reveal from "./Reveal";

/** One tab + address bar. Two of these crossfade to show the same document
 *  wearing a different brand. */
function TabState({ name, host, accent, cls }: { name: string; host: string; accent: string; cls: string }) {
  return (
    <div className={`absolute inset-0 ${cls}`}>
      <div className="flex items-end gap-1 px-2 pt-2">
        <div className="flex gap-1.5 px-2 pb-2.5 items-center">
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span key={c} className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
        <div className="flex items-center gap-1.5 min-w-0 max-w-[75%] rounded-t-lg px-2.5 py-1.5 bg-[#0b1220]">
          <span className="w-3.5 h-3.5 rounded-[3px] shrink-0 flex items-center justify-center text-[8px] font-bold text-white"
                style={{ background: accent }}>{name[0]}</span>
          <span className="text-[11px] truncate text-gray-300">Quarterly plan — {name}</span>
        </div>
      </div>
      <div className="px-3 py-2 bg-[#0b1220]">
        <div className="rounded-md bg-white/[0.06] px-2.5 py-1 text-[11px] font-mono text-gray-400 truncate">
          {host}<span className="text-gray-600">/a7f3q2</span>
        </div>
      </div>
    </div>
  );
}

export default function DomainShowcase() {
  return (
    <section className="py-16 sm:py-20">
      <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center [&>*]:min-w-0">
        {/* Copy first on desktop — the section before this one ends text-right. */}
        <Reveal>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider bg-indigo-500/10 text-indigo-400 ring-1 ring-indigo-500/25">
            Custom domains
          </span>
          <h2 className="mt-4 text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
            Publish under your own name
          </h2>
          <p className="mt-3 text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d] leading-relaxed">
            Point a domain you own at Markdrop and documents serve from{" "}
            <span className="font-mono text-gray-800 dark:text-gray-200">docs.yourcompany.com</span>{" "}
            — your name in the title, your favicon in the tab, your branding on every link preview.
          </p>
          <ul className="mt-5 space-y-2.5 text-sm text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d]">
            {[
              "Two DNS records, then we issue the certificate",
              "View-only mode turns it into a plain CDN for docs",
              "Your host serves only your workspace — nothing else resolves",
              "Folders and roles for the team behind it",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <svg className="w-4 h-4 mt-0.5 shrink-0 text-indigo-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                <span>{t}</span>
              </li>
            ))}
          </ul>
          <a href="/enterprise"
             className="mt-7 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
            See how it works
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </a>
        </Reveal>

        <Reveal delay={120}>
          <div className="rounded-xl overflow-hidden border border-gray-300/70 dark:border-gray-700 vscode:border-[#3c3c3c] shadow-2xl shadow-indigo-500/10 bg-[#161f33]">
            {/* Crossfading chrome: same page, different owner */}
            <div className="relative h-[86px]">
              <TabState name="Markdrop" host="markdrop.in" accent="#3b82f6" cls="md-brand-a" />
              <TabState name="Your Company" host="docs.yourcompany.com" accent="#7c3aed" cls="md-brand-b" />
            </div>
            {/* The document underneath never changes — only whose it looks like */}
            <div className="bg-[#0b1220] border-t border-white/5">
              <BrandedPage hueClass="md-brand-hue" />
            </div>
          </div>
          <p className="mt-3 text-center text-[11px] text-gray-500">The same document — only the host changes</p>
        </Reveal>
      </div>
    </section>
  );
}
