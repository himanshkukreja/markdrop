import type { Metadata } from "next";
import Link from "@/docs/client/Link";
import { Button, Icon } from "@/components/ui";
import { getChangelog, getNav, getPage, getSite } from "@/docs/content";
import { formatDate } from "@/docs/outputs";
import { isAppPath } from "@/docs/markdown";
import { heroLede, startCardText } from "@/docs/present.mjs";
import { HomeAsk, InstallBox } from "@/docs/client/Chrome";
import { DocsFooter, DocsHeader, InlineCode } from "@/docs/ui/Chrome";
import { HelpCenterHome } from "@/docs/ui/HelpCenter";
import { themeLayout } from "@/docs/themeSite";

export const dynamic = "force-static";

export function generateMetadata(): Metadata {
  const site = getSite();
  return {
    title: { absolute: site.name },
    description: site.description,
    alternates: { canonical: `${site.url}/`, types: { "text/markdown": `${site.url}/index.md` } },
    openGraph: { title: site.name, description: site.description, url: `${site.url}/`, images: [{ url: `${site.url}/og/index`, width: 1200, height: 630 }] },
  };
}

export default function DocsHome() {
  const site = getSite();
  if (themeLayout(site) === "helpcenter") return <HelpCenterHome />;
  const home = site.home ?? {};
  const nav = getNav();
  const start = (home.start ?? []).map((s) => ({ ...s, page: getPage(s.page) })).filter((s) => s.page);
  const areas = (home.areas?.length ? home.areas.map((a) => nav.find((g) => g.group === a)) : nav).filter((g): g is NonNullable<typeof g> => !!g);
  const news = getChangelog().entries.slice(0, 3);
  const headline = site.headline ?? site.name;
  // A description that only repeats the headline isn't shown twice.
  const lede = heroLede(headline, site.description);

  return (
    <>
      <DocsHeader activeTab={site.tabs[0]?.id} />
      <main id="main" className="dx-home">
        <section aria-labelledby="dx-hero-h" className="dx-hero">
          {site.eyebrow && <span className="dx-eyebrow">{site.eyebrow}</span>}
          <h1 id="dx-hero-h" className="dx-hero__title">
            {headline}
          </h1>
          {lede && <p className="dx-hero__lede">{lede}</p>}
          <HomeAsk chips={home.chips} placeholder={home.askPlaceholder} />
        </section>

        {start.length > 0 && (
          <section aria-labelledby="dx-start-h" className="dx-home__section">
            <h2 id="dx-start-h" className="dx-home__h">
              Start here
            </h2>
            <div className="dx-grid dx-grid--3">
              {start.map((s) => {
                const text = startCardText(s, s.page!.meta);
                return (
                  <Link key={s.page!.path} href={s.page!.path} className="dx-startcard">
                    <span className="dx-startcard__top">
                      <span className="dx-tile" aria-hidden>
                        <Icon name={s.icon ?? "doc"} />
                      </span>
                      {s.time && <span className="dx-startcard__time">{s.time}</span>}
                    </span>
                    <strong className="dx-startcard__title">{text.title}</strong>
                    <span className="dx-startcard__body">{text.description}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {areas.length > 0 && (
          <section aria-labelledby="dx-areas-h" className="dx-home__section">
            <h2 id="dx-areas-h" className="dx-home__h">
              Browse by area
            </h2>
            <div className="dx-grid dx-grid--4">
              {areas.map((g) => {
                const items = g.items.filter((it) => it.available);
                return (
                  <div key={g.group} className="dx-area">
                    <div className="dx-area__head">
                      <Icon name={g.icon ?? "doc"} className="dx-area__icon" />
                      {items[0] ? (
                        <Link href={items[0].path} className="dx-area__title">
                          {g.group}
                        </Link>
                      ) : (
                        <span className="dx-area__title">{g.group}</span>
                      )}
                    </div>
                    <ul className="dx-area__links">
                      {items.slice(0, 3).map((it) => (
                        <li key={it.path}>
                          <Link href={it.path}>{it.title}</Link>
                        </li>
                      ))}
                      {items.length > 3 && (
                        <li className="dx-area__more">
                          <Link href={items[3].path}>{items.length - 3} more</Link>
                        </li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {(home.install || news.length > 0) && (
          <div className="dx-home__row">
            {home.install && (
              <InstallBox
                title={home.install.title}
                commands={home.install.commands}
                sync={home.install.sync}
                href={home.install.href}
                note={home.install.note ? <InlineCode text={home.install.note} /> : undefined}
              />
            )}
            {news.length > 0 && (
              <section aria-labelledby="dx-new-h" className="dx-panel dx-news">
                <div className="dx-panel__head">
                  <h2 id="dx-new-h" className="dx-panel__title">
                    What&apos;s new
                  </h2>
                  <Link href="/changelog" className="dx-panel__link">
                    Changelog
                  </Link>
                </div>
                {news.map((n) => (
                  <Link key={n.id} href={`/changelog/${n.id}`} className="dx-news__item">
                    <span className="dx-news__date">{formatDate(n.date, { month: "short", day: "numeric" })}</span>
                    <span className="dx-news__text">
                      <strong>{n.title}</strong>
                      <span>{n.summary}</span>
                    </span>
                  </Link>
                ))}
              </section>
            )}
          </div>
        )}

        {home.ai && (
          <section aria-labelledby="dx-ai-h" className="dx-aistrip">
            <div className="dx-aistrip__text">
              <h2 id="dx-ai-h" className="dx-panel__title">
                {home.ai.title}
              </h2>
              <p>
                <InlineCode text={home.ai.body} />
              </p>
            </div>
            <div className="dx-aistrip__actions">
              {(home.ai.links ?? []).map((l, i) =>
                isAppPath(l.href) ? (
                  <Button key={l.href} href={l.href} variant={i === (home.ai!.links!.length - 1) ? "ghost" : "secondary"} size="sm" iconRight={i === home.ai!.links!.length - 1 ? "arrowRight" : undefined}>
                    {l.label}
                  </Button>
                ) : (
                  <a key={l.href} href={l.href} className="md-btn md-btn--secondary md-btn--sm">
                    {l.label}
                  </a>
                ),
              )}
            </div>
          </section>
        )}
      </main>
      <DocsFooter />
    </>
  );
}
