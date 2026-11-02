import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { Icon } from "../ds";
import s from "./Sections.module.css";
import t from "./theme.module.css";

/** One pinned card per kind of file; the picture is the desk sample, as Markdrop renders it. */
const PINS = [
  { id: "md", ext: "MD", title: "Documents", line: "Tables, code, Mermaid diagrams and math. Edit it later at the same link.", r: "-1.5deg", dark: true },
  { id: "html", ext: "HTML", title: "Interactive pages", line: "Scripts run in a sandbox, so buttons, charts and calculators work.", r: "1deg", dark: false },
  { id: "pdf", ext: "PDF", title: "PDFs", line: "Page by page in the browser. Nothing to download.", r: "-0.5deg", dark: true },
  { id: "sheet", ext: "XLSX", title: "Spreadsheets", line: "Every sheet as its own tab. CSV and .xls too.", r: "1.5deg", dark: true },
  { id: "video", ext: "MP4", title: "Video and audio", line: "Up to 2 GB, and it plays in the browser.", r: "-1deg", dark: false },
];

/** 2 · Documents and files: what renders. Five pinned cards and what happens later. Server HTML. */
export default function Renders() {
  return (
    <section id="renders" aria-labelledby="renders-h" className={s.section}>
      <div className={s.headRow}>
        <div className={s.headCol}>
          <span className={s.eyebrow}>Documents and files</span>
          <h2 id="renders-h" className={s.h2}>
            If it&apos;s on your desk, it opens.
          </h2>
        </div>
        <div className={s.headSide}>
          <p className={s.lede}>Write in Markdown or upload the file you already have. People see it rendered in their browser, with nothing to download or install.</p>
          <a className={s.more} href={docsUrl(DOCS_PAGES.supportedTypes)} data-cta="renders_docs">
            See every file type
            <Icon name="arrowRight" />
          </a>
        </div>
      </div>
      <ul className={s.pins}>
        {PINS.map((p) => (
          <li key={p.ext} className={s.pin} style={{ "--r": p.r } as React.CSSProperties}>
            <span className={s.pinShot} aria-hidden="true">
              <img className={p.dark ? t.light : undefined} src={`/landing-desk/posters/${p.id}.webp`} alt="" width={838} height={662} loading="lazy" decoding="async" />
              {p.dark && <img className={t.dark} src={`/landing-desk/posters/${p.id}.dark.webp`} alt="" width={838} height={662} loading="lazy" decoding="async" />}
            </span>
            <span className={s.ext}>{p.ext}</span>
            <h3 className={s.pinTitle}>{p.title}</h3>
            <p className={s.pinLine}>{p.line}</p>
          </li>
        ))}
      </ul>
      <ul className={s.later}>
        <li>
          <Icon name="refresh" />
          <span>
            <b>Replace the file, keep the link.</b> Anyone with it open gets the new version without reloading.
          </span>
        </li>
        <li>
          <Icon name="history" />
          <span>
            <b>The last 5 versions are kept.</b> Restore any of them in the browser or from the CLI.
          </span>
        </li>
        <li>
          <Icon name="layers" />
          <span>
            <b>Word documents, images and zipped websites</b> open too. Other files up to 25 MB.
          </span>
        </li>
      </ul>
    </section>
  );
}
