"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Breadcrumb, Button, Icon, IconButton, Kbd } from "@/components/ui";
import { resolveTheme, themeAttrs, themeCss } from "@/docs/theme.mjs";
import { isPreviewState, type PreviewState } from "./protocol";

/**
 * Inside the builder's iframe (/guides/theme-preview): a guide's home and an article drawn with
 * the docs engine's classes (docs.css, themes.css) and themed exactly as the engine themes a
 * published guide: the stylesheet from theme.mjs themeCss, the root's attributes from themeAttrs,
 * the page structure from the resolved layout (sidebar, top or help center) and home. The article
 * body is the engine's own renderer (DocsMarkdown, server-rendered by the page).
 */

const NAV: Array<{ group: string; icon: string; items: Array<{ title: string; icon: string; current?: boolean }> }> = [
  { group: "Getting started", icon: "zap", items: [{ title: "Welcome", icon: "home" }, { title: "Quickstart", icon: "zap", current: true }, { title: "Key concepts", icon: "bulb" }] },
  { group: "Guides", icon: "doc", items: [{ title: "Connect Postgres", icon: "link" }, { title: "Build a dashboard", icon: "table" }, { title: "Alert rules", icon: "alert" }] },
  { group: "Reference", icon: "code", items: [{ title: "CLI", icon: "code" }, { title: "Settings", icon: "settings" }] },
];
const TOC = [
  { id: "install-the-cli", text: "Install the CLI" },
  { id: "plans-and-limits", text: "Plans and limits" },
  { id: "next-steps", text: "Next steps" },
];

const noop = (e: React.SyntheticEvent) => e.preventDefault();

