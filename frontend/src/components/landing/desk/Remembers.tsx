import PosterPlayer from "../PosterPlayer";
import type { Trailer } from "../TrailerButton";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { MEETINGS_START_PATH } from "@/lib/meetingsStart";
import { ButtonLink, Icon } from "../ds";
import s from "./Sections.module.css";
import { SnapSection } from "@/components/marketing/snap/Snap";

/** The Meetings + Team video (public/docs-assets/videos; the same file the docs page plays). */
const VIDEO: Trailer = {
  src: "/docs-assets/videos/team-meetings.mp4",
  poster: "/docs-assets/videos/team-meetings.webp",
  title: "Your workspace remembers",
  duration: "2:23",
  chaptersSrc: "/docs-assets/videos/team-meetings.vtt",
  captionsSrc: "/docs-assets/videos/team-meetings.captions.vtt",
  w: 1920,
  h: 1080,
};

/**
 * 5 · Your workspace remembers (Meetings and Team; docs: workspaces/meetings-and-team). After
 * documents, files and workspaces, the third story: the workspace knows its own context. The copy
 * says what it does in three proof points; the desk shows the video (one team's day at the fictional
 * Acme) as a picture that plays on click (its poster is the Team board: status and This week),
 * with a sticky note and the question Maya asks in it.
 * Server HTML; PosterPlayer is the only island, and nothing of the video loads before the click.
 */
export default function Remembers() {
  return (
    <SnapSection id="remembers" labelledBy="remembers-h">
      <div className={s.split}>
        <div className={s.copy}>
          <div className={s.copyTop}>
            <span className={s.eyebrow}>Meetings and Team</span>
            <span className="md-badge md-badge--info">For teams</span>
          </div>
          <h2 id="remembers-h" className={s.h2}>
            Your workspace remembers.
          </h2>
          <p className={s.lede}>Every call becomes a page, and your workspace keeps track of who&apos;s doing what. Ask it anything, and the answer links to the moment it was said.</p>
          <ul className={s.points}>
            <li>
              <Icon name="inbox" />
              <span>
                <b>Notes arrive by themselves.</b> Meet&apos;s transcript and Gemini&apos;s notes become a page: the summary, the decisions, the action items and their owners.
              </span>
            </li>
            <li>
              <Icon name="checkSquare" />
              <span>
                <b>Everyone gets their action items.</b> One Slack message each, only their own, with due dates. Done ticks it off on the page.
              </span>
            </li>
            <li>
              <Icon name="sparkle" />
              <span>
                <b>Ask what anyone&apos;s working on.</b> Team keeps a card for each person, and Ask your workspace answers with sources. One-on-ones stay with the people who were there.
              </span>
            </li>
          </ul>
          {/* /meetings/start: sign in if needed, then the first workspace's Meetings with Connect Google Meet open. */}
          <div className={s.btnRow}>
            <ButtonLink href={MEETINGS_START_PATH} variant="primary" iconRight="arrowRight" data-cta="remembers_start">
              Start with your team
            </ButtonLink>
          </div>
          <a className={s.more} href={docsUrl(DOCS_PAGES.meetingsAndTeam)} data-cta="remembers_docs">
            How Meetings and Team work
            <Icon name="arrowRight" />
          </a>
        </div>

        <div className={s.memVisual}>
          <div className={s.memScreen}>
            <span className={s.memTape} aria-hidden="true" />
            <PosterPlayer video={VIDEO} cta="remembers_play" alt="Play the video: one day at Acme with Markdrop Meetings and Team. Acme's Team board: 3 on track, 1 blocked or waiting, and This week's highlights and what's due." />
          </div>
          <span className={s.memSticky} aria-hidden="true">
            Maya&apos;s first week
            <br />
            at Acme.
            <span>One day, 2:23</span>
          </span>
          <span className={s.memAsk} aria-hidden="true">
            <Icon name="sparkle" />
            What is Sam working on?
          </span>
        </div>
      </div>
    </SnapSection>
  );
}
