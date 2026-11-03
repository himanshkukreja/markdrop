import LoopVideo from "@/components/guides-landing/LoopVideo";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { ButtonLink, Icon } from "../ds";
import { SnapSection } from "@/components/marketing/snap/Snap";
import s from "./Sections.module.css";
import v from "./Pages.module.css";

/** What an embed can be: each renders in the page, as Markdrop shows the file itself. */
const KINDS = [
  { icon: "doc", label: "PDF" },
  { icon: "image", label: "Image" },
  { icon: "film", label: "Video" },
  { icon: "code", label: "HTML page" },
];

/**
 * Pages, after documents and files (the block editor; docs: pages/overview). The copy says what a
 * page is and what goes in it; the desk shows the real editor in a browser window on the mat: a
 * muted loop recorded on the page builder's mock stack with fictional Acme data ("/" → a callout, a
 * to-do, then a PDF and a photo from the workspace embedded live; re-record with
 * scripts/landing-samples/pages-loop). Beside it, the kinds of file that embed, and the locked
 * placeholder a reader without access sees instead. LoopVideo: poster first, plays only on screen,
 * paused under reduced motion, light and dark twins. Server HTML; the drawing's labels are
 * aria-hidden (the copy says it).
 */
export default function Pages() {
  return (
    <SnapSection id="pages" labelledBy="pages-h">
      <div className={`${s.split} ${s.splitRev}`}>
        <div className={s.copy}>
          <span className={s.eyebrow}>Pages · Beta</span>
          <h2 id="pages-h" className={s.h2}>
            <span className={v.line}>Write it here.</span> <span className={v.line}>Embed everything.</span>
          </h2>
          <p className={s.lede}>Write a page in blocks, then drop in any file or document from Markdrop. PDFs, images, video and HTML pages render live, right in the page.</p>
          <ul className={s.points}>
            <li>
              <Icon name="layers" />
              <span>
                <b>Type / for any block:</b> to-dos, toggles, callouts, tables, code, diagrams and math.
              </span>
            </li>
            <li>
              <Icon name="lock" />
              <span>
                <b>Embeds keep their own access.</b> Someone who can&apos;t open a file sees a locked placeholder, never its name.
              </span>
            </li>
            <li>
              <Icon name="listTree" />
              <span>
                <b>Templates and sub-pages.</b> Start from a spec, a runbook or meeting notes; sub-pages inherit the page&apos;s access.
              </span>
            </li>
            <li>
              <Icon name="sparkle" />
              <span>
                <b>Saves as you type</b> and shows who&apos;s viewing. AI apps can write pages too, through MCP.
              </span>
            </li>
          </ul>
          <div className={s.btnRow}>
            <ButtonLink href="/pages/new" variant="primary" iconLeft="plus" data-cta="pages_new">
              New page
            </ButtonLink>
            <a className={s.more} href={docsUrl(DOCS_PAGES.pagesOverview)} data-cta="pages_docs">
              How pages work
              <Icon name="arrowRight" />
            </a>
          </div>
        </div>

        <div className={s.fitBox} style={{ "--cw": "760px", "--ch": "620px" } as React.CSSProperties}>
          <div className={s.fitCanvas}>
            <div className={v.mat}>
              <div className={v.window}>
                <span className={v.tag} aria-hidden="true">
                  <Icon name="edit" />
                  Your page · editing
                </span>
                <div className={v.bar} aria-hidden="true">
                  <span className={v.dots}>
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className={v.url}>markdrop.in/launch-review</span>
                </div>
                <LoopVideo
                  src="/landing-desk/pages"
                  w={1200}
                  h={900}
                  dark
                  label="Markdrop's page editor: on a page called Launch review, typing / opens the block menu; a callout and a to-do are added, then the Q3 report PDF and a team photo from the Acme workspace are embedded and render live in the page, which saves itself."
                />
              </div>

              <div className={v.kinds} aria-hidden="true">
                <span className={v.kindsHead}>Embeds, live</span>
                {KINDS.map((k) => (
                  <span key={k.label} className={v.kind}>
                    <Icon name={k.icon} />
                    {k.label}
                  </span>
                ))}
              </div>

              <div className={v.locked} aria-hidden="true">
                <span className={v.tag}>
                  <Icon name="eyeOff" />
                  Without access
                </span>
                <div className={v.lockedBody}>
                  <span className={v.lockIcon}>
                    <Icon name="lock" />
                  </span>
                  <span>
                    <b>Sign in to see this</b>
                    <span>No title, no preview.</span>
                  </span>
                </div>
              </div>

              <span className={v.note} aria-hidden="true">
                one page,
                <br />
                every file inside.
              </span>
            </div>
          </div>
        </div>
      </div>
    </SnapSection>
  );
}
