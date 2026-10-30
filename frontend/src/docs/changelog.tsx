/**
 * Server helpers for the changelog pages: entries as the client hub's plain data, and their media
 * (video slot or image) rendered on the server.
 */
import { getChangelog, getPage, navLabel } from "./content";
import { formatDate } from "./outputs";
import { VideoSlot } from "./render/DocsMarkdown";
import type { ChangelogEntry } from "./types";
import type { HubEntry } from "./client/Changelog";

export function toHubEntry(e: ChangelogEntry): HubEntry {
  const products = getChangelog().products;
  const label = (id: string) => products.find((p) => p.id === id)?.label ?? id;
  return {
    id: e.id,
    date: e.date,
    dateLabel: formatDate(e.date),
    month: formatDate(e.date, { month: "long", year: "numeric" }),
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
  };
}

export function EntryMedia({ e }: { e: ChangelogEntry }) {
  if (e.media?.video) return <VideoSlot vid={e.media.video} label={e.title} />;
  if (e.media?.image)
    return (
      <figure className="dx-entry__media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={e.media.image} alt={e.media.alt ?? ""} loading="lazy" decoding="async" />
      </figure>
    );
  return null;
}

/** The product whose versions the "Since your version" picker offers (the first one any entry pins). */
export function versionProduct(): { id: string; label: string } | undefined {
  const cl = getChangelog();
  const id = cl.entries.flatMap((e) => Object.keys(e.versions ?? {}))[0];
  if (!id) return undefined;
  return { id, label: cl.products.find((p) => p.id === id)?.label ?? id };
}
