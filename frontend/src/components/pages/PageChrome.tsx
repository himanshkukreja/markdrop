"use client";

/**
 * A page's chrome: breadcrumbs (its readable ancestors), "Pages inside" (its sub-pages, with
 * "Add a sub-page") and the page tree (the rail: the top page and its sub-pages, opened lazily).
 * Every list comes from the API already filtered to what this reader can open.
 */
import { useCallback, useEffect, useState } from "react";
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

interface TreeItem {
  slug: string;
  title: string | null;
  has_children: boolean;
}

function TreeBranch({ item, ancestors, current, addressing, open, toggle, kidsOf, level }: {
  item: TreeItem;
  ancestors: string[];
  current: string;
  addressing: PageAddressing;
  open: Set<string>;
  toggle: (slug: string) => void;
  kidsOf: Record<string, ChildPage[] | "loading" | "error">;
  level: number;
}) {
  const isOpen = open.has(item.slug);
  const kids = kidsOf[item.slug];
  return (
    <li>
      <div className="pb-tree__row">
        {item.has_children ? (
          <button type="button" className="pb-tree__toggle md-focus" aria-expanded={isOpen} aria-label={isOpen ? "Collapse" : "Expand"} onClick={() => toggle(item.slug)}>
            <Icon name="chevronRight" size={12} />
          </button>
        ) : (
          <span className="pb-tree__spacer" aria-hidden />
        )}
        <Anchor
          href={hrefFor(item.slug, ancestors, addressing)}
          className="pb-tree__link md-focus ph-sensitive ph-mask"
          aria-current={item.slug === current ? "page" : undefined}
          dir="auto"
          style={{ paddingLeft: 4 }}
          data-level={level}
        >
          {item.title || "Untitled"}
        </Anchor>
      </div>
      {isOpen && item.has_children && (
        kids === "loading" || kids === undefined ? (
          <div className="pl-6 py-1"><Skeleton width="70%" /></div>
        ) : kids === "error" ? (
          <p className="pl-6 text-caption text-text-muted m-0">Couldn&apos;t load</p>
        ) : (
          <ul>
            {kids.map((k) => (
              <TreeBranch key={k.slug} item={k} ancestors={[...ancestors, item.slug]} current={current} addressing={addressing} open={open} toggle={toggle} kidsOf={kidsOf} level={level + 1} />
            ))}
          </ul>
        )
      )}
    </li>
  );
}

/**
 * The page tree in the rail: the top page of this one's chain and its sub-pages, the path to this
 * page open. Sub-pages load when a branch opens (GET …/children).
 */
export function PageTree({ slug, title, crumbs, childrenCount, addressing }: { slug: string; title: string | null; crumbs: Crumb[]; childrenCount: number; addressing: PageAddressing }) {
  const root: TreeItem = crumbs.length ? { slug: crumbs[0].slug, title: crumbs[0].title, has_children: true } : { slug, title, has_children: childrenCount > 0 };
  const [open, setOpen] = useState<Set<string>>(() => new Set([...crumbs.map((c) => c.slug), ...(childrenCount > 0 ? [slug] : [])]));
  const [kidsOf, setKidsOf] = useState<Record<string, ChildPage[] | "loading" | "error">>({});

  const load = useCallback((s: string) => {
    setKidsOf((m) => (m[s] && m[s] !== "error" ? m : { ...m, [s]: "loading" }));
    listChildren(s)
      .then((k) => setKidsOf((m) => ({ ...m, [s]: k })))
      .catch(() => setKidsOf((m) => ({ ...m, [s]: "error" })));
  }, []);

  useEffect(() => {
    open.forEach((s) => {
      if (!kidsOf[s]) load(s);
    });
  }, [open, kidsOf, load]);

  const toggle = (s: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  if (!root.has_children && !crumbs.length) return null;
  return (
    <nav aria-label="Pages" className="no-print">
      <h2 className="text-eyebrow uppercase text-text-muted mb-2 mt-0">Pages</h2>
      <ul className="pb-tree ph-no-capture">
        <TreeBranch item={root} ancestors={[]} current={slug} addressing={addressing} open={open} toggle={toggle} kidsOf={kidsOf} level={0} />
      </ul>
    </nav>
  );
}
