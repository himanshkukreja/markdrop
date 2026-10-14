import Link from "next/link";
import LazyIsland from "../../LazyIsland";
import View from "./View";
import { initialState } from "./model";
import { Drop, Icon } from "./parts";
import s from "./RenderBench.module.css";

/**
 * Render Bench, landing section 2 (the artifacts pillar, first toy under the hero). Server component:
 * the heading, lead, CTA and the honest notes are plain server HTML; the bench itself is a lazy island
 * whose static first frame is `View(initialState)`.
 */
export default function RenderBench() {
  return (
    <section id="render-bench" aria-labelledby="render-bench-title" className={s.section}>
      <div className={s.bgGrid} aria-hidden="true" />
      <div className={s.bgAmb} aria-hidden="true" />
      <div className={`${s.container} mx-auto max-w-marketing px-4 sm:px-6`}>
        <header className={s.head}>
          <p className={s.eye}>
            <Drop width={10} height={13} />
            Files that render
          </p>
          <h2 id="render-bench-title" className={s.h2}>
            Upload a file. Share a link that opens it.
          </h2>
          <p className={s.lead}>
            HTML pages, PDFs, spreadsheets, Word docs, images, video and zipped sites open rendered in any browser, with nothing to download.
          </p>
        </header>

        <LazyIsland name="render-bench">
          <View state={initialState} />
        </LazyIsland>

        <div className={s.ft}>
          <div className={s.ctaRow}>
            <span className={s.cta}>
              <Link href="/upload" className="md-btn md-btn--primary md-btn--lg" data-cta="toy_render_bench_upload">
                <Icon name="upload" size={16} />
                Upload a file
              </Link>
            </span>
            <span className="md-badge md-badge--info">
              <Icon name="user" size={12} />
              Free account to upload
            </span>
          </div>
          <span className={s.ftSep} aria-hidden="true" />
          <ul className={s.facts}>
            <li className={s.fact}>
              <span className={s.fi}>
                <Icon name="globe" size={14} />
              </span>
              Files are served from a separate, sandboxed domain.
            </li>
            <li className={s.fact}>
              <span className={s.fi}>
                <Icon name="lock" size={14} />
              </span>
              Protected by password or access level, not end-to-end encryption.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
