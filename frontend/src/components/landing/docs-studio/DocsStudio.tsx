import Link from "next/link";
import { DOCS_URL } from "@/components/shell/links";
import { Icon, StudioGlyph } from "../orbit/ds";
import s from "./DocsStudio.module.css";

/**
 * Landing section: Docs Studio, the docs-site builder and host (the third thing Markdrop publishes,
 * after documents and files). Server component with no JavaScript: the head, the feature list and the
 * CTAs are plain server HTML, and the picture is a code-drawn UI (the studio editor and the published
 * site it builds), not screenshots. The theme picker above the picture is a real radio group that
 * re-skins the drawn site through CSS (:has), so it works before and without any script.
 * Nothing in it moves on its own, so reduced motion and the page's one-autoplay rule have nothing to stop.
 */

/** The docs page that explains Docs Studio. Not written yet: a plain href, so docs:check skips it. */
const SEE_IT_LIVE = `${DOCS_URL}/docs-studio/overview`;

const THEMES: Array<{ id: string; label: string }> = [
  { id: "brand", label: "Your brand" },
  { id: "clean", label: "Clean" },
  { id: "editorial", label: "Editorial" },
  { id: "technical", label: "Technical" },
  { id: "minimal", label: "Minimal" },
  { id: "playful", label: "Playful" },
  { id: "helpcenter", label: "Help center" },
];

const FEATURES: Array<{ icon: string; title: string; line: string }> = [
  { icon: "edit", title: "Visual and Markdown editor", line: "Write in blocks with a slash menu, or switch the page to Markdown." },
  { icon: "palette", title: "Six themes, or your brand", line: "Pick a theme, or add your logo and colours and the site matches them." },
  { icon: "sparkle", title: "Ask AI with citations", line: "Readers ask in their own words and get answers that link to your pages." },
  { icon: "code", title: "API reference with Try it", line: "Add your OpenAPI file. Readers send real requests from the page." },
  { icon: "history", title: "Changelog", line: "Post release notes to a changelog on the same site." },
  { icon: "download", title: "GitBook import", line: "Bring an existing GitBook site over, pages and navigation included." },
  { icon: "users", title: "Review and restore", line: "Changes go live after review. Restore an earlier version in one click." },
  { icon: "globe", title: "Your domain", line: "Serve the site on a domain you own, like docs.example.com." },
  { icon: "zap", title: "Free while in beta", line: "Every feature, with no per-editor pricing. Bring your whole team." },
  { icon: "server", title: "Open source", line: "Host it yourself with Docker, or let Markdrop host it for you." },
];

