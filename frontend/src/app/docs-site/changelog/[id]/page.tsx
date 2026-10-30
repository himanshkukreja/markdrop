import type { Metadata } from "next";
import "@/docs/changelog.css";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Icon } from "@/components/ui";
import { getChangelog, getSite } from "@/docs/content";
import { EntryMedia, hasMedia, toHubEntry } from "@/docs/changelog";
import { DocsUpdated, KindPill, Spotlight } from "@/docs/client/Changelog";
import { DocsMarkdown } from "@/docs/render/DocsMarkdown";
import { formatDate } from "@/docs/outputs";
import { DocsFooter, DocsHeader } from "@/docs/ui/Chrome";
import type { ChangelogEntry } from "@/docs/types";

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

function Neighbour({ e, dir }: { e: ChangelogEntry; dir: "Newer" | "Older" }) {
  return (
    <Link href={`/changelog/${e.id}`} className={`dxc-pn__link dxc-pn__link--${dir.toLowerCase()}`}>
      <span className="dxc-pn__dir">
        {dir === "Newer" && <Icon name="arrowLeft" />}
        {dir} release
        {dir === "Older" && <Icon name="arrowRight" />}
      </span>
      <strong className="dxc-pn__title">{e.title}</strong>
      <span className="dxc-pn__meta">
        <KindPill kind={e.kind} />
        <time dateTime={e.date}>{formatDate(e.date)}</time>
      </span>
    </Link>
  );
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
      <main id="main" className="dxc-page dxc-page--entry">
        <div className="dxc-entry">
          <Link href="/changelog" className="dxc-back">
            <Icon name="arrowLeft" />
            All releases
          </Link>
          <Spotlight e={e} media={hasMedia(entry) ? <EntryMedia e={entry} /> : undefined} siteUrl={site.url} permalink />
          {entry.body && (
            <section className="dxc-entry__body" aria-label="Details">
              <DocsMarkdown source={entry.body} className="dxc-prose dxc-prose--page" />
            </section>
          )}
          <DocsUpdated docs={e.docs} />
          <nav aria-label="More releases" className="dxc-pn">
            {newer ? <Neighbour e={newer} dir="Newer" /> : <span className="dxc-pn__spacer" />}
            {older ? <Neighbour e={older} dir="Older" /> : <span className="dxc-pn__spacer" />}
          </nav>
        </div>
      </main>
      <DocsFooter />
    </>
  );
}
