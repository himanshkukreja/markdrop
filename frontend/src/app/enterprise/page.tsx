import type { Metadata } from "next";
import Reveal from "@/components/landing/Reveal";
import LandingFooter from "@/components/landing/LandingFooter";
import BrandedPage from "@/components/landing/BrandedPage";

export const metadata: Metadata = {
  title: "Custom domains & white-labelling — Markdrop",
  description:
    "Serve documents from your own domain with your own branding. Custom domains, white-label preview cards, view-only CDN mode, folders and team roles.",
};

/** A browser window, drawn rather than described — the fastest way to show
 *  someone what "your domain" actually looks like. */
function BrowserMock({
  host, title, favicon, accent, dimmed = false,
}: { host: string; title: string; favicon: string; accent: string; dimmed?: boolean }) {
  return (
    <div className={`rounded-xl border overflow-hidden shadow-2xl ${
      dimmed
        ? "border-gray-200 dark:border-gray-800 bg-white/50 dark:bg-gray-900/40"
        : "border-blue-500/30 bg-white/70 dark:bg-gray-900/70 shadow-blue-500/10"}`}>
      {/* Tab strip */}
      <div className="flex items-end gap-1 px-2 pt-2 bg-gray-100/80 dark:bg-gray-950/60">
        <div className="flex gap-1.5 px-2 pb-2.5 items-center">
          {["#ef4444", "#eab308", "#22c55e"].map((c) => (
            <span key={c} className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />
          ))}
        </div>
        <div className="flex items-center gap-1.5 min-w-0 max-w-[70%] rounded-t-lg px-2.5 py-1.5 bg-white dark:bg-gray-900">
          <span className="w-3.5 h-3.5 rounded-[3px] shrink-0 flex items-center justify-center text-[8px] font-bold text-white"
                style={{ background: accent }}>{favicon}</span>
          <span className="text-[11px] truncate text-gray-700 dark:text-gray-300">{title}</span>
        </div>
      </div>
      {/* Address bar */}
      <div className="px-3 py-2 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <div className="rounded-md bg-gray-100 dark:bg-gray-800/80 px-2.5 py-1 text-[11px] font-mono text-gray-600 dark:text-gray-400 truncate">
          {host}<span className="text-gray-400 dark:text-gray-600">/a7f3q2</span>
        </div>
      </div>
      {/* Page */}
      <div className="bg-white dark:bg-gray-900/80">
        <BrandedPage accent={accent} tone="auto" />
      </div>
    </div>
  );
}

const STEPS = [
  { n: "1", t: "Add your domain", d: "Any hostname you control." },
  { n: "2", t: "Two DNS records", d: "One proves it's yours, one points it here." },
  { n: "3", t: "Done", d: "We issue the certificate. It's live." },
];

