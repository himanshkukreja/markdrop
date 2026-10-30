/**
 * Every machine-readable output of a docs site, built from the content at build time: the search
 * index, llms.txt / llms-full.txt (llmstxt.org), skill.md, sitemap.xml, robots.txt and the
 * changelog feeds (RSS 2.0, JSON Feed 1.1, Markdown).
 */
import { absoluteUrl, getAllPages, getChangelog, getNav, getPage, getSite, homeMarkdown, mdUrl, navLabel, orderedPages, plainOf } from "./content";
import { introOf, plainText, snippet } from "./markdown";
import type { ChangelogEntry, SearchDoc } from "./types";

/* ── Search ──────────────────────────────────────────────────────────────── */

const MAX_TEXT = 1200;

export function buildSearchIndex(): SearchDoc[] {
  const docs: SearchDoc[] = [];
  const nav = getNav();
  const where = (p: string) => nav.find((g) => g.items.some((it) => it.path === p))?.group ?? "";
  for (const page of orderedPages()) {
    const intro = plainText(introOf(page.body, page.headings));
    docs.push({
      id: page.path,
      kind: "page",
      title: page.meta.title,
      where: where(page.path),
      href: page.path,
      text: `${page.meta.description} ${intro}`.slice(0, MAX_TEXT),
      keywords: page.meta.keywords?.join(" "),
      snippet: page.meta.description,
    });
    const lines = page.body.split(/\r?\n/);
    page.headings.forEach((h, i) => {
      if (h.depth < 2 || h.depth > 3) return;
      const end = page.headings[i + 1]?.line ?? lines.length;
      const text = plainText(lines.slice(h.line + 1, end).join("\n"));
      docs.push({
        id: `${page.path}#${h.id}`,
        kind: "section",
        title: h.text,
        where: navLabel(page),
        href: `${page.path}#${h.id}`,
        text: text.slice(0, MAX_TEXT),
        snippet: snippet(plainText(lines.slice(h.line + 1, end).join("\n"), { code: false }) || text, 140),
      });
    });
  }
  for (const e of getChangelog().entries) {
    docs.push({
      id: `changelog:${e.id}`,
      kind: "change",
      title: e.title,
      where: `Changelog · ${formatDate(e.date)}`,
      href: `/changelog/${e.id}`,
      text: [e.summary, ...(e.highlights ?? []), plainText(e.body ?? "")].join(" ").slice(0, MAX_TEXT),
      keywords: e.area,
      snippet: e.summary,
    });
  }
  return docs;
}

/* ── llms.txt ────────────────────────────────────────────────────────────── */

export function llmsTxt(): string {
  const site = getSite();
  const out: string[] = [`# ${site.name}`, "", `> ${site.description}`, ""];
  out.push(
    `Every page is also served as Markdown: add \`.md\` to its address, or send \`Accept: text/markdown\`. ` +
      `Each Markdown file starts with its title, canonical address, last update and the pages it assumes you have read. ` +
      `The full text of every page is at ${site.url}/llms-full.txt.` +
      (site.product ? ` ${site.product.name} itself is at ${site.product.url}.` : ""),
    "",
  );
  const listed = new Set<string>();
  for (const g of getNav()) {
    const items = g.items.filter((it) => it.available);
    if (!items.length) continue;
    out.push(`## ${g.group}`, "");
    for (const it of items) {
      const page = getPage(it.path)!;
      listed.add(page.path);
      out.push(`- [${page.meta.title}](${mdUrl(page.path)}): ${page.meta.description}`);
    }
    out.push("");
  }
  const extra = getAllPages().filter((p) => !listed.has(p.path));
  out.push("## Optional", "");
  for (const page of extra) out.push(`- [${page.meta.title}](${mdUrl(page.path)}): ${page.meta.description}`);
  out.push(`- [Changelog](${site.url}/changelog.md): every change, newest first, with the pages it touched`);
  out.push(`- [Full text](${site.url}/llms-full.txt): every page above in one file`);
  out.push(`- [Agent skill](${site.url}/skill.md): how an assistant should use these docs`);
  return out.join("\n") + "\n";
}

export function llmsFullTxt(): string {
  const site = getSite();
  const parts = [`# ${site.name}\n\n> ${site.description}\n`];
  for (const page of orderedPages()) {
    parts.push(`# ${page.meta.title}\nSource: ${absoluteUrl(page.path)}\n\n${plainOf(page.body, site.url)}\n`);
  }
  return parts.join("\n---\n\n");
}

export function skillMd(): string {
  const site = getSite();
  const name = site.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const product = site.product?.name ?? site.name;
  const groups = getNav()
    .map((g) => {
      const items = g.items.filter((it) => it.available);
      return items.length ? `- ${g.group}: ${items.map((it) => `[${it.title}](${mdUrl(it.path)})`).join(", ")}` : "";
    })
    .filter(Boolean);
  return `---
name: ${name}
description: Answer questions about ${product} from its official documentation at ${site.url}. Use when the user asks how ${product} works, how to do something in it, or what changed.
---

# ${site.name}

${site.description}

## How to use these docs

1. Start from the index at ${site.url}/llms.txt. It lists every page with a one-line description.
2. Read a page as Markdown by adding \`.md\` to its address (for example ${mdUrl(orderedPages()[0]?.path ?? "/")}), or request the page with \`Accept: text/markdown\`.
3. Each page's frontmatter lists \`prerequisites\`: read those first when the user is new to the topic.
4. Link the user to the exact section: headings have stable anchors (\`${site.url}/<page>#<heading-slug>\`).
5. For what changed recently, read ${site.url}/changelog.md (newest first).
6. If the docs don't answer the question, say so rather than guessing.

## Pages

${groups.join("\n")}
`;
}

