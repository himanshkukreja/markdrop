import type { Metadata } from "next";
import { Icon } from "@/components/ui";
import { getChangelog, getSite } from "@/docs/content";
import { EntryMedia, toHubEntry, versionProduct } from "@/docs/changelog";
import { ChangelogHub } from "@/docs/client/Changelog";
import { DocsFooter, DocsHeader } from "@/docs/ui/Chrome";
import { InlineCode } from "@/docs/ui/InlineCode";

export const dynamic = "force-static";

export function generateMetadata(): Metadata {
  const site = getSite();
  const title = site.changelog?.title ?? "Changelog";
  const description = site.changelog?.description ?? site.description;
  return {
    title,
    description,
    alternates: {
      canonical: `${site.url}/changelog`,
      types: { "application/rss+xml": `${site.url}/changelog.rss`, "application/feed+json": `${site.url}/changelog.json`, "text/markdown": `${site.url}/changelog.md` },
    },
    openGraph: { title, description, url: `${site.url}/changelog`, images: [{ url: `${site.url}/og/changelog`, width: 1200, height: 630 }] },
  };
}

export default function ChangelogPage() {
  const site = getSite();
  const cl = getChangelog();
  const tab = site.tabs.find((t) => t.href === "/changelog");
  return (
    <>
      <DocsHeader activeTab={tab?.id} />
      <main id="main" className="dx-changelog">
        <div className="dx-changelog__head">
          <div className="dx-changelog__intro">
            <h1 className="dx-title">{site.changelog?.title ?? "Changelog"}</h1>
            {site.changelog?.description && <p className="dx-lede">{site.changelog.description}</p>}
          </div>
          <div className="dx-feeds" aria-label="Follow the changelog">
            <a href="/changelog.rss" className="md-btn md-btn--secondary md-btn--sm">
              <Icon name="wave" />
              RSS
            </a>
            <a href="/changelog.json" className="dx-feeds__link">
              JSON Feed
            </a>
            <a href="/changelog.md" className="dx-feeds__link">
              Markdown
            </a>
          </div>
        </div>

        {cl.next.length > 0 && (
          <section aria-labelledby="dx-next-h" className="dx-panel dx-next">
            <h2 id="dx-next-h" className="dx-panel__title">
              Coming next
            </h2>
            <ul className="dx-next__list">
              {cl.next.map((n) => (
                <li key={n.title}>
                  <strong>{n.title}</strong>
                  {n.area && <span className="dx-next__area">{n.area}</span>}
                  {n.body && <InlineCode className="dx-next__body" text={n.body} />}
                </li>
              ))}
            </ul>
          </section>
        )}

        {cl.entries.length ? (
          <ChangelogHub
            entries={cl.entries.map(toHubEntry)}
            media={Object.fromEntries(cl.entries.filter((e) => e.media).map((e) => [e.id, <EntryMedia key={e.id} e={e} />]))}
            siteUrl={site.url}
            versionProduct={versionProduct()}
          />
        ) : (
          <p className="dx-hub__empty">No changes published yet.</p>
        )}
      </main>
      <DocsFooter />
    </>
  );
}
