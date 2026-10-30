import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "@/docs/docs.css";
import "@/docs/themes.css";
import { getSite } from "@/docs/content";
import { accentCss, clientSite, faviconMetadata, markdropApp } from "@/docs/brand";
import { SearchPalette } from "@/docs/client/Search";
import { AskRoot } from "@/docs/client/ask/AskRoot";
import { MediaLightbox } from "@/docs/client/Media";
import { DocsSiteProvider } from "@/docs/client/site";
import { forcedModeScript, siteTheme } from "@/docs/themeSite";
import { themeStylesheet } from "@/docs/themeFonts";

/**
 * The docs site (docs.<host>, reached only through the middleware rewrite to /docs-site/…). The
 * root layout renders no chrome, so this layout is the docs' own frame: no app header, no shell,
 * no auth redirects. Pages render their own header (it needs the current tab and path, which the
 * page knows statically) and the ⌘K palette is mounted once here. The site's settings (brand,
 * accent, Ask AI) come from site.json; `data-docs-trackers="off"` tells the root layout's
 * Markdrop trackers to stay out of a site that isn't Markdrop's. A site with a `theme` (theme.mjs)
 * also gets `data-preset` and `data-layout` on the root, the theme's stylesheet and, when it forces
 * a colour mode, the script that pins it; a site without one gets none of these.
 */
export function generateMetadata(): Metadata {
  const site = getSite();
  const icons = faviconMetadata(site);
  return {
    metadataBase: new URL(site.url),
    title: { default: site.name, template: `%s · ${site.name}` },
    description: site.description,
    applicationName: site.name,
    manifest: null,
    alternates: { types: { "text/plain": `${site.url}/llms.txt`, "application/rss+xml": `${site.url}/changelog.rss` } },
    openGraph: { siteName: site.name, type: "website" },
    twitter: { card: "summary_large_image" },
    ...(icons !== undefined ? { icons } : {}),
  };
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const site = getSite();
  const client = clientSite(site);
  const theme = siteTheme(site);
  // A theme palette already carries the brand accent (brand.accent / accentDark win inside it).
  const css = theme?.palette ? null : accentCss(site);
  const themeCss = themeStylesheet(site);
  const forced = forcedModeScript(site);
  return (
    <div className="dx-root" data-docs-trackers={markdropApp(site) ? undefined : "off"} {...(theme ? { "data-preset": theme.preset, "data-layout": theme.layout } : {})}>
      {forced && <script dangerouslySetInnerHTML={{ __html: forced }} />}
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      {themeCss && <style dangerouslySetInnerHTML={{ __html: themeCss }} />}
      <DocsSiteProvider value={client}>
        {children}
        <SearchPalette suggestions={site.home?.chips} />
        {client.ai && <AskRoot siteUrl={site.url} suggestions={site.home?.chips} />}
        <MediaLightbox />
      </DocsSiteProvider>
    </div>
  );
}
