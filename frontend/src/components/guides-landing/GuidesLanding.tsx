import type { ReactNode } from "react";
import { SiteHeader } from "@/components/shell/SiteHeader";
import { SiteFooter } from "@/components/shell/SiteFooter";
import FeedbackWidget from "@/components/FeedbackWidget";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { Icon } from "@/components/landing/ds";
import TrailerButton, { type Trailer } from "@/components/landing/TrailerButton";
import { studioUrl } from "@/lib/studioHost";
import { SnapPage, SnapSection } from "@/components/marketing/snap/Snap";
import { parts as p } from "@/components/marketing/snap/Parts";
import DropHero from "./DropHero";
import FixLoop from "./FixLoop";
import Proof from "./Proof";
import Compare from "./Compare";
import LoopVideo from "./LoopVideo";
import { LOOPS } from "./loops";
import LandingTracker from "./LandingTracker";
import { BETA_PLAN, COMPARED_LABEL, COMPARED_ON, COMPARISON_NOTES, FAQS, PLANNED_PLANS, PRICING_RULES, type Plan } from "./content";
import s from "./GuidesLanding.module.css";

/**
 * The Markdrop Guides landing page: markdrop.in/guides, the same page for everyone, signed in or not
 * (the studio is on guides.markdrop.in). A server component with no request data, so the page is
 * static: the copy, the comparison, the pricing and the FAQ are server HTML. Islands: the hero's Fix
 * list card (HeroFixList), the fix loop (FixLoop), the recordings (Proof, LoopVideo), the comparison's
 * "Show all" (Compare), the tour button (TrailerButton: the player loads on click) and the analytics
 * listener (LandingTracker).
 *
 * Sections, one viewport each from 1024 × 640 (SnapPage / SnapSection, components/marketing/snap; the
 * comparison and the FAQ may run longer and snap at their start):
 *   hero (DropHero) · fix-loop · live-demos · private-pages · proof · ai · compare · pricing · faq · start
 *
 * Every number shown as data is the fictional Acme sample of the docs (guides/fix-list), and says so.
 * Every "start" link goes to the studio (StartLink); pillar buttons carry data-pillar for the
 * per-pillar interest count (lib/guidesEvents guide_landing_cta).
 */

/** Studio paths (lib/studioHost): the studio is on guides.markdrop.in. */
const NEW_GUIDE = "/new";
const IMPORT_GUIDE = "/new?start=gitbook";
const SIGNED_IN_LABEL = "Open your guides";
const docs = (topic: keyof typeof DOCS_PAGES) => docsUrl(DOCS_PAGES[topic]);

const TRAILER: Trailer = {
  src: "/docs-assets/videos/guides-trailer.mp4",
  poster: "/docs-assets/videos/guides-trailer.webp",
  title: "Markdrop Guides: docs that show you what to fix next",
  duration: "2:13",
  chaptersSrc: "/docs-assets/videos/guides-trailer.vtt",
  captionsSrc: "/docs-assets/videos/guides-trailer.captions.vtt",
  w: 1920,
  h: 1080,
};

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

function Head({ eyebrow, id, title, lede, className }: { eyebrow: string; id: string; title: ReactNode; lede?: ReactNode; className?: string }) {
  return (
    <header className={`${s.head} ${className ?? ""}`}>
      <p className={p.eyebrow}>{eyebrow}</p>
      <h2 id={id} className={`${p.h2} ${s.h2c}`}>{title}</h2>
      {lede && <p className={p.lede}>{lede}</p>}
    </header>
  );
}

function More({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={p.more} data-cta="docs">
      {children}
      <Icon name="arrowRight" size={15} />
    </a>
  );
}

const PRIMARY = `md-btn md-btn--lg ${s.primary}`;
const SECONDARY = "md-btn md-btn--secondary md-btn--lg";

const AI_CARDS: Array<{ k: string; d: ReactNode }> = [
  { k: "/mcp", d: <>Its own MCP server: <code>search_docs</code>, <code>read_page</code>, <code>whats_changed</code>, <code>report_problem</code>. Add to Cursor or VS Code in a click.</> },
  { k: "llms.txt", d: <>Every page with its description; <code>llms-full.txt</code> has the whole guide in one file, and <code>skill.md</code> tells agents how to use it.</> },
  { k: ".md", d: <>Any page as Markdown at its address plus <code>.md</code>, with the text of its videos and PDFs.</> },
  { k: "Ask AI", d: <>Answers from your published pages, each claim linked to the section it came from.</> },
];