export default function PreviewFrame({ families, article }: { families: Record<string, string>; article: ReactNode }) {
  const [state, setState] = useState<PreviewState | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || !isPreviewState(e.data)) return;
      setState(e.data);
    };
    window.addEventListener("message", onMessage);
    if (window.parent !== window) window.parent.postMessage({ type: "guide-theme-preview:ready" }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The frame's own colour mode (the reader's stored choice doesn't apply here).
  useEffect(() => {
    if (!state) return;
    const d = document.documentElement;
    d.setAttribute("data-theme", state.dark ? "dark" : "light");
    d.classList.toggle("dark", state.dark);
    d.style.colorScheme = state.dark ? "dark" : "light";
  }, [state]);

  const resolved = useMemo(() => (state ? resolveTheme(state.theme, state.brand) : null), [state]);
  const css = useMemo(() => (resolved ? themeCss(resolved, families) : ""), [resolved, families]);
  if (!state || !resolved) return <div className="dx-root" data-docs-trackers="off" aria-busy="true" />;

  const name = state.name || "Acme";
  const short = name.replace(/\s+docs$/i, "") || name;
  const layout = resolved.layout;
  const tabs = resolved.sectionTabs ? NAV.map((g, i) => ({ label: g.group, current: i === 0 })) : [{ label: "Guides", current: true }, { label: "API reference", current: false }];

  return (
    <div className="dx-root" data-docs-trackers="off" {...themeAttrs(resolved)} onClickCapture={(e) => (e.target as HTMLElement).closest("a, button") && noop(e)} onSubmitCapture={noop}>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <header className="dx-header">
        <div className="dx-header__in">
          <IconButton icon="lines" label="Menu" className="dx-menubtn" />
          <a href="#" className="dx-brand" aria-label={`${name} home`}>
            {state.logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- the guide's logo, any size
              <img src={state.logo} alt="" className="dx-brand__logo" />
            ) : (
              <span className="dx-brand__word dx-brand__name">{short}</span>
            )}
            <span className="dx-brand__docs">Docs</span>
          </a>
          <nav aria-label="Docs sections" className="dx-tabsnav">
            {tabs.map((t) => (
              <a key={t.label} href="#" className="dx-tabsnav__item" aria-current={t.current ? "page" : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
          <div className="dx-header__tools">
            <span className="dx-only-wide">
              <button type="button" className="dx-searchbox" aria-label="Search the docs">
                <Icon name="search" />
                <span className="dx-searchbox__ph">Search…</span>
                <Kbd>⌘K</Kbd>
              </button>
            </span>
            <span className="dx-only-narrow">
              <IconButton icon="search" label="Search the docs" className="dx-searchicon" />
            </span>
            {resolved.mode === "both" && <IconButton icon={state.dark ? "sun" : "moon"} label="Theme" />}
            <span className="dx-only-xwide">
              <Button variant="primary" size="sm" iconRight="external">{`Open ${short}`}</Button>
            </span>
          </div>
        </div>
      </header>
      {state.page === "home" ? <Home name={short} categories={resolved.home === "categories"} /> : <Article layout={layout} article={article} />}
      <footer className="dx-footer">
        <span>© {short}</span>
        <a href="#">Status</a>
        <a href="#">llms.txt</a>
      </footer>
    </div>
  );
}

function SideNav() {
  return (
    <nav aria-label="Pages" className="dx-nav dx-sidenav">
      {NAV.map((g) => (
        <div key={g.group} className="dx-nav__group">
          <p className="dx-eyebrow dx-nav__title">{g.group}</p>
          <ul>
            {g.items.map((it) => (
              <li key={it.title}>
                <a href="#" className="dx-nav__item" aria-current={it.current ? "page" : undefined}>
                  <Icon name={it.icon} className="dx-nav__icon" />
                  <span className="dx-nav__label">{it.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Rail({ section }: { section?: boolean }) {
  return (
    <div className="dx-rail">
      {section && (
        <nav aria-label="In this category" className="dx-section">
          <p className="dx-eyebrow dx-section__title">In this category</p>
          <ul className="dx-section__list">
            {NAV[0].items.map((it) => (
              <li key={it.title}>
                <a href="#" className="dx-section__item" aria-current={it.current ? "page" : undefined}>{it.title}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <nav aria-labelledby="dx-toc-title" className="dx-toc">
        <p id="dx-toc-title" className="dx-eyebrow">On this page</p>
        <ol className="dx-toc__list">
          {TOC.map((h, i) => (
            <li key={h.id}>
              <a href={`#${h.id}`} className="dx-toc__item" data-level={0} aria-current={i === 0 ? "location" : undefined}>
                <span className="dx-toc__text">{h.text}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}

function ArticleMain({ article, section }: { article: ReactNode; section?: boolean }) {
  return (
    <main id="main" className="dx-article">
      <Breadcrumb items={[{ label: "Getting started" }, { label: "Quickstart" }]} className="dx-crumbs" />
      <div className="dx-titlerow">
        <h1 className="dx-title">Quickstart</h1>
      </div>
      <p className="dx-lede">Set up your first project and invite your team.</p>
      <div className="dx-meta">
        <span className="dx-meta__item">
          <Icon name="clock" />4 min read
        </span>
        <span className="dx-meta__item">Updated Oct 28, 2026</span>
      </div>
      {article}
      {section && (
        <nav aria-label="In Getting started" className="dx-section">
          <p className="dx-eyebrow dx-section__title">In Getting started</p>
          <ul className="dx-section__list">
            {NAV[0].items.map((it) => (
              <li key={it.title}>
                <a href="#" className="dx-section__item" aria-current={it.current ? "page" : undefined}>{it.title}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <nav className="dx-prevnext" aria-label="Previous and next">
        <a href="#" className="dx-prevnext__link">
          <span className="dx-eyebrow">Previous</span>
          <strong>Welcome</strong>
        </a>
        <a href="#" className="dx-prevnext__link dx-prevnext__link--next">
          <span className="dx-eyebrow">Next</span>
          <strong>Key concepts</strong>
        </a>
      </nav>
    </main>
  );
}

function Article({ layout, article }: { layout: string; article: ReactNode }) {
  if (layout === "top") {
    return (
      <>
        <nav aria-label="Sections" className="dx-topnav">
          <ul className="dx-topnav__in">
            {NAV.map((g, i) => (
              <li key={g.group}>
                <a href="#" className="dx-topnav__item" aria-current={i === 0 ? "true" : undefined}>{g.group}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="dx-layout dx-layout--top">
          <ArticleMain article={article} section />
          <aside className="dx-layout__rail" aria-label="On this page">
            <Rail />
          </aside>
        </div>
      </>
    );
  }
  if (layout === "helpcenter") {
    return (
      <div className="dx-layout dx-layout--hc">
        <ArticleMain article={article} />
        <aside className="dx-layout__rail" aria-label="In this category">
          <Rail section />
        </aside>
      </div>
    );
  }
  return (
    <div className="dx-layout">
      <aside className="dx-layout__nav">
        <SideNav />
      </aside>
      <ArticleMain article={article} />
      <aside className="dx-layout__rail" aria-label="On this page">
        <Rail />
      </aside>
    </div>
  );
}

function Ask({ placeholder }: { placeholder: string }) {
  return (
    <form className="dx-ask">
      <div className="dx-ask__box">
        <Icon name="search" className="dx-ask__glyph" />
        <input type="text" className="dx-ask__input" placeholder={placeholder} aria-label={placeholder} readOnly />
        <Button type="submit" iconRight="arrowRight">Search</Button>
      </div>
      <div className="dx-ask__chips">
        {["How do I invite my team?", "Connect a database", "Reset my password"].map((c) => (
          <button key={c} type="button" className="dx-chip">{c}</button>
        ))}
      </div>
    </form>
  );
}

const START = [
  { title: "Quickstart", body: "Your first project and dashboard in ten minutes.", icon: "zap", time: "10 min" },
  { title: "Connect Postgres", body: "A read-only user, then one form.", icon: "link", time: "5 min" },
  { title: "Invite your team", body: "Roles, seats and single sign-on.", icon: "user", time: "3 min" },
];

function Home({ name, categories }: { name: string; categories: boolean }) {
  if (categories) {
    return (
      <main id="main" className="dx-home dx-hc">
        <section aria-labelledby="dx-hero-h" className="dx-hero dx-hc__hero">
          <h1 id="dx-hero-h" className="dx-hero__title">How can we help?</h1>
          <p className="dx-hero__lede">Answers and guides for {name}.</p>
          <Ask placeholder="Search articles" />
        </section>
        <section aria-labelledby="dx-cats-h" className="dx-home__section">
          <h2 id="dx-cats-h" className="dx-home__h">Browse by category</h2>
          <div className="dx-grid dx-grid--3">
            {NAV.map((g) => (
              <div key={g.group} className="dx-hc-cat">
                <span className="dx-tile" aria-hidden>
                  <Icon name={g.icon} />
                </span>
                <a href="#" className="dx-hc-cat__title">{g.group}</a>
                <span className="dx-hc-cat__count">{g.items.length} articles</span>
                <ul className="dx-hc-cat__links">
                  {g.items.map((it) => (
                    <li key={it.title}>
                      <a href="#">{it.title}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
        <section aria-labelledby="dx-pop-h" className="dx-home__section">
          <h2 id="dx-pop-h" className="dx-home__h">Popular articles</h2>
          <ul className="dx-hc-pop">
            {START.map((s) => (
              <li key={s.title}>
                <a href="#" className="dx-hc-pop__item">
                  <Icon name={s.icon} className="dx-hc-pop__icon" />
                  <span className="dx-hc-pop__text">
                    <strong>{s.title}</strong>
                    <span>{s.body}</span>
                  </span>
                  <Icon name="arrowRight" className="dx-hc-pop__go" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
    );
  }
  return (
    <main id="main" className="dx-home">
      <section aria-labelledby="dx-hero-h" className="dx-hero">
        <span className="dx-eyebrow">Documentation</span>
        <h1 id="dx-hero-h" className="dx-hero__title">{name} docs</h1>
        <p className="dx-hero__lede">Everything you need to set up {name}, use it every day and fix things when they go wrong.</p>
        <Ask placeholder="Search the docs" />
      </section>
      <section aria-labelledby="dx-start-h" className="dx-home__section">
        <h2 id="dx-start-h" className="dx-home__h">Start here</h2>
        <div className="dx-grid dx-grid--3">
          {START.map((s) => (
            <a key={s.title} href="#" className="dx-startcard">
              <span className="dx-startcard__top">
                <span className="dx-tile" aria-hidden>
                  <Icon name={s.icon} />
                </span>
                <span className="dx-startcard__time">{s.time}</span>
              </span>
              <strong className="dx-startcard__title">{s.title}</strong>
              <span className="dx-startcard__body">{s.body}</span>
            </a>
          ))}
        </div>
      </section>
      <section aria-labelledby="dx-areas-h" className="dx-home__section">
        <h2 id="dx-areas-h" className="dx-home__h">Browse by area</h2>
        <div className="dx-grid dx-grid--4">
          {NAV.map((g) => (
            <div key={g.group} className="dx-area">
              <div className="dx-area__head">
                <Icon name={g.icon} className="dx-area__icon" />
                <a href="#" className="dx-area__title">{g.group}</a>
              </div>
              <ul className="dx-area__links">
                {g.items.slice(0, 3).map((it) => (
                  <li key={it.title}>
                    <a href="#">{it.title}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
