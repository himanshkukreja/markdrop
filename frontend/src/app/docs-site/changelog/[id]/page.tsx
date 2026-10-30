import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumb } from "@/components/ui";
import { getChangelog, getSite } from "@/docs/content";
import { EntryMedia, toHubEntry } from "@/docs/changelog";
import { EntryFooter, EntryMeta } from "@/docs/client/Changelog";
import { DocsMarkdown } from "@/docs/render/DocsMarkdown";
import { DocsFooter, DocsHeader } from "@/docs/ui/Chrome";
import { InlineCode } from "@/docs/ui/InlineCode";

export const dynamicParams = false;

interface Props {
  params: Promise<{ id: string }>;
}

export function generateStaticParams() {
  return getChangelog().entries.map((e) => ({ id: e.id }));
}

async function load(params: Props["params"]) {
  const { id } = await params;
  const entries = getChangelog().entries;
  const i = entries.findIndex((e) => e.id === id);
  return i < 0 ? null : { entry: entries[i], newer: entries[i - 1], older: entries[i + 1] };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await load(params);
  if (!r) return {};
  const site = getSite();
  const url = `${site.url}/changelog/${r.entry.id}`;
  const og = `${site.url}/og/changelog/${r.entry.id}`;
  return {
    title: r.entry.title,
    description: r.entry.summary,
    alternates: { canonical: url },
    openGraph: { title: r.entry.title, description: r.entry.summary, url, type: "article", publishedTime: r.entry.date, images: [{ url: og, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title: r.entry.title, description: r.entry.summary, images: [og] },
  };
}

export default async function ChangelogEntryPage({ params }: Props) {
  const r = await load(params);
  if (!r) notFound();
  const site = getSite();
  const { entry, newer, older } = r;
  const e = toHubEntry(entry);
  const tab = site.tabs.find((t) => t.href === "/changelog");
  return (
    <>
      <DocsHeader activeTab={tab?.id} />
      <main id="main" className="dx-changelog dx-changelog--entry">
        <Breadcrumb items={[{ label: site.changelog?.title ?? "Changelog", href: "/changelog" }, { label: entry.title }]} className="dx-crumbs" />
        <article className="dx-entrypage">
          <time dateTime={entry.date} className="dx-entrypage__date">
            {e.dateLabel}
          </time>
          <h1 className="dx-title">{entry.title}</h1>
          <EntryMeta e={e} />
          <p className="dx-lede"><InlineCode text={entry.summary} /></p>
          <EntryMedia e={entry} />
          {entry.body && <DocsMarkdown source={entry.body} />}
          <EntryFooter e={e} siteUrl={site.url} />
        </article>
        <nav aria-label="More changes" className="dx-prevnext">
          {newer ? (
            <Link href={`/changelog/${newer.id}`} className="dx-prevnext__link">
              <span className="dx-prevnext__dir">Newer</span>
              <strong>{newer.title}</strong>
            </Link>
          ) : (
            <Link href="/changelog" className="dx-prevnext__link">
              <span className="dx-prevnext__dir">All changes</span>
              <strong>{site.changelog?.title ?? "Changelog"}</strong>
            </Link>
          )}
          {older && (
            <Link href={`/changelog/${older.id}`} className="dx-prevnext__link dx-prevnext__link--next">
              <span className="dx-prevnext__dir">Older</span>
              <strong>{older.title}</strong>
            </Link>
          )}
        </nav>
      </main>
      <DocsFooter />
    </>
  );
}
