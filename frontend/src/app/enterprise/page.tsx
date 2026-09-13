import type { Metadata } from "next";
import Reveal from "@/components/landing/Reveal";
import LandingFooter from "@/components/landing/LandingFooter";

export const metadata: Metadata = {
  title: "Custom domains & white-labelling — Markdrop",
  description:
    "Serve documents from your own domain with your own branding. Custom domains, white-label preview cards, view-only CDN mode, folders and team roles.",
};

const STEPS = [
  {
    n: "1",
    title: "Add your domain",
    body: "Any hostname you control — docs.yourcompany.com, cdn.yourcompany.com, whatever fits. You choose the name; we only ask what it should serve.",
  },
  {
    n: "2",
    title: "Add two DNS records",
    body: "One TXT record proves you own it, one CNAME points it at us. Both are shown ready to paste, and we read them from your nameservers directly rather than waiting on a cache.",
  },
  {
    n: "3",
    title: "It's yours",
    body: "We issue the certificate and your documents start serving from your domain, under your name, with your favicon and your preview cards.",
  },
];

const FEATURES: { title: string; body: string }[] = [
  {
    title: "Nothing says Markdrop",
    body: "Your site name replaces ours in page titles and link previews. Your favicon, your accent colour, your domain in the footer of every preview card. Someone opening a link in Slack sees your brand and nothing else.",
  },
  {
    title: "View-only mode",
    body: "Turn off every control for signed-out visitors and a document page becomes a plain rendered page — no viewer chrome, no way out, nothing to click. Use it as a CDN for documentation you publish.",
  },
  {
    title: "Your domain serves only your documents",
    body: "A slug that exists elsewhere on Markdrop returns 404 on your host. Your domain is a window onto your workspace, never onto the platform.",
  },
  {
    title: "Folders and roles",
    body: "File documents into folders, and invite your team as owner, admin, member or viewer. Folders organise; they never change who can read a document.",
  },
  {
    title: "Require sign-in",
    body: "Optionally refuse anonymous reads for everything in the workspace — enforced on every link to the document, not just on your own domain.",
  },
  {
    title: "End-to-end encryption",
    body: "Works alongside all of it. Encrypted documents are sealed in the browser, and the key travels in the link fragment, which never reaches a server.",
  },
];

export default function EnterprisePage() {
  return (
    <div className="w-full min-w-0 overflow-x-clip">
      <section className="py-16 sm:py-24 max-w-3xl">
        <Reveal>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider bg-blue-500/10 text-blue-500 ring-1 ring-blue-500/25">
            For teams &amp; enterprises
          </span>
          <h1 className="mt-4 text-3xl sm:text-5xl font-bold tracking-tight text-gray-900 dark:text-white">
            Your domain.<br />
            <span className="md-gradient-text">Your brand.</span>
          </h1>
          <p className="mt-5 text-lg text-gray-600 dark:text-gray-400 leading-relaxed">
            Publish from <span className="font-mono text-gray-800 dark:text-gray-200">docs.yourcompany.com</span>{" "}
            instead of ours. Your name on the page, your favicon in the tab, your branding on
            every link preview — and documents that only ever resolve on your own domain.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
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
      </section>

      {/* What a customer's link actually looks like */}
      <section className="pb-16 sm:pb-20">
        <Reveal>
          <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/50 backdrop-blur-sm overflow-hidden max-w-3xl">
            <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-800 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              The same document, two hosts
            </div>
            <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-200 dark:divide-gray-800">
              <div className="px-5 py-4">
                <p className="text-[11px] text-gray-400 mb-2">Default</p>
                <p className="font-mono text-xs text-gray-600 dark:text-gray-400 break-all">markdrop.in/a7f3q2</p>
                <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">Quarterly plan — Markdrop</p>
              </div>
              <div className="px-5 py-4 bg-blue-500/[0.04]">
                <p className="text-[11px] text-blue-500 mb-2">On your domain</p>
                <p className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">docs.yourcompany.com/a7f3q2</p>
                <p className="mt-3 text-sm text-gray-800 dark:text-gray-200 font-medium">Quarterly plan — Your Company</p>
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      <section className="pb-16 sm:pb-20">
        <Reveal className="max-w-3xl">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-8">Set up in three steps</h2>
          <div className="grid sm:grid-cols-3 gap-5">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-xl border border-gray-200 dark:border-gray-800 p-5">
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-500/10 text-blue-500 text-sm font-bold">
                  {s.n}
                </span>
                <h3 className="mt-3 text-sm font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      <section className="pb-16 sm:pb-20">
        <Reveal className="max-w-3xl">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-8">What you get</h2>
          <div className="grid sm:grid-cols-2 gap-5">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-xl border border-gray-200 dark:border-gray-800 p-5">
                <h3 className="text-sm font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* Said plainly, because a security page that oversells is worse than none */}
      <section className="pb-16 sm:pb-20">
        <Reveal className="max-w-3xl">
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-5">
            <h2 className="text-sm font-semibold mb-2">Worth knowing</h2>
            <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
              <li>
                A host serves either your documents or your uploaded files, never both. Files you
                publish are arbitrary content, and keeping it off the origin that holds your session
                is what stops one from reaching the other.
              </li>
              <li>
                Subdomains are the simple path. An apex domain needs an A record, which not every
                DNS provider handles gracefully.
              </li>
              <li>
                View-only mode hides the controls a visitor would use to report a document, so it
                applies only on domains you own and are accountable for — never on markdrop.in.
              </li>
            </ul>
          </div>
        </Reveal>
      </section>

      <LandingFooter />
    </div>
  );
}