const FEATURES = [
  { t: "No Markdrop anywhere", d: "Your name, favicon and colour on every page and link preview.",
    icon: "M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c2.5-2.4 3.75-5.4 3.75-9S14.5 5.4 12 3m0 18c-2.5-2.4-3.75-5.4-3.75-9S9.5 5.4 12 3M3.6 9h16.8M3.6 15h16.8" },
  { t: "View-only mode", d: "Hide every control for visitors. A plain page, served like a CDN.",
    icon: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
  { t: "Only your documents", d: "A slug from elsewhere on Markdrop returns 404 on your host.",
    icon: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75M6.75 21h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75A2.25 2.25 0 006.75 21z" },
  { t: "Folders & roles", d: "Owner, admin, member, viewer. Folders file; they never grant access.",
    icon: "M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" },
  { t: "Require sign-in", d: "Refuse anonymous reads — on every link, not just your domain.",
    icon: "M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.5 20.25a8.25 8.25 0 0115 0" },
  { t: "End-to-end encryption", d: "Sealed in the browser. The key rides in the link, never our servers.",
    icon: "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
];

export default function EnterprisePage() {
  return (
    <div className="w-full min-w-0 overflow-x-clip">
      {/* Same ambient treatment as the landing page, so this doesn't read as a
          different product the moment someone clicks through. */}
      <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="md-aurora absolute -top-40 -left-32 w-[38rem] h-[38rem] rounded-full blur-3xl opacity-40 dark:opacity-50"
          style={{ background: "radial-gradient(circle, rgba(37,99,235,0.55), transparent 65%)" }} />
        <div className="md-aurora-2 absolute top-1/4 -right-40 w-[42rem] h-[42rem] rounded-full blur-3xl opacity-35 dark:opacity-45"
          style={{ background: "radial-gradient(circle, rgba(14,165,233,0.45), transparent 65%)" }} />
        <div className="absolute inset-0 md-grid" />
      </div>

      {/* ── Hero: copy left, the thing itself right ───────────────────────── */}
      <section className="pt-10 pb-12 sm:pt-14 sm:pb-16">
        <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center [&>*]:min-w-0">
          <Reveal>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider bg-blue-500/10 text-blue-500 ring-1 ring-blue-500/25">
              For teams &amp; enterprises
            </span>
            <h1 className="mt-4 text-4xl sm:text-5xl font-bold tracking-tight text-gray-900 dark:text-white leading-[1.05]">
              Your domain.<br />
              <span className="md-gradient-text">Your brand.</span>
            </h1>
            <p className="mt-5 text-lg text-gray-600 dark:text-gray-400 leading-relaxed">
              Publish from your own domain, under your own name. Nobody sees Markdrop.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a href="/settings/workspaces"
                 className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
                Create a workspace
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </a>
              <a href="mailto:himanshu@senseloaf.com?subject=Markdrop%20for%20our%20team"
                 className="inline-flex items-center px-5 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 text-sm font-medium transition-colors">
                Talk to us
              </a>
            </div>
          </Reveal>

          <Reveal delay={120} className="lg:pl-4">
            <BrowserMock host="docs.yourcompany.com" title="Quarterly plan — Your Company" favicon="Y" accent="#7c3aed" />
          </Reveal>
        </div>
      </section>

      {/* ── The swap, shown not described ─────────────────────────────────── */}
      <section className="py-10 sm:py-14">
        <Reveal className="text-center max-w-2xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">The same document</h2>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Only the host changes. Everything a visitor sees follows it.</p>
        </Reveal>
        <div className="mt-8 grid md:grid-cols-2 gap-6 lg:gap-10 items-start [&>*]:min-w-0">
          <Reveal>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-3">Default</p>
            <BrowserMock host="markdrop.in" title="Quarterly plan — Markdrop" favicon="m" accent="#3b82f6" dimmed />
          </Reveal>
          <Reveal delay={100}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-500 mb-3">On your domain</p>
            <BrowserMock host="docs.yourcompany.com" title="Quarterly plan — Your Company" favicon="Y" accent="#7c3aed" />
          </Reveal>
        </div>
      </section>

      {/* ── Setup ─────────────────────────────────────────────────────────── */}
      <section className="py-10 sm:py-14">
        <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center [&>*]:min-w-0">
          <Reveal>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Live in three steps</h2>
            <ol className="mt-7 space-y-5">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-4">
                  <span className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-500/10 text-blue-500 text-sm font-bold ring-1 ring-blue-500/20">
                    {s.n}
                  </span>
                  <div>
                    <p className="font-semibold text-gray-900 dark:text-gray-100">{s.t}</p>
                    <p className="text-sm text-gray-600 dark:text-gray-400">{s.d}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Reveal>

          {/* The actual records, so the work looks as small as it is */}
          <Reveal delay={120}>
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/50 backdrop-blur-sm overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-800 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                Your DNS panel
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-800 font-mono text-[11px]">
                {[
                  ["TXT", "_markdrop-verify.docs", "markdrop-verify=k3f9…"],
                  ["CNAME", "docs", "edge.markdrop.in"],
                ].map(([type, name, value]) => (
                  <div key={name} className="px-4 py-3 flex items-center gap-3">
                    <span className="w-14 shrink-0 text-blue-500 font-semibold">{type}</span>
                    <span className="w-36 shrink-0 truncate text-gray-500 dark:text-gray-400">{name}</span>
                    <span className="flex-1 min-w-0 truncate text-gray-700 dark:text-gray-300">{value}</span>
                  </div>
                ))}
              </div>
              <div className="px-4 py-2.5 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                Verified · certificate issued
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────────────────────── */}
      <section className="py-10 sm:py-14">
        <Reveal className="text-center max-w-2xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">What comes with it</h2>
        </Reveal>
        <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-3 gap-5 [&>*]:min-w-0">
          {FEATURES.map((f, i) => (
            <Reveal key={f.t} delay={i * 60}>
              <div className="h-full rounded-2xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/40 backdrop-blur-sm p-5 transition-all duration-300 hover:-translate-y-1 hover:border-blue-500/50">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-gradient-to-br from-blue-500/15 to-sky-500/15 text-blue-500">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d={f.icon} />
                  </svg>
                </div>
                <h3 className="mt-3.5 text-sm font-semibold">{f.t}</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{f.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── The caveats, kept but compressed. A page selling a security
             feature that hides its limits is worse than no page. ─────────── */}
      <section className="pb-14 sm:pb-16">
        <Reveal>
          <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white/40 dark:bg-gray-900/30 p-5 sm:p-6">
            <h2 className="text-sm font-semibold mb-3">Worth knowing</h2>
            <div className="grid sm:grid-cols-3 gap-4 text-sm text-gray-600 dark:text-gray-400">
              <p><span className="text-gray-800 dark:text-gray-200 font-medium">One job per host.</span> Documents or uploaded files, never both — that separation is what keeps uploaded content away from your session.</p>
              <p><span className="text-gray-800 dark:text-gray-200 font-medium">Subdomains are simplest.</span> An apex domain needs an A record, which not every DNS provider handles well.</p>
              <p><span className="text-gray-800 dark:text-gray-200 font-medium">View-only hides Report.</span> So it applies only on domains you own and are accountable for — never on markdrop.in.</p>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ── Close ─────────────────────────────────────────────────────────── */}
      <section className="pb-16 sm:pb-24">
        <Reveal>
          <div className="rounded-2xl border border-blue-500/25 bg-gradient-to-br from-blue-500/10 to-sky-500/5 p-8 sm:p-10 text-center">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Put your name on it</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">Free to set up. No login required to try Markdrop itself.</p>
            <a href="/settings/workspaces"
               className="mt-6 inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors">
              Create a workspace
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </a>
          </div>
        </Reveal>
      </section>

      <LandingFooter />
    </div>
  );
}
