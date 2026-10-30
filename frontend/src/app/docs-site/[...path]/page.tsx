import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Breadcrumb, Icon } from "@/components/ui";
import { absoluteUrl, agentMarkdown, getAllPages, getPage, getSite, groupOf, mdUrl, navLabel, prevNext, sectionMarkdown, withPrerequisites } from "@/docs/content";
import { formatDate } from "@/docs/outputs";
import { DocsMarkdown } from "@/docs/render/DocsMarkdown";
import { DocPageProvider, type DocPageInfo } from "@/docs/client/page";
import { CopyPageButton, MobileBottomBar, RailActions } from "@/docs/client/PageActions";
import { AskAboutPageButton } from "@/docs/client/ask/entry";
import { ChangedBadge, DocsToc, OnThisPageBar, type TocEntry } from "@/docs/client/Toc";
import { Feedback } from "@/docs/client/Feedback";
import { DocsFooter, DocsHeader, DocsSidebar } from "@/docs/ui/Chrome";

/** Every page is generated at build time; an address with no page is a 404, never a render. */
export const dynamicParams = false;

interface Props {
  params: Promise<{ path: string[] }>;
}

export function generateStaticParams() {
  return getAllPages().map((p) => ({ path: p.path.slice(1).split("/") }));
}

async function load(params: Props["params"]) {
  const { path } = await params;
  return getPage("/" + path.map(decodeURIComponent).join("/"));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await load(params);
  if (!page) return {};
  const url = absoluteUrl(page.path);
  const og = `${getSite().url}/og${page.path}`;
  return {
    title: page.meta.title,
    description: page.meta.description,
    keywords: page.meta.keywords,
    alternates: { canonical: url, types: { "text/markdown": mdUrl(page.path) } },
    openGraph: { title: page.meta.title, description: page.meta.description, url, type: "article", images: [{ url: og, width: 1200, height: 630 }], modifiedTime: page.meta.updated || undefined },
    twitter: { card: "summary_large_image", title: page.meta.title, description: page.meta.description, images: [og] },
  };
}

export default async function DocsArticle({ params }: Props) {
  const page = await load(params);
  if (!page) notFound();
  const site = getSite();
  const group = groupOf(page.path);
  const tab = site.tabs.find((t) => t.id === group?.tab) ?? site.tabs[0];
  const { prev, next } = prevNext(page.path);
  const toc: TocEntry[] = page.headings.filter((h) => (h.depth === 2 || h.depth === 3) && !h.nested).map(({ id, text, depth }) => ({ id, text, depth }));
  const prereq = withPrerequisites(page);
  const prereqPages = (page.meta.prerequisites ?? []).map((p) => getPage(p)).filter((p): p is NonNullable<typeof p> => !!p);
  const firstOfGroup = group?.items.find((it) => it.available)?.path;

  const info: DocPageInfo = {
    path: page.path,
    title: page.meta.title,
    url: absoluteUrl(page.path),
    mdUrl: mdUrl(page.path),
    markdown: agentMarkdown(page),
    prereq: prereq.count ? prereq : undefined,
    sections: Object.fromEntries(page.sections.map((s) => [s.id, sectionMarkdown(page, s.raw)])),
    // Only sections with a contents entry get a dot, so only they count as "changed".
    hashes: Object.fromEntries(page.sections.filter((s) => toc.some((t) => t.id === s.id)).map((s) => [s.id, s.hash])),
    editUrl: site.edit ? `${site.edit}/${page.file}` : undefined,
    feedbackUrl: site.feedback,
  };

  const crumbs = [
    ...(tab ? [{ label: tab.label, href: tab.href }] : []),
    ...(group ? [{ label: group.group, href: firstOfGroup && firstOfGroup !== page.path ? firstOfGroup : undefined }] : []),
    { label: navLabel(page) },
  ];

  return (
    <DocPageProvider value={info}>
      <DocsHeader activeTab={tab?.id} current={page.path} />
      <OnThisPageBar entries={toc} />
      <div className="dx-layout">
        <aside className="dx-layout__nav">
          <DocsSidebar tab={tab?.id} current={page.path} />
        </aside>

        <main id="main" className="dx-article">
          <Breadcrumb items={crumbs} className="dx-crumbs" />
          <div className="dx-titlerow">
            <h1 className="dx-title">{page.meta.title}</h1>
            <span className="dx-only-wide">
              <CopyPageButton />
            </span>
          </div>
          <div className="dx-meta">
            <span className="dx-meta__item">
              <Icon name="clock" />
              {page.minutes} min read
            </span>
            {page.meta.updated && <span className="dx-meta__item">Updated {formatDate(page.meta.updated)}</span>}
            {page.meta.checked && (
              <Badge tone="success" size="sm" icon="checkCircle">
                Checked against the live app, {formatDate(page.meta.checked)}
              </Badge>
            )}
            {page.meta.since && (
              <Badge tone="neutral" size="sm" icon="code">
                Since {page.meta.since}
              </Badge>
            )}
            <ChangedBadge />
          </div>
          {prereqPages.length > 0 && (
            <p className="dx-prereq">
              <Icon name="bulb" />
              <span>
                Builds on{" "}
                {prereqPages.map((p, i) => (
                  <span key={p.path}>
                    {i > 0 && (i === prereqPages.length - 1 ? " and " : ", ")}
                    <Link href={p.path}>{navLabel(p)}</Link>
                  </span>
                ))}
                .
              </span>
            </p>
          )}

          <DocsMarkdown source={page.body} />

          <Feedback />

          {(prev || next) && (
            <nav aria-label="More pages" className="dx-prevnext">
              {prev ? (
                <Link href={prev.path} className="dx-prevnext__link">
                  <span className="dx-prevnext__dir">Previous</span>
                  <strong>{navLabel(prev)}</strong>
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link href={next.path} className="dx-prevnext__link dx-prevnext__link--next">
                  <span className="dx-prevnext__dir">Next</span>
                  <strong>{navLabel(next)}</strong>
                </Link>
              )}
            </nav>
          )}
        </main>

        <aside className="dx-layout__rail" aria-label="On this page">
          <div className="dx-rail">
            <DocsToc entries={toc} />
            <RailActions />
            <div className="dx-askcard">
              <strong>Have a question about this page?</strong>
              <span>Ask AI answers from these docs, with links to the sections it used.</span>
              <AskAboutPageButton />
            </div>
          </div>
        </aside>
      </div>
      <DocsFooter />
      <MobileBottomBar />
    </DocPageProvider>
  );
}
