import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { Icon } from "../ds";
import s from "./Sections.module.css";

const PINS = [
  { ext: "MD", title: "Documents", line: "Tables, code, Mermaid and math. No account.", r: "-1.5deg" },
  { ext: "HTML", title: "Interactive pages", line: "Run in a sandbox, buttons and all.", r: "1deg" },
  { ext: "PDF", title: "PDFs", line: "Page by page, nothing to download.", r: "-0.5deg" },
  { ext: "MP4", title: "Video", line: "Up to 2 GB, plays in the browser.", r: "1.5deg" },
  { ext: "XLSX", title: "Spreadsheets", line: "Every tab, readable anywhere.", r: "-1deg" },
];

/** 2 · "If it's on your desk, it opens." Five pinned cards. Server HTML, no script. */
export default function Renders() {
  return (
    <section id="renders" aria-labelledby="renders-h" className={s.section}>
      <div className={s.headRow}>
        <div className={s.headCol}>
          <span className={s.eyebrow}>What renders</span>
          <h2 id="renders-h" className={s.h2}>
            If it&apos;s on your desk, it opens.
          </h2>
        </div>
        <a className={s.more} href={docsUrl(DOCS_PAGES.supportedTypes)} data-cta="renders_docs">
          Everything that renders
          <Icon name="arrowRight" />
        </a>
      </div>
      <ul className={s.pins}>
        {PINS.map((p) => (
          <li key={p.ext} className={s.pin} style={{ "--r": p.r } as React.CSSProperties}>
            <span className={s.ext}>{p.ext}</span>
            <h3 className={s.pinTitle}>{p.title}</h3>
            <p className={s.pinLine}>{p.line}</p>
          </li>
        ))}
      </ul>
      <p className={s.foot}>
        Word docs and zipped sites too. Replace a file later and its link stays the same, with every version kept.
      </p>
    </section>
  );
}