/** The AI section's sample log (fictional Acme requests; what the Fix list makes of them: docs guides/fix-list "AI agents"). */
const AGENT_LOG: Array<{ who: string; what: string; out?: string; tone?: "ok" | "miss" | "fix" }> = [
  { who: "claude", what: "GET /quickstart.md", out: "200", tone: "ok" },
  { who: "chatgpt", what: "GET /llms-full.txt", out: "200", tone: "ok" },
  { who: "mcp", what: 'search_docs("terraform")', out: "0 results", tone: "miss" },
  { who: "", what: "→ Fix list · Agents find nothing", tone: "fix" },
  { who: "perplexity", what: "GET /changelog", out: "200", tone: "ok" },
  { who: "", what: "→ Fix list · Hard for agents: long, no headings", tone: "fix" },
];

const PRIVATE_POINTS: Array<{ icon: string; t: string; d: string }> = [
  { icon: "users", t: "Your team, a customer, or a password.", d: "Members, people or a whole email domain by emailed link (no account), or one password." },
  { icon: "layers", t: "A page, a group, or one section.", d: "Even a single section inside a public page." },
  { icon: "eyeOff", t: "Nothing private leaks.", d: "Left out of search, llms.txt, the sitemap, the MCP server and Ask AI for anyone who can't open it." },
];

