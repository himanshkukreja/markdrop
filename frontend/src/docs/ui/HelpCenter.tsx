/**
 * The help-center home (theme preset "helpcenter"): a search hero, the nav groups as category
 * cards, then the "Start here" pages as popular articles. Everything comes from site.json, like
 * the default home (app/docs-site/page.tsx).
 */
import Link from "@/docs/client/Link";
import { Icon } from "@/components/ui";
import { getNav, getPage, getSite } from "../content";
import { heroLede, startCardText } from "../present.mjs";
import { HomeAsk } from "../client/Chrome";
import { DocsFooter, DocsHeader } from "./Chrome";

export function HelpCenterHome() {
  const site = getSite();
  const home = site.home ?? {};
  const nav = getNav();
  const areas = (home.areas?.length ? home.areas.map((a) => nav.find((g) => g.group === a)) : nav).filter((g): g is NonNullable<typeof g> => !!g);
  const popular = (home.start ?? []).map((s) => ({ ...s, page: getPage(s.page) })).filter((s) => s.page);
  const headline = site.headline ?? site.name;
  const lede = heroLede(headline, site.description);

  return (
    <>
      <DocsHeader activeTab={site.tabs[0]?.id} />
      <main id="main" className="dx-home dx-hc">
        <section aria-labelledby="dx-hero-h" className="dx-hero dx-hc__hero">
          {site.eyebrow && <span className="dx-eyebrow">{site.eyebrow}</span>}
          <h1 id="dx-hero-h" className="dx-hero__title">
            {headline}
          </h1>
          {lede && <p className="dx-hero__lede">{lede}</p>}
          <HomeAsk chips={home.chips} placeholder={home.askPlaceholder ?? "Search articles"} />
        </section>

        {areas.length > 0 && (
          <section aria-labelledby="dx-cats-h" className="dx-home__section">
            <h2 id="dx-cats-h" className="dx-home__h">
              Browse by category
            </h2>
            <div className="dx-grid dx-grid--3">
              {areas.map((g) => {
                const items = g.items.filter((it) => it.available);
                if (!items.length) return null;
                return (
                  <div key={g.group} className="dx-hc-cat">
                    <span className="dx-tile" aria-hidden>
                      <Icon name={g.icon ?? "doc"} />
                    </span>
                    <Link href={items[0].path} className="dx-hc-cat__title">
                      {g.group}
                    </Link>
                    <span className="dx-hc-cat__count">{items.length === 1 ? "1 article" : `${items.length} articles`}</span>
                    <ul className="dx-hc-cat__links">
                      {items.slice(0, 4).map((it) => (
                        <li key={it.path}>
                          <Link href={it.path}>{it.title}</Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {popular.length > 0 && (
          <section aria-labelledby="dx-pop-h" className="dx-home__section">
            <h2 id="dx-pop-h" className="dx-home__h">
              Popular articles
            </h2>
            <ul className="dx-hc-pop">
              {popular.map((s) => {
                const text = startCardText(s, s.page!.meta);
                return (
                  <li key={s.page!.path}>
                    <Link href={s.page!.path} className="dx-hc-pop__item">
                      <Icon name={s.icon ?? "doc"} className="dx-hc-pop__icon" />
                      <span className="dx-hc-pop__text">
                        <strong>{text.title}</strong>
                        <span>{text.description}</span>
                      </span>
                      <Icon name="arrowRight" className="dx-hc-pop__go" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
      <DocsFooter />
    </>
  );
}
