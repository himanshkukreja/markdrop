import type { ReactNode } from "react";
import { SiteHeader } from "@/components/shell/SiteHeader";
import { SiteFooter } from "@/components/shell/SiteFooter";
import FeedbackWidget from "@/components/FeedbackWidget";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { Icon } from "@/components/landing/orbit/ds";
import TrailerButton, { type Trailer } from "@/components/landing/docs-studio/TrailerButton";
import GuidesHero from "./GuidesHero";
import LoopVideo from "./LoopVideo";
import { LOOPS } from "./loops";
import LandingTracker from "./LandingTracker";
import {
  BETA_PLAN, COMPARED_LABEL, COMPARED_ON, COMPARISON, COMPARISON_NOTES, FAQS, PLANNED_PLANS, PRICING_RULES,
  PRIVATE_PAGES_LIVE, type Cell, type Plan,
} from "./content";
import { studioUrl } from "@/lib/studioHost";
import s from "./GuidesLanding.module.css";

/**
 * The Markdrop Guides landing page: markdrop.in/guides, the same page for everyone, signed in or
 * not (the studio is on guides.markdrop.in). A server component with no request data, so the page is static: the copy,
 * the comparison, the pricing and the FAQ are server HTML. Islands: the short looping product clips
 * (LoopVideo: the hero's laptop and cards, and a few sections; GuidesHero has the hero), the tour
 * button (TrailerButton, the player loads on click) and the analytics listener (LandingTracker). The live calculator is a sandboxed frame (public/guides-demo, with
 * the sandbox repeated as a response header in next.config.ts).
 *
 * Every "start" link goes to the studio (StartLink: a new guide on guides.markdrop.in, which signs
 * a signed-out visitor in first). Pillar buttons carry data-pillar for the
 * per-pillar interest count (lib/guidesEvents guide_landing_cta).
 */

/** Studio paths (lib/studioHost): the studio is on guides.markdrop.in. */
const NEW_GUIDE = "/new";
const SIGNED_IN_LABEL = "Open your guides";
const docs = (topic: keyof typeof DOCS_PAGES) => docsUrl(DOCS_PAGES[topic]);
const PRIVATE_DOCS = docs("privatePages");
const EMBED_DOCS = docs("studioEmbedFiles");

const TRAILER: Trailer = {
  src: "/docs-assets/videos/guides-trailer.mp4",
  poster: "/docs-assets/videos/guides-trailer.webp",
  title: "Markdrop Guides in two minutes",
  duration: "2:29",
  chaptersSrc: "/docs-assets/videos/guides-trailer.vtt",
  captionsSrc: "/docs-assets/videos/guides-trailer.captions.vtt",
  w: 1920,
  h: 1080,
};

/** The calculator's text version, as its embed block carries it (docs: guides/embed-files). */
const CALC_SUMMARY =
  "Pick a plan (Starter 9, Team 19 or Scale 39 dollars per seat a month), set the number of seats and choose monthly or yearly billing; the monthly and yearly totals update as you go. Fictional prices.";

/**
 * A "start" link: `path` in the studio (guides.markdrop.in/new…), which signs a signed-out visitor
 * in on markdrop.in first and comes back. `data-start` is the studio path: LandingTracker re-points
 * it on hosts where the studio is elsewhere (localhost: /guides/new). The plain "Start a guide"
 * buttons (`cta="start"` to a new guide) become "Open your guides" (the studio home) for a visitor
 * who is signed in.
 */
function StartLink({ path = NEW_GUIDE, cta, pillar, className, children }: {
  path?: string; cta: string; pillar?: string; className?: string; children: ReactNode;
}) {
  const open = cta === "start" && path === NEW_GUIDE;
  return (
    <a href={studioUrl(path)} data-start={path} data-signed-in-label={open ? SIGNED_IN_LABEL : undefined}
      data-cta={cta} data-pillar={pillar} className={className}>
      {children}
    </a>
  );
}