function PlanCard({ plan: pl, planned }: { plan: Plan; planned?: boolean }) {
  return (
    <article className={s.plan} data-current={pl.current || undefined} aria-labelledby={`plan-${pl.id}`}>
      <div className={s.planTop}>
        <h3 id={`plan-${pl.id}`} className={s.planName}>{pl.name}</h3>
        {planned ? <span className={s.planned}>Planned</span> : <span className={s.now}>Now</span>}
      </div>
      <p className={s.price}>
        <strong>{pl.price}</strong> <span>{pl.unit}</span>
      </p>
      <p className={s.planNote}>{pl.note}</p>
      <ul className={s.planList}>
        {pl.points.map((x) => (
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
    "Build and host help centers, product guides and API docs. See where readers and AI agents drop off: a ranked Fix list shows what to fix next and drafts the fix; embed live demos, video and PDFs; keep pages private. Free while in beta.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free while in beta" },
  publisher: { "@type": "Organization", name: "Markdrop", url: "https://markdrop.in" },
};

export default function GuidesLanding() {
  return (
    <SnapPage data-guides-landing className={s.root}>
      <SiteHeader variant="marketing" />
      <main id="main" tabIndex={-1} className={s.main}>
        {/* ── 1. Hero: see where readers drop off ───────────────────────── */}
        <DropHero
          ctas={
            <>
              <StartLink cta="start" className={PRIMARY}>
                Start a guide free
                <Icon name="arrowRight" size={16} />
              </StartLink>
              <StartLink cta="start" path={IMPORT_GUIDE} className={SECONDARY}>
                Import your docs
              </StartLink>
              <TrailerButton trailer={TRAILER} className={`md-btn md-btn--ghost md-btn--lg ${s.tour}`} label="Watch the 2-minute tour" />
            </>
          }
        />

        {/* ── 2. Then fix it, right in the page ────────────────────────── */}
        <SnapSection id="fix-loop" labelledBy="fix-loop-title" className={s.sec}>
          <FixLoop
            actions={
              <>
                <StartLink cta="pillar" pillar="fix_list" className={PRIMARY}>
                  Try the Fix list
                  <Icon name="arrowRight" size={16} />
                </StartLink>
                <More href={docs("studioFixList")}>How the Fix list works</More>
              </>
            }
          />
        </SnapSection>

        {/* ── 3. Put the real thing in the page ────────────────────────── */}
        <SnapSection id="live-demos" labelledBy="files-title" className={s.sec}>
          <div className={`${p.split} ${p.rev}`}>
            <div className={p.copy}>
              <p className={p.eyebrow}>Live demos, video and PDFs</p>
              <h2 id="files-title" className={p.h2}>Put the real thing in the page.</h2>
              <p className={p.lede}>
                A working HTML demo, a video with chapters, a PDF to page through. Each one opens right in the docs, sandboxed on its own
                file domain. When viewers give up on a video or a PDF, it lands on your Fix list.
              </p>
              <div className={p.actions}>
                <StartLink cta="pillar" pillar="live_demos" className={PRIMARY}>
                  Embed a live demo
                  <Icon name="arrowRight" size={16} />
                </StartLink>
                <More href={docs("studioEmbedFiles")}>How embeds work</More>
              </div>
            </div>
            <div className={s.deskCol}>
              <div className={s.deskBox}>
                <div className={s.desk}>
                  <figure className={`${s.obj} ${s.laptop}`}>
                    <span className={s.tag} aria-hidden="true">calculator.html</span>
                    <div className={s.lid}>
                      <LoopVideo {...LOOPS.calc} dark />
                    </div>
                    <div className={s.base} aria-hidden="true" />
                    <figcaption className="sr-only">A pricing calculator, an HTML file embedded in a docs page, working as readers use it.</figcaption>
                  </figure>
                  <div className={`${s.obj} ${s.phone}`} role="img" aria-label="A product tour video embedded in a docs page, with chapters and captions">
                    <span className={s.tag} aria-hidden="true">tour.mp4</span>
                    <div className={s.phoneScreen} aria-hidden="true">
                      <span className={s.play}><Icon name="play" size={18} /></span>
                      <b>Product tour</b>
                      <small>1:40</small>
                      <span className={s.scrub}><i /></span>
                    </div>
                  </div>
                  <div className={`${s.obj} ${s.paper}`} role="img" aria-label="A PDF price list embedded in a docs page, page 1 of 3">
                    <span className={s.tag} aria-hidden="true">pricing.pdf</span>
                    <b aria-hidden="true">Acme price list 2026</b>
                    <i aria-hidden="true" style={{ width: "90%" }} />
                    <i aria-hidden="true" style={{ width: "70%" }} />
                    <i aria-hidden="true" style={{ width: "82%" }} />
                    <small aria-hidden="true">Page 1 of 3</small>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </SnapSection>

        {/* ── 4. Some pages are just for some readers ─────────────────── */}
        <SnapSection id="private-pages" labelledBy="private-title" className={s.sec}>
          <div className={p.split}>
            <div className={p.copy}>
              <p className={p.eyebrow}>Private pages, free</p>
              <h2 id="private-title" className={`${p.h2} ${s.h2c}`}>Some pages are just for some readers. Free.</h2>
              <p className={p.lede}>
                Seal a page or one section for your team, an email domain or a single customer. Everyone else sees the public docs, and so
                does every AI tool.
              </p>
              <ul className={p.points}>
                {PRIVATE_POINTS.map((x) => (
                  <li key={x.t}>
                    <Icon name={x.icon} />
                    <span><b>{x.t}</b> {x.d}</span>
                  </li>
                ))}
              </ul>
              <div className={p.actions}>
                <StartLink cta="pillar" pillar="private_pages" className={PRIMARY}>
                  Make a page private
                  <Icon name="arrowRight" size={16} />
                </StartLink>
                <More href={docs("privatePages")}>How private pages work</More>
              </div>
            </div>
            <div className={s.env} role="img" aria-label="A public docs page, and behind a seal the Enterprise rollout plan, readable only by people at acme.com, people at Northwind (a customer), or anyone with the password">
              <div className={s.pub} aria-hidden="true">
                <small>help.acme.com · public</small>
                <b>Rollout overview</b>
                <i style={{ width: "88%" }} />
                <i style={{ width: "70%" }} />
                <i style={{ width: "80%" }} />
                <i style={{ width: "54%" }} />
              </div>
              <div className={s.seal} aria-hidden="true">
                <span className={s.lock}>
                  <Icon name="lock" size={26} />
                </span>
                <b>Enterprise rollout plan</b>
                <i style={{ width: "92%" }} />
                <i style={{ width: "76%" }} />
                <i style={{ width: "84%" }} />
                <div className={s.who}>
                  <span>@acme.com</span>
                  <span>@northwind.com</span>
                  <span>Password</span>
                </div>
              </div>
            </div>
          </div>
        </SnapSection>

        {/* ── 5. See it for real ──────────────────────────────────────── */}
        <SnapSection id="proof" labelledBy="proof-title" className={s.sec}>
          <Proof
            head={
              <div className={p.copy}>
                <p className={p.eyebrow}>Recorded in the product</p>
                <h2 id="proof-title" className={`${p.h2} ${s.h2c}`}>See it for real.</h2>
                <p className={p.lede}>Short loops of the studio and a published guide.</p>
              </div>
            }
          />
        </SnapSection>

        {/* ── 6. Agents drop off too ──────────────────────────────────── */}
        <SnapSection id="ai" labelledBy="ai-title" className={s.sec}>
          <div className={s.aiTop}>
            <div className={p.copy}>
              <p className={p.eyebrow}>Ready for AI</p>
              <h2 id="ai-title" className={`${p.h2} ${s.h2c}`}>Agents drop off too. Now you can see it.</h2>
              <p className={p.lede}>
                Every guide serves what AI tools read well, and the Fix list counts agent reads apart from people. When an assistant finds
                nothing, or a page is hard for agents to use, it lands on your Fix list.
              </p>
              <div className={p.actions}>
                <More href={docs("studioAiReady")}>llms.txt, MCP and agents</More>
              </div>
            </div>
            <figure className={s.log}>
              <figcaption>Example requests to acme.guides.markdrop.in</figcaption>
              <ol>
                {AGENT_LOG.map((l, i) => (
                  <li key={i} data-tone={l.tone}>
                    <b>{l.who}</b>
                    <span>{l.what}</span>
                    {l.out && <em>{l.out}</em>}
                  </li>
                ))}
              </ol>
            </figure>
          </div>
          <ul className={s.ai}>
            {AI_CARDS.map((c) => (
              <li key={c.k}>
                <code className={s.aiK}>{c.k}</code>
                <p>{c.d}</p>
              </li>
            ))}
          </ul>
        </SnapSection>

        {/* ── 7. Comparison ───────────────────────────────────────────── */}
        <SnapSection id="compare" labelledBy="compare-title" className={`${s.sec} ${s.tall}`}>
          <Head
            eyebrow="Compare"
            id="compare-title"
            title="Markdrop Guides, GitBook and Mintlify."
            lede={
              <>
                What each includes and costs, {COMPARED_LABEL}. Every GitBook and Mintlify cell links to its source, checked on{" "}
                <time dateTime={COMPARED_ON}>2 November 2026</time>. Prices change: check theirs before you decide.
              </>
            }
          />
          <Compare />
          <ul className={s.notes}>
            {COMPARISON_NOTES.map((n) => (
              <li key={n.text}>
                {n.text}{" "}
                <a href={n.href} target="_blank" rel="noopener noreferrer">
                  {n.label}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </SnapSection>

        {/* ── 8. Pricing ──────────────────────────────────────────────── */}
        <SnapSection id="pricing" labelledBy="pricing-title" className={s.sec}>
          <div className={s.headRow}>
            <Head
              eyebrow="Pricing"
              id="pricing-title"
              title="Free while in beta."
              lede="Everything that's live is free today. Below is what we plan to charge after the beta: the plans aren't final, the rules are."
            />
            <StartLink cta="pricing" className={PRIMARY}>
              Start a guide free
              <Icon name="arrowRight" size={16} />
            </StartLink>
          </div>
          <div className={s.plans}>
            <PlanCard plan={BETA_PLAN} />
            {PLANNED_PLANS.map((x) => (
              <PlanCard key={x.id} plan={x} planned />
            ))}
          </div>
          <p className={s.rules}>
            <Icon name="checkCircle" size={15} />
            <span>{PRICING_RULES.join(" ")}</span>
          </p>
        </SnapSection>

        {/* ── 9. FAQ ──────────────────────────────────────────────────── */}
        <SnapSection id="faq" labelledBy="faq-title" className={s.sec}>
          <div className={s.faqGrid}>
            <div className={p.copy}>
              <p className={p.eyebrow}>Questions</p>
              <h2 id="faq-title" className={`${p.h2} ${s.h2c}`}>Before you switch.</h2>
              <p className={p.lede}>The six we hear most. Pricing, limits, imports and troubleshooting are in the full FAQ.</p>
              <div className={p.actions}>
                <More href={docs("studioFaq")}>All questions</More>
              </div>
            </div>
            <div className={s.faq}>
              {FAQS.map((f) => (
                <details key={f.q} className={s.qa}>
                  <summary>
                    <h3 className={s.q}>{f.q}</h3>
                    <Icon name="chevronDown" size={16} />
                  </summary>
                  <div className={s.a}>
                    <p>{f.a}</p>
                    {f.links && (
                      <p className={s.aLinks}>
                        {f.links.map((l) => (
                          <a key={l.href} href={l.href}>{l.label}</a>
                        ))}
                      </p>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </div>
        </SnapSection>

        {/* ── 10. Close ───────────────────────────────────────────────── */}
        <SnapSection id="start" labelledBy="start-title" className={s.sec}>
          <div className={s.close}>
            <h2 id="start-title" className={s.closeH}>
              Fewer <span className={s.dropWord}>drop</span>-offs, every week.
            </h2>
            <p className={p.lede}>Bring your docs from GitBook, Mintlify, Docusaurus, MkDocs or GitHub. Free while in beta.</p>
            <div className={s.ctas}>
              <StartLink cta="start" className={PRIMARY}>
                Start a guide free
                <Icon name="arrowRight" size={16} />
              </StartLink>
              <StartLink cta="start" path={IMPORT_GUIDE} className={SECONDARY}>
                Import your docs
              </StartLink>
            </div>
            <p className={s.from}>
              Or start from{" "}
              <StartLink cta="start" path="/new?start=github">a GitHub repository</StartLink>,{" "}
              <StartLink cta="start" path="/new?start=openapi">an OpenAPI file</StartLink>, or{" "}
              <a href={docs("guidesOverview")} data-cta="docs">read the docs</a>.
            </p>
          </div>
        </SnapSection>
      </main>
      <SiteFooter />
      <FeedbackWidget />
      <LandingTracker />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
    </SnapPage>
  );
}
