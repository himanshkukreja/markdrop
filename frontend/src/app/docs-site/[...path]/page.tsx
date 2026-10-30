import type { Metadata } from "next";
import Link from "@/docs/client/Link";
import { notFound } from "next/navigation";
import { Badge, Breadcrumb, Icon } from "@/components/ui";
import { absoluteUrl, agentMarkdown, getAllPages, getPage, getSite, groupOf, mdUrl, navLabel, prevNext, sectionMarkdown, withPrerequisites } from "@/docs/content";
import { formatDate } from "@/docs/outputs";
import { introOf, plainText } from "@/docs/markdown";
import { pageLede } from "@/docs/present.mjs";
import { aiSettings } from "@/docs/brand";
import { DocsMarkdown } from "@/docs/render/DocsMarkdown";
import { DocPageProvider, type DocPageInfo } from "@/docs/client/page";
import { CopyPageButton, MobileBottomBar, RailActions } from "@/docs/client/PageActions";
import { AskAboutPageButton } from "@/docs/client/ask/entry";
import { ChangedBadge, DocsToc, OnThisPageBar, type TocEntry } from "@/docs/client/Toc";
import { Feedback } from "@/docs/client/Feedback";
import { DocsFooter, DocsHeader, DocsSidebar, DocsTopNav, SectionPages } from "@/docs/ui/Chrome";
import { themeLayout } from "@/docs/themeSite";
import { ApiAside, ApiHead, ApiMain } from "@/docs/ui/ApiArticle";

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

/**
 * The title row, with the page's icon (site.json `pages.icons`) and the lede under it (`pages.showDescription`).
 * Without either it is exactly the plain title row, element for element.
 */
function ArticleTitle({ title, icon, lede }: { title: string; icon?: string; lede?: string }) {
  const row = (
    <div className="dx-titlerow">
      <h1 className="dx-title">
        {icon ? (
          <>
            <Icon name={icon} className="dx-title__icon" />
            {title}
          </>
        ) : (
          title
        )}
      </h1>
      <span className="dx-only-wide">
        <CopyPageButton />
      </span>
    </div>
  );
  if (!lede) return row;
  return (
    <>
      {row}
      <p className="dx-lede">{lede}</p>
    </>
  );
}