/** A product screenshot with its dark twin (file.dark.webp), switched by the site's theme. */
function Shot({ src, alt, w, h, className }: { src: string; alt: string; w: number; h: number; className?: string }) {
  const dark = src.replace(/\.webp$/, ".dark.webp");
  return (
    <span className={`${s.shot} ${className ?? ""}`}>
      <img className={s.shotLight} src={src} alt={alt} width={w} height={h} loading="lazy" decoding="async" />
      <img className={s.shotDark} src={dark} alt={alt} width={w} height={h} loading="lazy" decoding="async" />
    </span>
  );
}

function SectionHead({ eyebrow, id, title, lead, children }: { eyebrow?: string; id: string; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <header className={s.head}>
      {eyebrow && <p className={s.eye}>{eyebrow}</p>}
      <h2 id={id} className={s.h2}>{title}</h2>
      {lead && <p className={s.lead}>{lead}</p>}
      {children}
    </header>
  );
}

const WATCHES: Array<{ icon: string; t: string; d: string }> = [
  { icon: "arrowDown", t: "Readers leave here", d: "The section where far more readers stop than anywhere else on the page." },
  { icon: "search", t: "Searches with no results", d: "What readers look for and don't find, with the same wordings grouped." },
  { icon: "sparkle", t: "Ask AI couldn't answer", d: "Questions your pages have no answer for." },
  { icon: "flag", t: "Marked not helpful", d: "Pages most voters said didn't help, with their comments." },
  { icon: "film", t: "Video and PDF drop-off", d: "The moment a video loses its viewers, the page where PDF readers stop." },
  { icon: "link", t: "Broken links", d: "Links to pages that don't exist, and addresses readers hit that don't." },
  { icon: "terminal", t: "AI agents", d: "What assistants search for and don't find, and pages that are hard for them to use." },
  { icon: "clock", t: "Stale and heavy pages", d: "Pages many people read that nobody has touched in six months." },
];

const STEPS: Array<{ t: string; d: string }> = [
  { t: "See the evidence", d: "How far readers got, section by section; the searches; the moment viewers stop." },
  { t: "Draft a fix", d: "AI reads the evidence and the page and proposes a concrete edit, line by line." },
  { t: "Review and publish", d: "The fix opens in the editor as a suggestion. Nothing goes live until you publish." },
  { t: "Marked fixed", d: "Publishing closes the item. If readers keep struggling, it comes back." },
];

const FEATURES: Array<{ icon: string; t: string; d: string; href: string }> = [
  { icon: "sparkle", t: "Ready for AI", d: "Every guide has its own MCP server: readers connect Claude, Cursor or VS Code in one click. Ask AI answers with links to your pages, every page is also Markdown and in llms.txt, and agent reads are counted apart.", href: docs("studioMcp") },
  { icon: "github", t: "GitHub sync", d: "Import a repository (Markdown, GitBook, Mintlify, Docusaurus or MkDocs) and every push updates the guide.", href: docs("studioGithub") },
  { icon: "megaphone", t: "Changelog", d: "A What's new page with RSS and JSON feeds. Turn existing release notes into entries.", href: docs("studioChangelog") },
  { icon: "palette", t: "Themes and theme builder", d: "Fourteen themes or your brand, and a builder that keeps every colour pair readable.", href: docs("studioThemes") },
  { icon: "globe", t: "Your own domain", d: "Free. One CNAME record, or one click with Cloudflare and other supported providers.", href: docs("studioDomain") },
  { icon: "chart", t: "Insights", d: "Views, top pages, searches with no results, Ask AI questions and page feedback. No cookies.", href: docs("studioInsights") },
  { icon: "code", t: "API reference with Try it", d: "Upload an OpenAPI file: every endpoint gets a page, code samples and live requests.", href: docs("studioApiReference") },
  { icon: "edit", t: "Editor, reviews, history", d: "Visual or Markdown with a slash menu. Reviews before publish, roles, and every save as a version.", href: docs("studioEditor") },
  { icon: "server", t: "Open source engine", d: "The engine that builds guides is MIT-licensed. Host it yourself, or let Markdrop host it.", href: docs("studioSelfHost") },
];

const PRIVATE_RULES: Array<{ icon: string; t: string; d: string }> = [
  { icon: "users", t: "Your team", d: "Members of the guide's workspace." },
  { icon: "mail", t: "People or an email domain", d: "jane@northwind.com, or everyone @northwind.com. Readers get an emailed link: no account." },
  { icon: "key", t: "A password", d: "One password for a page or a group of pages." },
  { icon: "layers", t: "Per page, group or section", d: "Lock a whole page, a group in the sidebar, or one section inside a public page." },
];

