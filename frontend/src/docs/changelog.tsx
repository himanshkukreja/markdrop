/**
 * Server helpers for the changelog pages: entries as the client hub's plain data, their bodies and
 * media rendered on the server. Media renders only when it really exists (a video with a URL in
 * videos.json, or an image): the hub never shows a placeholder.
 */
import { getChangelog, getPage, getVideos, navLabel } from "./content";
import { plainText } from "./markdown";
import { formatDate } from "./outputs";
import { DocsMarkdown, VideoSlot } from "./render/DocsMarkdown";
import type { ChangelogEntry } from "./types";
import type { HubEntry } from "./client/Changelog";

export function toHubEntry(e: ChangelogEntry): HubEntry {
  const products = getChangelog().products;
  const label = (id: string) => products.find((p) => p.id === id)?.label ?? id;
  return {
    id: e.id,
    date: e.date,
    dateLabel: formatDate(e.date),
    shortDate: formatDate(e.date, { month: "short", day: "numeric" }),
    month: formatDate(e.date, { month: "long", year: "numeric" }),
    monthKey: e.date.slice(0, 7),
    title: e.title,
    kind: e.kind,
    area: e.area,
    products: e.products.map((id) => ({ id, label: label(id) })),
    versions: Object.entries(e.versions ?? {}).map(([product, version]) => ({ product, label: label(product), version })),
    summary: e.summary,
    highlights: e.highlights ?? [],
    docs: (e.docs ?? []).map((p) => {
      const page = getPage(p);
      return { path: p, title: page ? navLabel(page) : p };
    }).filter((d) => getPage(d.path)),
    try: e.try && typeof e.try.href === "string" ? e.try : undefined,
    text: [e.title, e.area, e.summary, ...(e.highlights ?? []), plainText(e.body ?? "")].join(" ").toLowerCase(),
    hasBody: !!e.body?.trim(),
  };
}

/** True when the entry has media worth showing: an image, or a video that resolves to a URL. */
export function hasMedia(e: ChangelogEntry): boolean {
  if (e.media?.image) return true;
  const id = e.media?.video;
  return !!id && !!getVideos()[id]?.url;
}

export function EntryMedia({ e }: { e: ChangelogEntry }) {
  if (!hasMedia(e)) return null;
  if (e.media?.video && getVideos()[e.media.video]?.url) return <VideoSlot vid={e.media.video} label={e.title} />;
  return (
    <figure className="dxc-figure">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={e.media!.image} alt={e.media!.alt ?? ""} loading="lazy" decoding="async" />
    </figure>
  );
}

/** Each entry's real media, keyed by id (entries without media are left out). */
export function mediaMap(entries: ChangelogEntry[]): Record<string, React.ReactNode> {
  return Object.fromEntries(entries.filter(hasMedia).map((e) => [e.id, <EntryMedia key={e.id} e={e} />]));
}

/** Each entry's Markdown body rendered for the expandable "Read more", keyed by id. */
export function bodyMap(entries: ChangelogEntry[]): Record<string, React.ReactNode> {
  return Object.fromEntries(entries.filter((e) => e.body?.trim()).map((e) => [e.id, <DocsMarkdown key={e.id} source={e.body!} className="dxc-prose" />]));
}

/** The product whose versions the "Since your version" picker offers (the first one any entry pins). */
export function versionProduct(): { id: string; label: string } | undefined {
  const cl = getChangelog();
  const id = cl.entries.flatMap((e) => Object.keys(e.versions ?? {}))[0];
  if (!id) return undefined;
  return { id, label: cl.products.find((p) => p.id === id)?.label ?? id };
}
