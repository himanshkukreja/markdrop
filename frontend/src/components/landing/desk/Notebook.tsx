"use client";

import { useState } from "react";
import TrailerButton, { type Trailer } from "../docs-studio/TrailerButton";
import { Icon } from "../orbit/ds";
import s from "./Sections.module.css";
import t from "./theme.module.css";

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

/**
 * Fix list items in the studio's own words (components/docs-sites/fixesModel TYPE_META, LEVEL_META),
 * on the page in the notebook: `top` is where the item's section sits on that page.
 */
const FIXES = [
  { kind: "Readers leave here", icon: "arrowDown", level: "high", title: "Readers leave at “Install the CLI”", line: "42% of readers stop here on “Quickstart”.", count: "131 readers left here", flag: "Readers stop here", top: "58.6%" },
  { kind: "Marked not helpful", icon: "flag", level: "high", title: "“Quickstart” marked not helpful", line: "4 of 10 readers said it didn’t help.", count: "110 readers affected", flag: "Marked not helpful", top: "8.4%" },
  { kind: "Ask AI couldn’t answer", icon: "sparkle", level: "medium", title: "“Can I sign in with SSO?”", line: "Asked on “Quickstart”; the docs don’t say.", count: "9 unanswered questions", flag: "Ask AI had no answer", top: "93%" },
] as const;

/**
 * 4 · Markdrop Guides. A spiral notebook holding a real guide page (help.acme.com's Quickstart,
 * recorded on the sandbox stack), with sticky flags pulsing where readers gave up. Hover a Fix list
 * row and its flag lifts (the flags carry the same words, so nothing is hover-only).
 */
export default function Notebook() {
  const [hi, setHi] = useState(-1);
  return (
    <section id="guides" aria-labelledby="guides-h" className={s.section}>
      <div className={s.guidesGrid}>
        <div className={s.nb}>
          <div className={s.nbPage}>
            <span className={s.rings} aria-hidden="true" />
            <span className={s.nbUrl}>help.acme.com/quickstart</span>
            <div style={{ position: "relative" }}>
              <img className={`${s.nbShot} ${t.light}`} src="/landing-desk/screens/guide-page.webp" alt="Acme's Quickstart page in Markdrop Guides: Before you start, Install the CLI, Create a project." width={900} height={892} loading="lazy" decoding="async" />
              <img className={`${s.nbShot} ${t.dark}`} src="/landing-desk/screens/guide-page.dark.webp" alt="Acme's Quickstart page in Markdrop Guides: Before you start, Install the CLI, Create a project." width={900} height={892} loading="lazy" decoding="async" />
              <div className={s.flags}>
                {FIXES.map((f, i) => (
                  <span key={f.flag} className={s.flag} data-hi={hi === i ? "" : undefined} style={{ top: `calc(${f.top} - 17px)`, right: -40 }}>
                    <span className={s.dot} aria-hidden="true" />
                    {f.flag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className={s.guidesCopy}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className={s.eyebrow}>Markdrop Guides</span>
            <span className="md-badge md-badge--info">Free in beta</span>
          </div>
          <h2 id="guides-h" className={s.h2}>
            Docs that show you what to fix next.
          </h2>
          <p className={s.lede}>Host your help center. Every flag is a place readers gave up, ranked, with a drafted fix.</p>
          <ul className={s.fixList} aria-label="Fix list">
            {FIXES.map((f, i) => (
              <li key={f.title}>
                <div
                  className={s.fix}
                  data-hi={hi === i ? "" : undefined}
                  onMouseEnter={() => setHi(i)}
                  onMouseLeave={() => setHi(-1)}
                >
                  <span className={s.fixIcon} data-level={f.level} aria-hidden="true">
                    <Icon name={f.icon} />
                  </span>
                  <span className={s.fixText}>
                    <span className={s.fixKind}>{f.kind}</span>
                    <span className={s.fixTitle}>{f.title}</span>
                    <span className={s.fixLine}>{f.line}</span>
                  </span>
                  <span className={s.fixSide}>
                    <span className={s.level} data-level={f.level}>
                      {f.level === "high" ? "High impact" : "Medium"}
                    </span>
                    {f.count}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className={s.small}>Private pages free. Live demos inside the page. GitHub sync.</p>
          <div className={s.btnRow}>
            <a className="md-btn md-btn--secondary md-btn--lg" href="/guides" data-cta="guides_explore">
              Explore Guides
              <Icon name="arrowRight" />
            </a>
            <TrailerButton trailer={TRAILER} className="md-btn md-btn--ghost md-btn--lg" label="Watch the 2-minute tour" />
          </div>
        </div>
      </div>
    </section>
  );
}