function CellView({ c, guides }: { c: Cell; guides?: boolean }) {
  const mark = c.tone === "yes" ? "check" : c.tone === "no" ? "x" : "minus";
  const word = c.tone === "yes" ? "Yes" : c.tone === "no" ? "No" : "Partly";
  return (
    <span className={s.cell} data-tone={c.tone}>
      <span className={s.mark} aria-hidden><Icon name={mark} size={13} /></span>
      <span className="sr-only">{word}: </span>
      <span>
        {c.text}
        {c.href && !guides && (
          <>
            {" "}
            <a href={c.href} target="_blank" rel="noopener noreferrer" className={s.src}>
              source<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        )}
      </span>
    </span>
  );
}

function PlanCard({ p, planned }: { p: Plan; planned?: boolean }) {
  return (
    <article className={s.plan} data-current={p.current || undefined} aria-labelledby={`plan-${p.id}`}>
      <div className={s.planTop}>
        <h3 id={`plan-${p.id}`} className={s.planName}>{p.name}</h3>
        {planned ? <span className={s.planned}>Planned</span> : <span className={s.now}>Now</span>}
      </div>
      <p className={s.price}>
        <strong>{p.price}</strong> <span>{p.unit}</span>
      </p>
      <p className={s.planNote}>{p.note}</p>
      <ul className={s.planList}>
        {p.points.map((x) => (
          <li key={x}><Icon name="check" size={14} />{x}</li>
        ))}
      </ul>
    </article>
  );
}

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Markdrop Guides",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: "https://markdrop.in/guides",
  description:
    "Build and host help centers, product guides and API docs. A ranked Fix list shows what's confusing readers and drafts the fix; embed live demos, video and PDFs; keep pages private. Free while in beta.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free while in beta" },
  publisher: { "@type": "Organization", name: "Markdrop", url: "https://markdrop.in" },
};

