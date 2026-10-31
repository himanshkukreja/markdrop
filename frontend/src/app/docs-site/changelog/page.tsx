import type { Metadata } from "next";
import "@/docs/changelog.css";
import { notFound } from "next/navigation";
import { getChangelog, getSite, hasChangelog } from "@/docs/content";
import { bodyMap, mediaMap, toHubEntry, versionProduct } from "@/docs/changelog";
import { ChangelogHub } from "@/docs/client/Changelog";
import { DocsFooter, DocsHeader } from "@/docs/ui/Chrome";

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
  // A site with no changelog entries has no changelog page (the 404 page answers instead).
  if (!hasChangelog()) notFound();
  const site = getSite();
  const cl = getChangelog();
  const tab = site.tabs.find((t) => t.href === "/changelog");
  return (
    <>
      <DocsHeader activeTab={tab?.id} />
      <main id="main" className="dxc-page">
        <ChangelogHub
          title={site.changelog?.title ?? "Changelog"}
          description={site.changelog?.description}
          entries={cl.entries.map(toHubEntry)}
          media={mediaMap(cl.entries)}
          bodies={bodyMap(cl.entries)}
          siteUrl={site.url}
          versionProduct={versionProduct()}
          next={cl.next}
        />
      </main>
      <DocsFooter />
    </>
  );
}
