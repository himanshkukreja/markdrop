import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "@/docs/docs.css";
import { getSite } from "@/docs/content";
import { SearchPalette } from "@/docs/client/Search";
import { AskRoot } from "@/docs/client/ask/AskRoot";

/**
 * The docs site (docs.<host>, reached only through the middleware rewrite to /docs-site/…). The
 * root layout renders no chrome, so this layout is the docs' own frame: no app header, no shell,
 * no auth redirects. Pages render their own header (it needs the current tab and path, which the
 * page knows statically) and the ⌘K palette is mounted once here.
 */
export function generateMetadata(): Metadata {
  const site = getSite();
  return {
    metadataBase: new URL(site.url),
    title: { default: site.name, template: `%s · ${site.name}` },
    description: site.description,
    applicationName: site.name,
    manifest: null,
    alternates: { types: { "text/plain": `${site.url}/llms.txt`, "application/rss+xml": `${site.url}/changelog.rss` } },
    openGraph: { siteName: site.name, type: "website" },
    twitter: { card: "summary_large_image" },
  };
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const site = getSite();
  return (
    <div className="dx-root">
      {children}
      <SearchPalette suggestions={site.home?.chips} />
      <AskRoot siteUrl={site.url} suggestions={site.home?.chips} />
    </div>
  );
}