export default async function DocsArticle({ params }: Props) {
  const page = await load(params);
  if (!page) notFound();
  const site = getSite();
  const ai = aiSettings(site);
  const group = groupOf(page.path);
  const tab = site.tabs.find((t) => t.id === group?.tab) ?? site.tabs[0];
  const { prev, next } = prevNext(page.path);
  const toc: TocEntry[] = page.headings.filter((h) => (h.depth === 2 || h.depth === 3) && !h.nested).map(({ id, text, depth }) => ({ id, text, depth }));
  const prereq = withPrerequisites(page);
  const prereqPages = (page.meta.prerequisites ?? []).map((p) => getPage(p)).filter((p): p is NonNullable<typeof p> => !!p);
  const firstOfGroup = group?.items.find((it) => it.available)?.path;
  // site.json `pages`: the description under the title, the page's icon beside it.
  const lede = pageLede(site.pages, page.meta.description, plainText(introOf(page.body, page.headings), { code: false }));
  const icon = site.pages?.icons === true ? page.meta.icon : undefined;

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

  const pager = (prev || next) && (
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
  );

  if (page.api) {
    const op = page.api;
    return (
      <DocPageProvider value={{ ...info, editUrl: undefined }}>
        <DocsHeader activeTab={tab?.id} current={page.path} />
        <div className="dx-layout dx-layout--api">
          <aside className="dx-layout__nav">
            <DocsSidebar tab={tab?.id} current={page.path} />
          </aside>
          <main id="main" className="dx-article dx-api">
            <Breadcrumb items={crumbs} className="dx-crumbs" />
            <ApiHead op={op} />
            <div className="dx-titlerow">
              <h1 className="dx-title dx-api__title">{page.meta.title}</h1>
              <span className="dx-only-wide">
                <CopyPageButton />
              </span>
            </div>
            <ApiMain op={op} />
          </main>
          <aside className="dx-layout__api" aria-label="Examples and Try it">
            <ApiAside op={op} />
          </aside>
          {/* After the samples in the DOM, so a phone reads samples and Try it before "Did this help?". */}
          <div className="dx-api__foot">
            <Feedback />
            {pager}
          </div>
        </div>
        <DocsFooter />
        <MobileBottomBar />
      </DocPageProvider>
    );
  }

  // The article's parts, shared by the theme layouts (each is one element, so the sidebar layout's
  // tree is exactly what it was before themes).
  const meta = (
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
  );
  const builds = prereqPages.length > 0 && (
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
  );
  const askCard = ai && (
    <div className="dx-askcard">
      <strong>Have a question about this page?</strong>
      <span>{`${ai.name} answers from these docs, with links to the sections it used.`}</span>
      <AskAboutPageButton />
    </div>
  );
  const layout = themeLayout(site);

  if (layout === "top") {
    // No sidebar: the tab's sections in a row under the header, one centred column, the group's
    // pages under the article, contents in the right margin (or the bar on narrower screens).
    return (
      <DocPageProvider value={info}>
        <DocsHeader activeTab={tab?.id} current={page.path} />
        <DocsTopNav tab={tab?.id} current={page.path} />
        <OnThisPageBar entries={toc} />
        <div className="dx-layout dx-layout--top">
          <main id="main" className="dx-article">
            <Breadcrumb items={crumbs} className="dx-crumbs" />
            <ArticleTitle title={page.meta.title} icon={icon} lede={lede} />
            {meta}
            {builds}
            <DocsMarkdown source={page.body} anchors={page.meta.anchors} />
            {group && <SectionPages group={group} current={page.path} title={`In ${group.group}`} />}
            <Feedback />
            {pager}
          </main>
          <aside className="dx-layout__rail" aria-label="On this page">
            <div className="dx-rail">
              <DocsToc entries={toc} />
              <RailActions />
              {askCard}
            </div>
          </aside>
        </div>
        <DocsFooter />
        <MobileBottomBar />
      </DocPageProvider>
    );
  }

  if (layout === "helpcenter") {
    // An article: one column, with the rest of its category and the contents beside it.
    return (
      <DocPageProvider value={info}>
        <DocsHeader activeTab={tab?.id} current={page.path} />
        <OnThisPageBar entries={toc} />
        <div className="dx-layout dx-layout--hc">
          <main id="main" className="dx-article">
            <Breadcrumb items={crumbs} className="dx-crumbs" />
            <ArticleTitle title={page.meta.title} icon={icon} lede={lede} />
            {meta}
            {builds}
            <DocsMarkdown source={page.body} anchors={page.meta.anchors} />
            <Feedback />
            {pager}
          </main>
          <aside className="dx-layout__rail" aria-label="In this category">
            <div className="dx-rail">
              {group && <SectionPages group={group} current={page.path} title="In this category" />}
              <DocsToc entries={toc} />
              {askCard}
            </div>
          </aside>
        </div>
        <DocsFooter />
        <MobileBottomBar />
      </DocPageProvider>
    );
  }

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
          <ArticleTitle title={page.meta.title} icon={icon} lede={lede} />
          {meta}
          {builds}

          <DocsMarkdown source={page.body} anchors={page.meta.anchors} />

          <Feedback />

          {pager}
        </main>

        <aside className="dx-layout__rail" aria-label="On this page">
          <div className="dx-rail">
            <DocsToc entries={toc} />
            <RailActions />
            {askCard}
          </div>
        </aside>
      </div>
      <DocsFooter />
      <MobileBottomBar />
    </DocPageProvider>
  );
}