export default function GuidesLanding() {
  return (
    <>
      <div data-guides-landing className={s.root}>
        <SiteHeader variant="marketing" />
        <main id="main" tabIndex={-1} className={s.main}>
          {/* ── Hero ─────────────────────────────────────────────────── */}
          <GuidesHero
            primary={
              <StartLink cta="start" className={`md-btn md-btn--lg ${s.primary}`}>
                Start a guide free
                <Icon name="arrowRight" size={16} />
              </StartLink>
            }
            secondary={<TrailerButton trailer={TRAILER} className={`md-btn md-btn--secondary md-btn--lg ${s.tour}`} label="Watch the 2-minute tour" />}
          />

          {/* ── The Fix list ─────────────────────────────────────────── */}
          <section id="fix-list" aria-labelledby="fix-title" className={s.section}>
            <div className={s.wrap}>
              <SectionHead
                eyebrow="The Fix list"
                id="fix-title"
                title="One ranked list of what to fix next."
                lead="Page views don't tell you what to change. The Fix list does: it ranks every problem by how many readers it affects, shows you the evidence, and drafts the fix."
              />
              <div className={s.fixGrid}>
                <figure className={s.figure}>
                  <Shot
                    src="/docs-assets/guides/fix-list/fixlist-overview.webp"
                    alt="Acme's Fix list: 15 to fix, 2 high impact. Readers leave at Install the CLI (131 readers), Quickstart marked not helpful, API keys not updated in 8 months, Product tour loses most viewers at 0:40. Beside them, AI agents: 1,464 agent reads from Claude, ChatGPT, Perplexity and Gemini."
                    w={2312}
                    h={1920}
                  />
                  <figcaption>The Fix list in the studio, with fictional data.</figcaption>
                </figure>
                <div className={s.fixSide}>
                  <h3 className={s.h3}>What it watches</h3>
                  <ul className={s.watch}>
                    {WATCHES.map((w) => (
                      <li key={w.t}>
                        <span className={s.wIcon} aria-hidden><Icon name={w.icon} size={15} /></span>
                        <span><strong>{w.t}</strong> {w.d}</span>
                      </li>
                    ))}
                  </ul>
                  <p className={s.small}>
                    Nothing is flagged on a handful of visits: every kind of item needs enough readers first. Cookieless, and nothing at all
                    is sent from browsers that ask not to be tracked.
                  </p>
                </div>
              </div>
              <ol className={s.steps}>
                {STEPS.map((st, i) => (
                  <li key={st.t}>
                    <span className={s.stepN} aria-hidden>{i + 1}</span>
                    <strong>{st.t}</strong>
                    <span>{st.d}</span>
                  </li>
                ))}
              </ol>
              <div className={s.pair}>
                <figure className={s.figure}>
                  <LoopVideo {...LOOPS.editorFix} dark className={s.loopFrame} />
                  <figcaption>A drafted fix opens in the editor as a suggestion: Accept, then publish.</figcaption>
                </figure>
                <figure className={s.figure}>
                  <Shot
                    src="/docs-assets/guides/fix-list/fixlist-video.webp"
                    alt="A video item: Product tour loses most viewers at 0:40, with a chart of viewers still watching over its 1:40."
                    w={1120}
                    h={1112}
                  />
                  <figcaption>Video drop-off, from the same signals as Insights.</figcaption>
                </figure>
              </div>
              <div className={s.pillarCta}>
                <StartLink cta="pillar" pillar="fix_list" className={`md-btn md-btn--lg ${s.primary}`}>
                  Try the Fix list
                  <Icon name="arrowRight" size={16} />
                </StartLink>
                <a href={docs("studioFixList")} className={s.more} data-cta="docs">How the Fix list works</a>
              </div>
            </div>
          </section>

          {/* ── Live demos, video and PDFs ──────────────────────────── */}
          <section id="live-demos" aria-labelledby="demos-title" className={`${s.section} ${s.alt}`}>
            <div className={s.wrap}>
              <SectionHead
                eyebrow="Live demos, video and PDFs"
                id="demos-title"
                title="Docs where the demo actually runs."
                lead="Embed an interactive HTML demo, a PDF or a video from Markdrop as a live block in any page. Replace the file once and every page that shows it updates. Try this one: it's running right here."
              />
              <div className={s.browser}>
                <div className={s.chrome} aria-hidden="true">
                  <span className={s.dots}><i /><i /><i /></span>
                  <span className={s.addr}><Icon name="lock" size={11} /><span><span className={s.mu}>help.acme.com/</span>pricing</span></span>
                </div>
                <div className={s.docPage}>
                  <p className={s.docEb} aria-hidden="true">Billing</p>
                  <p className={s.docH} aria-hidden="true">Plans and pricing</p>
                  <p className={s.docP} aria-hidden="true">Work out what Acme costs for your team before you upgrade.</p>
                  <div className={s.embed}>
                    <div className={s.embedBar}>
                      <span className={s.embedT}><Icon name="code" size={13} />Acme pricing calculator</span>
                      <span className={s.embedK}>HTML · sandboxed</span>
                    </div>
                    <iframe
                      src="/guides-demo/acme-pricing-calculator.html"
                      title="Acme pricing calculator: a live, sandboxed demo (fictional prices)"
                      sandbox="allow-scripts"
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      className={s.frame}
                      data-live-demo
                    />
                    <details className={s.textVersion}>
                      <summary>Text version, for search, Ask AI, AI agents and screen readers</summary>
                      <p>{CALC_SUMMARY}</p>
                    </details>
                  </div>
                </div>
              </div>
              <div className={s.tiles}>
                <figure className={s.tile}>
                  <Shot src="/docs-assets/guides/embed-files/pdf.webp" alt="A PDF embedded in a guide page: the Acme price list 2026, page 1 of 3, with zoom, Fit width and Download." w={1520} h={1652} />
                  <figcaption><strong>PDFs</strong> page by page, with zoom and download, and the page where readers stop.</figcaption>
                </figure>
                <figure className={s.tile}>
                  <Shot src="/docs-assets/guides/embed-files/insights.webp" alt="Embedded files in Insights: the pricing calculator (64 views, 66% used it), the product tour (41 views, 30 plays, where viewers stop) and the price list." w={1600} h={543} />
                  <figcaption><strong>Video and per-embed analytics</strong>: chapters and captions, plays, where viewers stop, all fed into the Fix list.</figcaption>
                </figure>
                <figure className={s.tile}>
                  <Shot src="/docs-assets/guides/embed-files/sandbox-probe.webp" alt="A test page embedded in a guide reports what it can reach: localStorage, cookies, the guide page, IndexedDB, a service worker and navigating the guide away are all blocked, and its origin is opaque." w={1520} h={972} />
                  <figcaption><strong>Sandboxed</strong>: an embedded test page can't reach cookies, storage or the page around it.</figcaption>
                </figure>
              </div>
              <div className={s.security}>
                <h3 className={s.h3}><Icon name="shield" size={18} />Someone else&apos;s code, kept in its box</h3>
                <ul>
                  <li><strong>A separate site.</strong> Embedded files render on Markdrop&apos;s own file domain, never on your guide&apos;s address or markdrop.in.</li>
                  <li><strong>A locked sandbox.</strong> No cookies, no storage, no access to your page or any other customer&apos;s files, and no navigating your readers away. Scripts, forms and dialogs still work, so demos do too.</li>
                  <li><strong>Twice over.</strong> The file server repeats the sandbox as a security header, so it holds even when the file is opened on its own. The demo above is served the same way.</li>
                  <li><strong>Readable by AI.</strong> Every embed has a text version that goes to search, Ask AI, llms.txt and screen readers.</li>
                </ul>
              </div>
              <div className={s.pillarCta}>
                <StartLink cta="pillar" pillar="live_demos" className={`md-btn md-btn--lg ${s.primary}`}>
                  Embed a live demo
                  <Icon name="arrowRight" size={16} />
                </StartLink>
                <a href={EMBED_DOCS} className={s.more} data-cta="docs">How embeds work</a>
              </div>
            </div>
          </section>

          {/* ── Private pages ───────────────────────────────────────── */}
          <section id="private-pages" aria-labelledby="private-title" className={s.section}>
            <div className={s.wrap}>
              <SectionHead
                eyebrow={PRIVATE_PAGES_LIVE ? "Private pages, free" : "Private pages, free · Coming in November"}
                id="private-title"
                title="One guide, with pages for each customer."
                lead="Keep your public docs public, and lock the pages, groups or single sections that are only for your team, a customer, or anyone with the password. Free, where other tools ask for their top plans."
              />
              <div className={s.privGrid}>
                <ul className={s.rules}>
                  {PRIVATE_RULES.map((r) => (
                    <li key={r.t}>
                      <span className={s.wIcon} aria-hidden><Icon name={r.icon} size={15} /></span>
                      <span><strong>{r.t}</strong> {r.d}</span>
                    </li>
                  ))}
                  <li>
                    <span className={s.wIcon} aria-hidden><Icon name="eyeOff" size={15} /></span>
                    <span>
                      <strong>Nothing private leaks.</strong> Private pages stay out of search, llms.txt, the sitemap, the MCP server and Ask AI
                      for anyone who can&apos;t open them, and every publish checks it.
                    </span>
                  </li>
                </ul>
                <figure className={s.figure}>
                  <div className={s.window}>
                    <div className={s.chrome} aria-hidden="true">
                      <span className={s.dots}><i /><i /><i /></span>
                      <span className={s.addr}><Icon name="lock" size={11} /><span><span className={s.mu}>help.acme.com/</span>single-sign-on</span></span>
                    </div>
                    <LoopVideo {...LOOPS.private} dark />
                  </div>
                  <figcaption>
                    jane@northwind.com signs in with an emailed link, and the Northwind section of a public page opens for her. Recorded in a
                    published guide, with fictional data.
                  </figcaption>
                </figure>
              </div>
              {PRIVATE_PAGES_LIVE && (
                <figure className={`${s.figure} ${s.privShot}`}>
                  <Shot
                    src="/docs-assets/guides/private-pages/reader-locked-sections.webp"
                    alt="Acme Docs' public Single sign-on page as a signed-out reader sees it: the Northwind tenant values section locked to people at Northwind with Sign in with email, a private section for the team with Sign in, and the Enterprise and Team pages marked with a lock in the sidebar."
                    w={1400}
                    h={941}
                  />
                  <figcaption>A public page with two private sections, as a signed-out reader sees it (fictional data).</figcaption>
                </figure>
              )}
              <p className={s.contrast}>
                For comparison ({COMPARED_LABEL}): GitBook keeps authenticated access in Ultimate, $249 per site a month; Mintlify asks for Pro
                ($450 a month, billed yearly) for a password and Enterprise for reader sign-in. <a href="#compare">See the comparison</a>.
              </p>
              <div className={s.pillarCta}>
                <StartLink cta="pillar" pillar="private_pages" className={`md-btn md-btn--lg ${s.primary}`}>
                  Make a page private
                  <Icon name="arrowRight" size={16} />
                </StartLink>
                <a href={PRIVATE_PAGES_LIVE ? PRIVATE_DOCS : docs("guidesOverview")} className={s.more} data-cta="docs">How private pages work</a>
              </div>
            </div>
          </section>

          {/* ── Everything else ─────────────────────────────────────── */}
          <section id="features" aria-labelledby="features-title" className={`${s.section} ${s.alt}`}>
            <div className={s.wrap}>
              <SectionHead eyebrow="And the rest" id="features-title" title="Everything a docs site needs, included." />
              <ul className={s.grid}>
                {FEATURES.map((f) => (
                  <li key={f.t} className={s.feat}>
                    <span className={s.fIcon} aria-hidden><Icon name={f.icon} size={17} /></span>
                    <h3 className={s.fT}><a href={f.href}>{f.t}</a></h3>
                    <p className={s.fD}>{f.d}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* ── Move in ─────────────────────────────────────────────── */}
          <section id="import" aria-labelledby="import-title" className={s.section}>
            <div className={s.wrap}>
              <SectionHead
                eyebrow="Move in"
                id="import-title"
                title="Move from GitBook, Mintlify or GitHub in minutes."
                lead="Bring your pages, sidebar, images and old links across, then check a report of anything that needs a look before you publish. Your old site isn't touched."
              />
              <div className={s.moveGrid}>
              <figure className={`${s.figure} ${s.moveFig}`}>
                <div className={s.window}>
                  <div className={s.chrome} aria-hidden="true">
                    <span className={s.dots}><i /><i /><i /></span>
                    <span className={s.addr}><Icon name="lock" size={11} /><span><span className={s.mu}>markdrop.in/</span>guides/new</span></span>
                  </div>
                  <LoopVideo {...LOOPS.import} />
                </div>
                <figcaption>A GitBook import: the navigation, pages and images come across as drafts, sped up.</figcaption>
              </figure>
              <div className={s.moves}>
                <article className={s.move}>
                  <h3 className={s.h3}>From GitBook</h3>
                  <p>Paste your public GitBook address. Pages (hidden ones too), groups and order, images, icons, logo and accent colour come across, and old addresses redirect.</p>
                  <StartLink path={`${NEW_GUIDE}?start=gitbook`} cta="start" className={s.moveLink}>Import from GitBook<Icon name="arrowRight" size={14} /></StartLink>
                </article>
                <article className={s.move}>
                  <h3 className={s.h3}>From a GitHub repository</h3>
                  <p>
                    Markdown, GitBook Git Sync, Mintlify (<code>docs.json</code>), Docusaurus or MkDocs. Their callouts, tabs, steps and cards become
                    the guide&apos;s blocks, and <strong>Keep in sync</strong> updates the guide on every push.
                  </p>
                  <StartLink path={`${NEW_GUIDE}?start=github`} cta="start" className={s.moveLink}>Import from GitHub<Icon name="arrowRight" size={14} /></StartLink>
                </article>
                <article className={s.move}>
                  <h3 className={s.h3}>From an OpenAPI file</h3>
                  <p>Upload an OpenAPI 3.0 or 3.1 file and every endpoint gets a page with code samples and Try it.</p>
                  <StartLink path={`${NEW_GUIDE}?start=openapi`} cta="start" className={s.moveLink}>Start an API reference<Icon name="arrowRight" size={14} /></StartLink>
                </article>
              </div>
              </div>
            </div>
          </section>

          {/* ── Comparison ──────────────────────────────────────────── */}
          <section id="compare" aria-labelledby="compare-title" className={`${s.section} ${s.alt}`}>
            <div className={s.wrap}>
              <SectionHead
                eyebrow="Compare"
                id="compare-title"
                title="Markdrop Guides, GitBook and Mintlify."
                lead={<>What each includes and what it costs, {COMPARED_LABEL}. Every GitBook and Mintlify cell links to the page that says it; we checked them on <time dateTime={COMPARED_ON}>2 November 2026</time>. Prices change: check theirs before you decide.</>}
              />
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <caption className="sr-only">Markdrop Guides compared with GitBook and Mintlify, {COMPARED_LABEL}</caption>
                  <thead>
                    <tr>
                      <th scope="col"><span className="sr-only">Feature</span></th>
                      <th scope="col" className={s.us}>Markdrop Guides</th>
                      <th scope="col">GitBook</th>
                      <th scope="col">Mintlify</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARISON.map((r) => (
                      <tr key={r.label}>
                        <th scope="row">{r.label}</th>
                        <td className={s.us} data-col="Markdrop Guides"><CellView c={r.guides} guides /></td>
                        <td data-col="GitBook"><CellView c={r.gitbook} /></td>
                        <td data-col="Mintlify"><CellView c={r.mintlify} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className={s.notes}>
                {COMPARISON_NOTES.map((n) => (
                  <li key={n.text}>
                    {n.text}{" "}
                    <a href={n.href} target="_blank" rel="noopener noreferrer">{n.label}<span className="sr-only"> (opens in a new tab)</span></a>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* ── Pricing ─────────────────────────────────────────────── */}
          <section id="pricing" aria-labelledby="pricing-title" className={s.section}>
            <div className={s.wrap}>
              <SectionHead
                eyebrow="Pricing"
                id="pricing-title"
                title="Free while in beta."
                lead="Everything that's live is free today. Here's what we plan to charge after the beta, so you can decide with your eyes open. The plans aren't final; the rules below are."
              />
              <div className={s.plans}>
                <PlanCard p={BETA_PLAN} />
                {PLANNED_PLANS.map((p) => <PlanCard key={p.id} p={p} planned />)}
              </div>
              <ul className={s.rulesList}>
                {PRICING_RULES.map((r) => (
                  <li key={r}><Icon name="checkCircle" size={16} />{r}</li>
                ))}
              </ul>
              <div className={s.pillarCta}>
                <StartLink cta="pricing" className={`md-btn md-btn--lg ${s.primary}`}>
                  Start a guide free
                  <Icon name="arrowRight" size={16} />
                </StartLink>
              </div>
            </div>
          </section>

          {/* ── FAQ ─────────────────────────────────────────────────── */}
          <section id="faq" aria-labelledby="faq-title" className={`${s.section} ${s.alt}`}>
            <div className={`${s.wrap} ${s.narrow}`}>
              <SectionHead eyebrow="Questions" id="faq-title" title="Before you switch." />
              <div className={s.faq}>
                {FAQS.map((f) => (
                  <details key={f.q} className={s.qa}>
                    <summary><h3 className={s.q}>{f.q}</h3><Icon name="chevronDown" size={16} /></summary>
                    <div className={s.a}>
                      <p>{f.a}</p>
                      {f.links && (
                        <p className={s.aLinks}>
                          {f.links.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
                        </p>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          </section>

          {/* ── Final CTA ───────────────────────────────────────────── */}
          <section id="start" aria-labelledby="start-title" className={s.final}>
            <div className={`${s.wrap} ${s.finalIn}`}>
              <h2 id="start-title" className={s.h2}>Find out what your readers are stuck on.</h2>
              <p className={s.lead}>Start a guide, or bring yours over from GitBook, Mintlify or GitHub. Free while in beta.</p>
              <div className={s.ctas}>
                <StartLink cta="start" className={`md-btn md-btn--lg ${s.primary}`}>
                  Start a guide free
                  <Icon name="arrowRight" size={16} />
                </StartLink>
                <a href={docs("guidesOverview")} className="md-btn md-btn--secondary md-btn--lg" data-cta="docs">Read the docs</a>
              </div>
            </div>
          </section>
        </main>
        <SiteFooter />
        <FeedbackWidget />
        <LandingTracker />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      </div>
    </>
  );
}
