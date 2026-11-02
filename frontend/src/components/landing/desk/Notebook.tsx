import TrailerButton, { type Trailer } from "../TrailerButton";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { Icon } from "../ds";
import s from "./Sections.module.css";
import t from "./theme.module.css";
import { SnapSection } from "@/components/marketing/snap/Snap";

/** The Markdrop Guides trailer (public/docs-assets/videos; the same file the Guides overview plays). */
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

/** The flags on the notebook: where readers gave up on this page (the Fix list's own words). */
const FLAGS = [
  { flag: "Marked not helpful", top: "8.4%" },
  { flag: "Readers stop here", top: "58.6%" },
  { flag: "Ask AI had no answer", top: "93%" },
];

/**
 * 5 · Markdrop Guides. The copy says what Guides is and does; the desk shows a spiral notebook
 * holding a real guide page (help.acme.com's Quickstart, recorded on the sandbox stack), with sticky
 * flags pulsing where readers gave up, the way the Fix list marks them. Server HTML; the trailer
 * button is the only island.
 */
export default function Notebook() {
  return (
    <SnapSection id="guides" labelledBy="guides-h">
      <div className={s.split}>
        <div className={s.copy}>
          <div className={s.copyTop}>
            <span className={s.eyebrow}>Markdrop Guides</span>
            <span className="md-badge md-badge--info">Free in beta</span>
          </div>
          <h2 id="guides-h" className={s.h2}>
            Docs that show you what to fix next.
          </h2>
          <p className={s.lede}>Host your help center, product guides or API reference on Markdrop. Guides sees where readers give up and ranks what to fix first.</p>
          <ul className={s.points}>
            <li>
              <Icon name="flag" />
              <span>
                <b>A Fix list</b> ranks where readers leave, searches that found nothing and questions Ask AI couldn&apos;t answer. AI drafts the fix.
              </span>
            </li>
            <li>
              <Icon name="github" />
              <span>
                <b>Import from GitBook or GitHub.</b> A GitHub repo can keep the guide in sync on every push.
              </span>
            </li>
            <li>
              <Icon name="sparkle" />
              <span>
                <b>Ask AI</b> answers from your pages, with sources. Agents get an MCP server and llms.txt.
              </span>
            </li>
            <li>
              <Icon name="film" />
              <span>
                <b>Live demos, videos and PDFs</b> inside the page. Private pages and your own domain.
              </span>
            </li>
          </ul>
          <div className={s.btnRow}>
            <a className="md-btn md-btn--secondary md-btn--lg" href="/guides" data-cta="guides_explore">
              Explore Guides
              <Icon name="arrowRight" />
            </a>
            <TrailerButton trailer={TRAILER} className="md-btn md-btn--ghost md-btn--lg" label="Watch the 2-minute tour" />
          </div>
          <a className={s.more} href={docsUrl(DOCS_PAGES.guidesOverview)} data-cta="guides_docs">
            How Guides works
            <Icon name="arrowRight" />
          </a>
        </div>
        <div className={s.nb}>
          <div className={s.nbPage}>
            <span className={s.rings} aria-hidden="true" />
            <span className={s.nbUrl}>help.acme.com/quickstart</span>
            <div style={{ position: "relative" }}>
              <img className={`${s.nbShot} ${t.light}`} src="/landing-desk/screens/guide-page.webp" alt="Acme's Quickstart page in Markdrop Guides: Before you start, Install the CLI, Create a project." width={900} height={892} loading="lazy" decoding="async" />
              <img className={`${s.nbShot} ${t.dark}`} src="/landing-desk/screens/guide-page.dark.webp" alt="Acme's Quickstart page in Markdrop Guides: Before you start, Install the CLI, Create a project." width={900} height={892} loading="lazy" decoding="async" />
              <div className={s.flags}>
                {FLAGS.map((f) => (
                  <span key={f.flag} className={s.flag} style={{ top: `calc(${f.top} - 17px)`, right: -40 }}>
                    <span className={s.dot} aria-hidden="true" />
                    {f.flag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </SnapSection>
  );
}