/* ── Sitemap / robots ────────────────────────────────────────────────────── */

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function sitemapXml(): string {
  const site = getSite();
  const urls: Array<{ loc: string; lastmod?: string }> = [{ loc: `${site.url}/` }, { loc: `${site.url}/changelog` }];
  for (const page of orderedPages()) urls.push({ loc: absoluteUrl(page.path), lastmod: page.meta.updated || undefined });
  for (const e of getChangelog().entries) urls.push({ loc: `${site.url}/changelog/${e.id}`, lastmod: e.date });
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n") +
    `\n</urlset>\n`
  );
}

export function robotsTxt(): string {
  const site = getSite();
  return `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n# Docs for language models: ${site.url}/llms.txt\n`;
}

/* ── Changelog feeds ─────────────────────────────────────────────────────── */

export function formatDate(d: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }): string {
  const t = Date.parse(`${d}T12:00:00Z`);
  return isNaN(t) ? d : new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(t);
}

function productLabel(id: string): string {
  return getChangelog().products.find((p) => p.id === id)?.label ?? id;
}

export function entryMarkdown(e: ChangelogEntry, level = 2): string {
  const site = getSite();
  const h = "#".repeat(level);
  const meta = [
    `${formatDate(e.date)}`,
    e.kind[0].toUpperCase() + e.kind.slice(1),
    e.area,
    e.products.length ? e.products.map(productLabel).join(", ") : "",
    ...Object.entries(e.versions ?? {}).map(([k, v]) => `${productLabel(k)} ${v} or later`),
  ].filter(Boolean);
  const lines = [`${h} ${e.title}`, "", `_${meta.join(" · ")}_`, "", e.summary];
  if (e.highlights?.length) lines.push("", ...e.highlights.map((x) => `- ${x}`));
  if (e.body) lines.push("", plainOf(e.body, site.url));
  if (e.try) lines.push("", `Try it: [${e.try.label}](${e.try.href})`);
  if (e.docs?.length) lines.push("", `Docs updated: ${e.docs.map((d) => `[${getPage(d)?.meta.title ?? d}](${mdUrl(d)})`).join(", ")}`);
  lines.push("", `Permalink: ${site.url}/changelog/${e.id}`);
  return lines.join("\n");
}

export function changelogMd(): string {
  const site = getSite();
  const cl = getChangelog();
  const title = site.changelog?.title || "Changelog";
  const parts = [`---\ntitle: ${JSON.stringify(title)}\ncanonical_url: ${site.url}/changelog\nfeeds: [${site.url}/changelog.rss, ${site.url}/changelog.json]\n---\n\n# ${title}\n\n${site.changelog?.description ?? ""}`.trim()];
  if (cl.next.length) parts.push(`## Coming next\n\n${cl.next.map((n) => `- **${n.title}**${n.body ? `: ${n.body}` : ""}`).join("\n")}`);
  for (const e of cl.entries) parts.push(entryMarkdown(e));
  return parts.join("\n\n") + "\n";
}

function rfc822(d: string): string {
  const t = Date.parse(`${d}T12:00:00Z`);
  return isNaN(t) ? new Date().toUTCString() : new Date(t).toUTCString();
}

export function changelogRss(): string {
  const site = getSite();
  const cl = getChangelog();
  const title = site.changelog?.title || `${site.name} changelog`;
  const items = cl.entries.map((e) => {
    const link = `${site.url}/changelog/${e.id}`;
    const desc = [e.summary, ...(e.highlights ?? []).map((h) => `• ${h}`)].join("\n");
    return `    <item>
      <title>${xmlEscape(e.title)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="true">${xmlEscape(link)}</guid>
      <pubDate>${rfc822(e.date)}</pubDate>
      <category>${xmlEscape(e.area)}</category>
      <description>${xmlEscape(desc)}</description>
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>${xmlEscape(`${site.url}/changelog`)}</link>
    <atom:link href="${xmlEscape(`${site.url}/changelog.rss`)}" rel="self" type="application/rss+xml" />
    <description>${xmlEscape(site.changelog?.description || site.description)}</description>
    <language>en</language>
${cl.entries[0] ? `    <lastBuildDate>${rfc822(cl.entries[0].date)}</lastBuildDate>\n` : ""}${items.join("\n")}
  </channel>
</rss>
`;
}

export function changelogJsonFeed(): string {
  const site = getSite();
  const cl = getChangelog();
  return JSON.stringify(
    {
      version: "https://jsonfeed.org/version/1.1",
      title: site.changelog?.title || `${site.name} changelog`,
      home_page_url: `${site.url}/changelog`,
      feed_url: `${site.url}/changelog.json`,
      description: site.changelog?.description || site.description,
      language: "en",
      items: cl.entries.map((e) => ({
        id: `${site.url}/changelog/${e.id}`,
        url: `${site.url}/changelog/${e.id}`,
        title: e.title,
        summary: e.summary,
        content_text: entryMarkdown(e, 1),
        date_published: `${e.date}T12:00:00Z`,
        tags: [e.area, e.kind, ...e.products],
        ...(e.media?.image ? { image: e.media.image.startsWith("/") ? site.url + e.media.image : e.media.image } : {}),
        _docs: { kind: e.kind, area: e.area, products: e.products, versions: e.versions ?? {}, docs: e.docs ?? [] },
      })),
    },
    null,
    2,
  );
}

export { homeMarkdown };