function Editor() {
  return (
    <div className={s.editor} aria-hidden="true">
      <div className={s.edBar}>
        <span className={s.edApp}><StudioGlyph size={14} />Example Docs</span>
        <span className={s.crumb}>/</span>
        <span className={s.edPage}>Quickstart</span>
        <span className={s.seg}><b>Visual</b><span>Markdown</span></span>
        <span className={s.review}>Request review</span>
      </div>
      <div className={s.edBody}>
        <div className={s.tree}>
          <span className={s.treeH}>Get started</span>
          <span>Introduction</span>
          <span className={s.on}>Quickstart</span>
          <span>Authentication</span>
          <span className={s.treeH}>API reference</span>
          <span><i className={s.post}>POST</i>Payments</span>
          <span><i className={s.get}>GET</i>Customers</span>
          <span className={s.treeH}>Changelog</span>
        </div>
        <div className={s.doc}>
          <span className={s.docH}>Quickstart</span>
          <span className={s.docP}>Install the SDK and send your first request.</span>
          <span className={s.callout}><Icon name="bulb" size={13} /><span>Use a test key while you build.</span></span>
          <span className={s.code}>
            <span className={s.codeTabs}><b>npm</b><span>pnpm</span></span>
            <span className={s.codeLine}><span className={s.mu}>$ </span>npm install @example/sdk</span>
          </span>
          <span className={s.slash}>/api<span className={s.caret} /></span>
          <span className={s.menu}>
            <span className={s.on}><Icon name="code" size={13} />API endpoint</span>
            <span><Icon name="info" size={13} />Callout</span>
            <span><Icon name="columns" size={13} />Tabs</span>
            <span><Icon name="history" size={13} />Changelog entry</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Site() {
  return (
    <div className={s.site} aria-hidden="true">
      <div className={s.chrome}>
        <span className={s.dots}><i /><i /><i /></span>
        <span className={s.addr}><Icon name="lock" size={11} /><span><span className={s.mu}>docs.example.com/</span>quickstart</span></span>
      </div>
      <div className={s.sHead}>
        <span className={s.logo}>E</span>
        <span className={s.sName}>Example Docs</span>
        <span className={s.topNav}><b>Guides</b><span>API</span><span>Changelog</span></span>
        <span className={s.search}><Icon name="search" size={12} />Search or ask</span>
        <span className={s.askBtn}><Icon name="sparkle" size={12} />Ask AI</span>
      </div>
      <div className={s.hero}>
        <span className={s.heroT}>How can we help?</span>
        <span className={s.heroS}><Icon name="search" size={13} />Search articles or ask a question</span>
      </div>
      <div className={s.sBody}>
        <div className={s.sSide}>
          <span className={s.sideH}>Get started</span>
          <span>Introduction</span>
          <span className={s.on}>Quickstart</span>
          <span>Authentication</span>
          <span className={s.sideH}>API reference</span>
          <span>Payments</span>
          <span>Customers</span>
        </div>
        <div className={s.page}>
          <span className={s.pEb}>Get started</span>
          <span className={s.pH}>Quickstart</span>
          <span className={s.pP}>Install the SDK and send your first request.</span>
          <span className={s.pCode}><span className={s.mu}>$ </span>npm install @example/sdk</span>
          <span className={s.pNext}>Next: Authentication <Icon name="arrowRight" size={12} /></span>
        </div>
      </div>
      <div className={s.ask}>
        <span className={s.askQ}>How do I authenticate requests?</span>
        <span className={s.askA}>Send your API key in the <code>Authorization</code> header as a bearer token. Use a test key while you build.</span>
        <span className={s.cites}><span>[1] Authentication</span><span>[2] Quickstart</span></span>
      </div>
    </div>
  );
}

export default function DocsStudio() {
  return (
    <section id="docs-studio" aria-labelledby="docs-studio-title" className={s.section}>
      <div className={s.bg} aria-hidden="true" />
      <div className={`${s.inner} mx-auto max-w-marketing px-4 sm:px-6`}>
        <div className={s.top}>
          <header className={s.head}>
            <p className={s.eye}><StudioGlyph size={14} />Docs Studio<span className={s.new}>New</span></p>
            <h2 id="docs-studio-title" className={s.h2}>Build a docs site your readers can ask.</h2>
            <p className={s.lead}>
              Docs Studio builds and hosts docs sites. Write pages visually or in Markdown, publish them after review, and give
              readers answers that cite your pages.
            </p>
          </header>
          <div className={s.ctas}>
            <Link href="/docs-studio" className={`md-btn md-btn--lg ${s.primary}`} data-cta="docs_studio_start">
              Start a docs site
              <Icon name="arrowRight" size={16} />
            </Link>
            <a href={SEE_IT_LIVE} className="md-btn md-btn--secondary md-btn--lg" data-cta="docs_studio_live">
              See it live
            </a>
          </div>
        </div>

        <div className={s.stage}>
          <fieldset className={s.themes}>
            <legend className={s.legend}>Try a theme</legend>
            {THEMES.map((t) => (
              <label key={t.id} className={s.theme} data-t={t.id}>
                <input type="radio" name="docs-studio-theme" value={t.id} defaultChecked={t.id === "brand"} className={s.radio} />
                <span className={s.sw} aria-hidden="true" />
                {t.label}
              </label>
            ))}
          </fieldset>
          <div className={s.pic}>
            <Editor />
            <Site />
            <div className={s.tryIt} aria-hidden="true">
              <span className={s.tryH}><i className={s.post}>POST</i>/v1/payments<span className={s.tryBtn}><Icon name="play" size={11} />Try it</span></span>
              <span className={s.tryR}><span className={s.ok}>200 OK</span><span className={s.mu}>142 ms</span></span>
            </div>
            <div className={s.pub} aria-hidden="true">
              <Icon name="checkCircle" size={14} />
              <span>Published after review</span>
              <span className={s.ver}>v12</span>
              <span className={s.restore}><Icon name="rotate" size={12} />Restore</span>
            </div>
          </div>
          <p className={s.picCap}>A drawing of how it works: the studio editor, and the docs site it publishes.</p>
        </div>

        <ul className={s.feats}>
          {FEATURES.map((f) => (
            <li key={f.title} className={s.feat}>
              <span className={s.fi}><Icon name={f.icon} size={16} /></span>
              <span className={s.ft}>{f.title}</span>
              <span className={s.fl}>{f.line}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
