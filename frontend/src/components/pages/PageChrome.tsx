"use client";

/**
 * A page's chrome: breadcrumbs (its readable ancestors) and "Pages inside" (its sub-pages, with
 * "Add a sub-page"). The page tree in the rail is PageTree.tsx (loaded lazily: it carries drag and drop).
 * Every list comes from the API already filtered to what this reader can open.
 */
import { useEffect, useState } from "react";
import { Anchor, Button, Icon, Skeleton, cx } from "@/components/ui";
import { listBacklinks, listChildren, type ChildPage, type Crumb } from "@/lib/pages";
import { pagePath } from "@/lib/pageBlocks.mjs";
import "./pages.css";

export interface PageAddressing {
  /** A workspace's own domain: pages live under their folders and ancestors. */
  tenant: boolean;
  folderPath: string[];
}

const hrefFor = (slug: string, ancestors: string[], a: PageAddressing) => pagePath(slug, { tenant: a.tenant, folderPath: a.folderPath, ancestors });

export function PageBreadcrumbs({ crumbs, title, addressing, className }: { crumbs: Crumb[]; title: string | null; addressing: PageAddressing; className?: string }) {
  if (!crumbs.length) return null;
  return (
    <nav aria-label="Breadcrumb" className={cx("no-print", className)}>
      <ol className="pb-crumbs">
        {crumbs.map((c, i) => (
          <li key={c.slug}>
            <Anchor href={hrefFor(c.slug, crumbs.slice(0, i).map((x) => x.slug), addressing)} className="md-focus ph-sensitive ph-mask" dir="auto">
              {c.icon && !/^(asset:|https?:)/.test(c.icon) ? `${c.icon} ` : ""}{c.title || "Untitled"}
            </Anchor>
            <Icon name="chevronRight" size={12} aria-hidden />
          </li>
        ))}
        <li>
          <span aria-current="page" className="ph-sensitive ph-mask" dir="auto">
            {title || "Untitled"}
          </span>
        </li>
      </ol>
    </nav>
  );
}

function ago(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = Math.round((Date.now() - t) / 86400000);
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  return d < 31 ? `${d} days ago` : new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** "Pages inside": the sub-pages this reader can open, and "+ Add a sub-page" for editors. */
export function SubPages({
  slug,
  count,
  ancestors,
  addressing,
  onAdd,
  refreshKey,
}: {
  slug: string;
  /** From the page read: 0 shows nothing unless the reader can add one. */
  count: number;
  ancestors: string[];
  addressing: PageAddressing;
  onAdd?: (() => void) | null;
  refreshKey?: number;
}) {
  const [kids, setKids] = useState<ChildPage[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!count) {
      setKids([]);
      return;
    }
    let live = true;
    setError(false);
    listChildren(slug)
      .then((k) => live && setKids(k))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [slug, count, refreshKey]);

  if (!count && !onAdd) return null;
  return (
    <section className="pb-children no-print" aria-labelledby="pb-children-h">
      <div className="pb-children__head">
        <h2 id="pb-children-h" className="text-eyebrow uppercase text-text-muted m-0">
          Pages inside
        </h2>
        {onAdd && (
          <Button size="sm" variant="ghost" iconLeft="plus" onClick={onAdd}>
            Add a sub-page
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-caption text-text-muted">Couldn&apos;t load the pages inside.</p>
      ) : kids === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton width="60%" />
          <Skeleton width="45%" />
        </div>
      ) : kids.length === 0 ? (
        onAdd ? <p className="text-caption text-text-muted m-0">No pages inside yet. A sub-page lives with this page and follows who can read it.</p> : null
      ) : (
        <ul className="pb-children__list ph-no-capture">
          {kids.map((k) => (
            <li key={k.slug}>
              <Anchor href={hrefFor(k.slug, [...ancestors, slug], addressing)} className="pb-children__item md-focus">
                <Icon name={k.has_children ? "layers" : "lines"} size={16} aria-hidden />
                <span className="pb-children__title ph-sensitive ph-mask" dir="auto">{k.title || "Untitled"}</span>
                {k.access_inherit === false && (
                  <span className="pb-children__meta" title="Who can read it is set on this page">
                    <Icon name="lock" size={12} aria-hidden /> Own access
                  </span>
                )}
                {k.updated_at && <span className="pb-children__meta">{ago(k.updated_at)}</span>}
              </Anchor>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "N backlinks": the pages that mention or embed this one, that this reader can open. */
export function Backlinks({ slug, addressing }: { slug: string; addressing: PageAddressing }) {
  const [links, setLinks] = useState<Array<{ slug: string; title: string | null; icon?: string | null }> | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    listBacklinks(slug)
      .then((l) => live && setLinks(l))
      .catch(() => live && setLinks([]));
    return () => {
      live = false;
    };
  }, [slug]);
  if (!links?.length) return null;
  return (
    <div className="pb-backlinks no-print">
      <button type="button" className="pb-backlinks__btn md-focus" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="arrowUpRight" size={14} aria-hidden /> {links.length === 1 ? "1 backlink" : `${links.length} backlinks`}
      </button>
      {open && (
        <ul className="pb-backlinks__list ph-no-capture">
          {links.map((l) => (
            <li key={l.slug}>
              <Anchor href={hrefFor(l.slug, [], addressing)} className="md-focus ph-sensitive ph-mask" dir="auto">
                {l.icon && !/^(asset:|https?:)/.test(l.icon) ? `${l.icon} ` : ""}
                {l.title || "Untitled"}
              </Anchor>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
