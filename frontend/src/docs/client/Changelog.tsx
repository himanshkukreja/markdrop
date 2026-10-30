"use client";

/**
 * The release hub: hero (subscribe, search), the newest release as a spotlight, then every other
 * release as compact cards grouped by month, with a sticky filter bar (kind, area, product, "Since
 * my CLI version"), a "Jump to" rail with scroll-spy on wide screens, and "New to you" from the
 * reader's last visit. Bodies and media arrive rendered on the server; everything else is plain data.
 */
import Link from "@/docs/client/Link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, CopyButton, Drawer, Dropdown, EmptyState, Icon, Input, Popover, SegmentedControl, Select, VSCodeIcon, announce, copyText, cx } from "@/components/ui";
import type { ChangeKind } from "../types";
import { useChangelogLastVisit } from "./state";
import { InlineCode } from "../ui/InlineCode";

export interface HubEntry {
  id: string;
  date: string;
  dateLabel: string;
  shortDate: string;
  month: string;
  monthKey: string;
  title: string;
  kind: ChangeKind;
  area: string;
  products: Array<{ id: string; label: string }>;
  versions: Array<{ product: string; label: string; version: string }>;
  summary: string;
  highlights: string[];
  docs: Array<{ path: string; title: string }>;
  try?: { label: string; href: string };
  /** Lowercased title, area, summary, highlights and body text, for the search box. */
  text: string;
  hasBody: boolean;
}

export interface NextItem {
  title: string;
  body?: string;
  area?: string;
}

type KindFilter = "all" | ChangeKind;

const KIND: Record<ChangeKind, { label: string; icon: string }> = {
  new: { label: "New", icon: "sparkle" },
  improved: { label: "Improved", icon: "arrowUp" },
  fixed: { label: "Fixed", icon: "bug" },
};

const PRODUCT_ICON: Record<string, string> = { web: "globe", cli: "terminal", mcp: "server", api: "code" };

const isExternal = (href: string) => /^https?:/.test(href);

function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Small pieces ────────────────────────────────────────────────────────── */

export function KindPill({ kind }: { kind: ChangeKind }) {
  return (
    <span className={cx("dxc-kind", `dxc-k--${kind}`)}>
      <Icon name={KIND[kind].icon} />
      {KIND[kind].label}
    </span>
  );
}

function ProductGlyph({ id }: { id: string }) {
  if (id === "vscode") return <VSCodeIcon className="dxc-glyph" />;
  return <Icon name={PRODUCT_ICON[id] ?? "layers"} />;
}

export function ProductIcons({ products }: { products: HubEntry["products"] }) {
  if (!products.length) return null;
  return (
    <ul className="dxc-prods" aria-label="Products">
      {products.map((p) => (
        <li key={p.id} className="dxc-prod" data-tip={p.label}>
          <ProductGlyph id={p.id} />
          <span className="dx-sr">{p.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function VersionBadge({ v }: { v: HubEntry["versions"][number] }) {
  return (
    <span className="dxc-ver" title={`Needs ${v.label} ${v.version} or newer`}>
      <span className="dxc-ver__p">{v.label}</span>
      {v.version}
    </span>
  );
}

function NewToYou() {
  return (
    <span className="dxc-new">
      <span className="dxc-new__dot" aria-hidden />
      New to you
    </span>
  );
}

function Checks({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="dxc-checks">
      {items.map((h) => (
        <li key={h}>
          <Icon name="check" />
          <InlineCode text={h} />
        </li>
      ))}
    </ul>
  );
}

export function DocsUpdated({ docs }: { docs: HubEntry["docs"] }) {
  if (!docs.length) return null;
  return (
    <div className="dxc-docs">
      <p className="dxc-docs__label">Docs updated</p>
      <ul className="dxc-docs__list">
        {docs.map((d) => (
          <li key={d.path}>
            <Link href={d.path}>
              <Icon name="doc" />
              {d.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TryButton({ e, variant = "primary", size = "md" }: { e: HubEntry; variant?: "primary" | "secondary"; size?: "sm" | "md" }) {
  if (!e.try) return null;
  const ext = isExternal(e.try.href);
  return (
    <Button href={e.try.href} variant={variant} size={size} iconRight={ext ? "external" : "arrowRight"} target={ext ? "_blank" : undefined}>
      {e.try.label}
    </Button>
  );
}

/**
 * A generated cover for a release without media: its products as tiles (the first one lit in the
 * release's kind colour), the pinned version as a mono tile, on a faded grid. Tokens only, so it
 * follows the theme; decorative, so hidden from assistive tech.
 */
export function ReleaseVisual({ e, compact }: { e: HubEntry; compact?: boolean }) {
  const [lead, ...rest] = e.products;
  const far = new Set(rest.slice(2).map((p) => p.id));
  const left = rest.filter((_, i) => i % 2 === 1).reverse();
  const right = rest.filter((_, i) => i % 2 === 0);
  const v = e.versions[0];
  let i = 0;
  const tile = (p: HubEntry["products"][number], isLead = false) => (
    <span key={p.id} className={cx("dxc-tile", isLead && "dxc-tile--lead", far.has(p.id) && "dxc-tile--far")} style={{ "--i": i++ } as React.CSSProperties}>
      <ProductGlyph id={p.id} />
    </span>
  );
  return (
    <div className={cx("dxc-visual", `dxc-k--${e.kind}`, compact && "dxc-visual--compact")} aria-hidden>
      <span className="dxc-visual__grid" />
      <span className="dxc-visual__glow" />
      <span className="dxc-visual__stage">
        <span className="dxc-tile dxc-tile--ghost" />
        {left.map((p) => tile(p))}
        {lead && tile(lead, true)}
        {right.map((p) => tile(p))}
        {v && (
          <span className="dxc-tile dxc-tile--ver" style={{ "--i": i++ } as React.CSSProperties}>
            <span className="dxc-tile__k">{v.label}</span>
            <span className="dxc-tile__v">{v.version}</span>
          </span>
        )}
        <span className="dxc-tile dxc-tile--ghost" />
      </span>
      <span className="dxc-visual__tag">
        <Icon name={KIND[e.kind].icon} />
        {e.area}
      </span>
      <span className="dxc-visual__date">{e.date}</span>
    </div>
  );
}

/* ── Spotlight (the newest release, and the permalink page) ──────────────── */

export function Spotlight({ e, media, siteUrl, unread, permalink }: { e: HubEntry; media?: React.ReactNode; siteUrl: string; unread?: boolean; permalink?: boolean }) {
  const H = permalink ? "h1" : "h2";
  return (
    <article className={cx("dxc-spot", permalink && "dxc-spot--page")} id={permalink ? undefined : e.id} aria-labelledby={`${e.id}-t`}>
      {media ? <div className="dxc-spot__media">{media}</div> : <ReleaseVisual e={e} />}
      <div className="dxc-spot__body">
        <div className="dxc-meta">
          {!permalink && <span className="dxc-latest">Latest release</span>}
          <KindPill kind={e.kind} />
          <span className="dxc-meta__area">{e.area}</span>
          <span className="dxc-meta__sep" aria-hidden />
          <time dateTime={e.date}>{e.dateLabel}</time>
          {unread && <NewToYou />}
        </div>
        <H id={`${e.id}-t`} className="dxc-spot__title">
          {permalink ? e.title : <Link href={`/changelog/${e.id}`}>{e.title}</Link>}
        </H>
        <p className="dxc-spot__summary">
          <InlineCode text={e.summary} />
        </p>
        <Checks items={e.highlights} />
        <div className="dxc-spot__foot">
          <div className="dxc-spot__actions">
            <TryButton e={e} />
            {permalink ? (
              <CopyButton text={`${siteUrl}/changelog/${e.id}`} label="Copy link" size="md" variant="secondary" announceText="Link copied" />
            ) : (
              <>
                <Link href={`/changelog/${e.id}`} className="dxc-readlink">
                  Read the release
                  <Icon name="arrowRight" />
                </Link>
              </>
            )}
          </div>
          <div className="dxc-spot__chips">
            <ProductIcons products={e.products} />
            {e.versions.map((v) => (
              <VersionBadge key={v.product} v={v} />
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

/* ── Timeline card ───────────────────────────────────────────────────────── */

function ReleaseCard({ e, body, media, siteUrl, unread, open, onToggle }: { e: HubEntry; body?: React.ReactNode; media?: React.ReactNode; siteUrl: string; unread: boolean; open: boolean; onToggle: () => void }) {
  const url = `${siteUrl}/changelog/${e.id}`;
  const panelId = `${e.id}-more`;
  return (
    <li className={cx("dxc-item", unread && "dxc-item--unread")}>
      <div className="dxc-item__when" aria-hidden>
        {e.shortDate}
      </div>
      <div className={cx("dxc-item__node", `dxc-k--${e.kind}`)} aria-hidden>
        <span />
      </div>
      <article className={cx("dxc-card", open && "dxc-card--open")} id={e.id} aria-labelledby={`${e.id}-t`}>
        <div className="dxc-meta">
          <KindPill kind={e.kind} />
          <span className="dxc-meta__area">{e.area}</span>
          <span className="dxc-meta__sep" aria-hidden />
          <time dateTime={e.date}>{e.dateLabel}</time>
          {unread && <NewToYou />}
          <span className="dxc-card__tools">
            <Link href={`/changelog/${e.id}`} className="dxc-iconlink" aria-label={`Open the page for ${e.title}`} title="Open release page">
              <Icon name="link" />
            </Link>
            <CopyButton text={url} label="Copy link" iconOnly size="sm" variant="ghost" announceText="Link copied" className="dxc-iconcopy" />
          </span>
        </div>
        <h3 id={`${e.id}-t`} className="dxc-card__title">
          <Link href={`/changelog/${e.id}`}>{e.title}</Link>
        </h3>
        <p className="dxc-card__summary">
          <InlineCode text={e.summary} />
        </p>
        <div className="dxc-card__foot">
          <ProductIcons products={e.products} />
          {e.versions.map((v) => (
            <VersionBadge key={v.product} v={v} />
          ))}
          <button type="button" className="dxc-more" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
            {open ? "Show less" : "Read more"}
            <span className="dx-sr">: {e.title}</span>
            <Icon name="chevronDown" />
          </button>
        </div>
        <div id={panelId} className="dxc-card__more" hidden={!open}>
          {media && <div className="dxc-card__media">{media}</div>}
          {body}
          {e.highlights.length > 0 && <Checks items={e.highlights} />}
          <div className="dxc-card__actions">
            <TryButton e={e} variant="secondary" size="sm" />
            <Link href={`/changelog/${e.id}`} className="dxc-readlink dxc-readlink--sm">
              Release page
              <Icon name="arrowRight" />
            </Link>
            <CopyButton text={url} label="Copy link" size="sm" variant="ghost" announceText="Link copied" className="dxc-copy-inline" />
          </div>
          <DocsUpdated docs={e.docs} />
        </div>
      </article>
    </li>
  );
}

/* ── Hero pieces ─────────────────────────────────────────────────────────── */

function SubscribeMenu({ siteUrl }: { siteUrl: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Dropdown
      aria-label="Subscribe"
      minWidth={260}
      trigger={
        <Button variant="secondary" size="md" iconLeft={copied ? "check" : "wave"} iconRight="chevronDown" className="dxc-subscribe">
          {copied ? "Feed link copied" : "Subscribe"}
        </Button>
      }
      items={[
        { header: "Follow releases" },
        { label: "RSS feed", icon: "wave", href: "/changelog.rss", description: "For feed readers" },
        { label: "JSON Feed", icon: "code", href: "/changelog.json", description: "jsonfeed.org format" },
        { label: "Markdown for AI", icon: "doc", href: "/changelog.md", description: "Paste into Claude or ChatGPT" },
        {
          label: "Copy feed link",
          icon: "copy",
          separated: true,
          onClick: () => {
            void copyText(`${siteUrl}/changelog.rss`).then((ok) => {
              announce(ok ? "Feed link copied" : "Couldn't copy the feed link");
              if (ok) setCopied(true);
            });
          },
        },
      ]}
    />
  );
}

/* ── Filters ─────────────────────────────────────────────────────────────── */

interface FilterState {
  kind: KindFilter;
  areas: string[];
  products: string[];
  since: string;
  q: string;
}

const EMPTY: FilterState = { kind: "all", areas: [], products: [], since: "", q: "" };

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function FilterPanel({
  f,
  set,
  areas,
  products,
  versions,
  versionProduct,
  count,
  onDone,
}: {
  f: FilterState;
  set: (p: Partial<FilterState>) => void;
  areas: Array<[string, number]>;
  products: Array<[string, string]>;
  versions: string[];
  versionProduct?: { id: string; label: string };
  count: number;
  onDone: () => void;
}) {
  const panelActive = f.areas.length + f.products.length > 0 || !!f.since;
  return (
    <div className="dxc-fp">
      <fieldset className="dxc-fp__group">
        <legend>Area</legend>
        <div className="dxc-fp__chips">
          {areas.map(([a, n]) => (
            <button key={a} type="button" className="dxc-fchip" aria-pressed={f.areas.includes(a)} onClick={() => set({ areas: toggle(f.areas, a) })}>
              {a}
              <span className="dxc-fchip__n">{n}</span>
            </button>
          ))}
        </div>
      </fieldset>
      {products.length > 1 && (
        <fieldset className="dxc-fp__group">
          <legend>Product</legend>
          <div className="dxc-fp__chips">
            {products.map(([id, label]) => (
              <button key={id} type="button" className="dxc-fchip" aria-pressed={f.products.includes(id)} onClick={() => set({ products: toggle(f.products, id) })}>
                <ProductGlyph id={id} />
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {versionProduct && versions.length > 0 && (
        <div className="dxc-fp__group">
          <label className="dxc-fp__label" htmlFor="dxc-since">
            Since my {versionProduct.label} version
          </label>
          <Select
            id="dxc-since"
            value={f.since}
            onChange={(e) => set({ since: e.target.value })}
            options={[{ value: "", label: `Any ${versionProduct.label} version` }, ...versions.map((v) => ({ value: v, label: `${versionProduct.label} ${v}` }))]}
          />
          {f.since && <p className="dxc-fp__hint">Changes that need a {versionProduct.label} newer than {f.since}, plus everything released after it.</p>}
        </div>
      )}
      <div className="dxc-fp__foot">
        <Button variant="ghost" size="sm" disabled={!panelActive} onClick={() => set({ areas: [], products: [], since: "" })}>
          Clear
        </Button>
        <Button variant="primary" size="sm" onClick={onDone}>
          {count === 1 ? "Show 1 release" : `Show ${count} releases`}
        </Button>
      </div>
    </div>
  );
}

/* ── The hub ─────────────────────────────────────────────────────────────── */

export function ChangelogHub({
  title,
  description,
  entries,
  media,
  bodies,
  siteUrl,
  versionProduct,
  next,
}: {
  title: string;
  description?: string;
  entries: HubEntry[];
  media: Record<string, React.ReactNode>;
  bodies: Record<string, React.ReactNode>;
  siteUrl: string;
  versionProduct?: { id: string; label: string };
  next: NextItem[];
}) {
  const [f, setF] = useState<FilterState>(EMPTY);
  const set = useCallback((p: Partial<FilterState>) => setF((s) => ({ ...s, ...p })), []);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  const phone = useMedia("(max-width: 639px)");
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const lastVisit = useChangelogLastVisit(today);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  /* Options */
  const areas = useMemo(() => {
    const count = new Map<string, number>();
    entries.forEach((e) => count.set(e.area, (count.get(e.area) ?? 0) + 1));
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [entries]);
  const products = useMemo(() => {
    const m = new Map<string, string>();
    entries.forEach((e) => e.products.forEach((p) => m.set(p.id, p.label)));
    return [...m.entries()];
  }, [entries]);
  /** Each pinned version: when it first shipped, and the entry the rail jumps to (the release named for it, else the oldest). */
  const versions = useMemo(() => {
    if (!versionProduct) return [] as Array<{ version: string; date: string; id: string; dateLabel: string }>;
    const m = new Map<string, HubEntry[]>();
    for (const e of entries) {
      const v = e.versions.find((x) => x.product === versionProduct.id)?.version;
      if (v) m.set(v, [...(m.get(v) ?? []), e]);
    }
    return [...m.entries()]
      .map(([version, es]) => {
        const oldest = es.reduce((a, b) => (b.date < a.date ? b : a));
        const named = es.find((e) => e.area === versionProduct.label) ?? oldest;
        return { version, date: oldest.date, id: named.id, dateLabel: named.shortDate };
      })
      .sort((a, b) => cmpVersion(b.version, a.version));
  }, [entries, versionProduct]);

  /* Filtering */
  const terms = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sinceDate = versions.find((v) => v.version === f.since)?.date;
  const base = entries.filter((e) => {
    if (f.areas.length && !f.areas.includes(e.area)) return false;
    if (f.products.length && !e.products.some((p) => f.products.includes(p.id))) return false;
    if (terms.length && !terms.every((t) => e.text.includes(t))) return false;
    if (f.since && versionProduct) {
      const need = e.versions.find((x) => x.product === versionProduct.id)?.version;
      if (need) return cmpVersion(need, f.since) > 0;
      return !!sinceDate && e.date > sinceDate;
    }
    return true;
  });
  const kindCount = (k: KindFilter) => (k === "all" ? base.length : base.filter((e) => e.kind === k).length);
  const shown = f.kind === "all" ? base : base.filter((e) => e.kind === f.kind);
  const filtering = f.kind !== "all" || f.areas.length > 0 || f.products.length > 0 || !!f.since || terms.length > 0;
  const panelCount = f.areas.length + f.products.length + (f.since ? 1 : 0);
  const spotlight = !filtering ? entries[0] : undefined;
  const timeline = spotlight ? shown.slice(1) : shown;
  const isUnread = (e: HubEntry) => !!lastVisit && e.date > lastVisit;
  const unread = lastVisit ? entries.filter((e) => e.date > lastVisit).length : 0;

  const months: Array<{ key: string; month: string; items: HubEntry[] }> = [];
  for (const e of timeline) {
    const last = months[months.length - 1];
    if (last && last.key === e.monthKey) last.items.push(e);
    else months.push({ key: e.monthKey, month: e.month, items: [e] });
  }
  const railMonths: Array<{ key: string; month: string; n: number }> = [];
  for (const e of shown) {
    const last = railMonths[railMonths.length - 1];
    if (last && last.key === e.monthKey) last.n++;
    else railMonths.push({ key: e.monthKey, month: e.month, n: 1 });
  }
  const monthTarget = (key: string) => (months.some((m) => m.key === key) ? `m-${key}` : spotlight?.monthKey === key ? spotlight.id : `m-${key}`);

  const toggleOpen = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
    return true;
  }, []);

  /** Jump to a release or month, clearing filters first when they hide it. */
  const jump = (ev: React.MouseEvent, id: string, entryId?: string) => {
    ev.preventDefault();
    if (entryId && entryId !== spotlight?.id) setExpanded((s) => new Set(s).add(entryId));
    if (document.getElementById(id)) scrollTo(id);
    else {
      setF(EMPTY);
      setPending(id);
    }
  };

  useEffect(() => {
    if (!pending) return;
    const t = requestAnimationFrame(() => {
      scrollTo(pending);
      setPending(null);
    });
    return () => cancelAnimationFrame(t);
  }, [pending, scrollTo]);

  /* Old anchors (/changelog#entry-id) open that release's details. */
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id || !entries.some((e) => e.id === id) || id === entries[0]?.id) return;
    setExpanded((s) => new Set(s).add(id));
    setPending(id);
  }, [entries]);

  /* The sticky bar's height feeds the month headers' sticky offset and anchor scroll margins. */
  useEffect(() => {
    const bar = barRef.current, root = rootRef.current;
    if (!bar || !root) return;
    const ro = new ResizeObserver(() => root.style.setProperty("--dxc-bar-h", `${Math.round(bar.getBoundingClientRect().height)}px`));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  /* Border under the bar once it's stuck. */
  useEffect(() => {
    const s = sentinelRef.current;
    if (!s) return;
    const header = parseInt(getComputedStyle(s).getPropertyValue("--dx-header-h"), 10) || 61;
    const io = new IntersectionObserver(([en]) => setStuck(!en.isIntersecting), { rootMargin: `-${header + 1}px 0px 0px 0px` });
    io.observe(s);
    return () => io.disconnect();
  }, []);

  /* Scroll-spy for the rail. */
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const root = rootRef.current;
      if (!root) return;
      const offset = (parseInt(getComputedStyle(root).getPropertyValue("--dx-header-h"), 10) || 61) + (barRef.current?.offsetHeight ?? 60) + 40;
      let cur: string | null = null;
      root.querySelectorAll<HTMLElement>("[data-month]").forEach((s) => {
        if (s.getBoundingClientRect().top <= offset) cur = s.dataset.month ?? null;
      });
      setActiveMonth(cur);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [shown.length, f]);

  const countText = filtering ? `${shown.length} of ${entries.length} releases` : `${entries.length} releases`;
  const panel = (
    <FilterPanel
      f={f}
      set={set}
      areas={areas}
      products={products}
      versions={versions.map((v) => v.version)}
      versionProduct={versionProduct}
      count={shown.length}
      onDone={() => setPanelOpen(false)}
    />
  );
  const filtersTrigger = (
    <Button variant="secondary" size="sm" iconLeft="filter" className={cx("dxc-filterbtn", panelCount > 0 && "dxc-filterbtn--on")} onClick={phone ? () => setPanelOpen(true) : undefined}>
      Filters
      {panelCount > 0 && <span className="dxc-filterbtn__n">{panelCount}</span>}
    </Button>
  );

  const chips: Array<{ key: string; label: React.ReactNode; name: string; remove: () => void }> = [
    ...(terms.length ? [{ key: "q", label: <>“{f.q.trim()}”</>, name: `search ${f.q.trim()}`, remove: () => set({ q: "" }) }] : []),
    ...f.areas.map((a) => ({ key: `a-${a}`, label: a, name: `area ${a}`, remove: () => set({ areas: f.areas.filter((x) => x !== a) }) })),
    ...f.products.map((p) => ({ key: `p-${p}`, label: products.find(([id]) => id === p)?.[1] ?? p, name: `product ${p}`, remove: () => set({ products: f.products.filter((x) => x !== p) }) })),
    ...(f.since && versionProduct ? [{ key: "since", label: `Since ${versionProduct.label} ${f.since}`, name: `since ${versionProduct.label} ${f.since}`, remove: () => set({ since: "" }) }] : []),
  ];

  return (
    <div className="dxc" ref={rootRef}>
      <aside className="dxc-rail" aria-label="Jump to">
        {railMonths.length > 0 && <p className="dxc-rail__h">Jump to</p>}
        <ul className="dxc-rail__list">
          {railMonths.map((m) => {
            const target = monthTarget(m.key);
            return (
              <li key={m.key}>
                <a href={`#${target}`} aria-current={activeMonth === m.key || (!activeMonth && m === railMonths[0]) ? "location" : undefined} onClick={(ev) => jump(ev, target)}>
                  <span>{m.month}</span>
                  <span className="dxc-rail__n">{m.n}</span>
                </a>
              </li>
            );
          })}
        </ul>
        {versionProduct && versions.length > 0 && (
          <>
            <p className="dxc-rail__h">{versionProduct.label} versions</p>
            <ul className="dxc-rail__list dxc-rail__list--ver">
              {versions.map((v) => (
                <li key={v.version}>
                  <a href={`#${v.id}`} onClick={(ev) => jump(ev, v.id, v.id)}>
                    <span className="dxc-rail__ver">{v.version}</span>
                    <span className="dxc-rail__n">{v.dateLabel}</span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
        <a href="/changelog.rss" className="dxc-rail__rss">
          <Icon name="wave" />
          RSS feed
        </a>
      </aside>

      <div className="dxc-main">
        <header className="dxc-hero">
          <div className="dxc-hero__top">
            <p className="dxc-hero__eyebrow">
              <span>Changelog</span>
              {entries[0] && (
                <span className="dxc-hero__updated">
                  Updated <time dateTime={entries[0].date}>{entries[0].dateLabel}</time>
                </span>
              )}
            </p>
            <SubscribeMenu siteUrl={siteUrl} />
          </div>
          <h1 className="dxc-hero__title">{title}</h1>
          {description && <p className="dxc-hero__sub">{description}</p>}
          {unread > 0 && (
            <p className="dxc-unread">
              <span className="dxc-new__dot" aria-hidden />
              {unread === 1 ? "1 release since your last visit" : `${unread} releases since your last visit`}
            </p>
          )}
          <div className="dxc-search">
            <Input
              type="search"
              size="md"
              prefix="search"
              value={f.q}
              onChange={(e) => set({ q: e.target.value })}
              placeholder="Search releases"
              aria-label="Search releases"
              wrapClassName="dxc-search__wrap"
              enterKeyHint="search"
            />
          </div>
        </header>

        <div ref={sentinelRef} className="dxc-sentinel" aria-hidden />
        <div ref={barRef} className={cx("dxc-bar", stuck && "dxc-bar--stuck")}>
          <div className="dxc-bar__row">
            <SegmentedControl<KindFilter>
              aria-label="Kind of change"
              size="sm"
              className="dxc-seg"
              value={f.kind}
              onChange={(kind) => set({ kind })}
              options={(["all", "new", "improved", "fixed"] as const).map((k) => ({
                value: k,
                label: (
                  <>
                    {k === "all" ? "All" : KIND[k].label}
                    <span className="dxc-seg__n">{kindCount(k)}</span>
                  </>
                ),
              }))}
            />
            {phone ? (
              filtersTrigger
            ) : (
              <Popover trigger={filtersTrigger} open={panelOpen} onOpenChange={setPanelOpen} placement="bottom-start" title="Filters" width={380} panelClassName="dxc-pop">
                {panel}
              </Popover>
            )}
            <p className="dxc-count" role="status" aria-live="polite">
              {countText}
            </p>
          </div>
          {chips.length > 0 && (
            <div className="dxc-bar__chips">
              <ul className="dxc-active" aria-label="Active filters">
                {chips.map((c) => (
                  <li key={c.key}>
                    <button type="button" className="dxc-achip" onClick={c.remove} aria-label={`Remove filter: ${c.name}`}>
                      {c.label}
                      <Icon name="x" />
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="dxc-clear" onClick={() => setF(EMPTY)}>
                Clear all
              </button>
            </div>
          )}
        </div>
        {phone && (
          <Drawer open={panelOpen} onClose={() => setPanelOpen(false)} title="Filters" side="bottom" bodyClassName="dxc-sheet">
            {panel}
          </Drawer>
        )}

        {spotlight && <Spotlight e={spotlight} media={media[spotlight.id]} siteUrl={siteUrl} unread={isUnread(spotlight)} />}

        {!filtering && next.length > 0 && (
          <section className="dxc-next" aria-labelledby="dxc-next-h">
            <h2 id="dxc-next-h" className="dxc-next__h">
              <Icon name="clock" />
              Coming next
            </h2>
            <ul className="dxc-next__list">
              {next.map((n) => (
                <li key={n.title}>
                  <span className="dxc-next__title">{n.title}</span>
                  {n.area && <span className="dxc-next__area">{n.area}</span>}
                  {n.body && <InlineCode className="dxc-next__body" text={n.body} />}
                </li>
              ))}
            </ul>
          </section>
        )}

        {!shown.length ? (
          <EmptyState
            icon="search"
            className="dxc-empty"
            title="No releases match"
            description={terms.length ? `Nothing in the changelog mentions “${f.q.trim()}” with these filters.` : "Try another kind, area or product."}
            actions={
              <Button variant="secondary" size="sm" onClick={() => setF(EMPTY)}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="dxc-timeline">
            {spotlight && months.length > 0 && <p className="dxc-timeline__h">Earlier releases</p>}
            {months.map((m) => (
              <section key={m.key} id={`m-${m.key}`} data-month={m.key} className="dxc-month" aria-labelledby={`m-${m.key}-h`}>
                <h2 id={`m-${m.key}-h`} className="dxc-month__head">
                  <span>{m.month}</span>
                  <span className="dxc-month__n">{m.items.length === 1 ? "1 release" : `${m.items.length} releases`}</span>
                </h2>
                <ol className="dxc-list">
                  {m.items.map((e) => (
                    <ReleaseCard
                      key={e.id}
                      e={e}
                      body={bodies[e.id]}
                      media={media[e.id]}
                      siteUrl={siteUrl}
                      unread={isUnread(e)}
                      open={expanded.has(e.id)}
                      onToggle={() => toggleOpen(e.id)}
                    />
                  ))}
                </ol>
              </section>
            ))}
            <p className="dxc-end">
              <Icon name="flag" />
              {filtering ? "End of the matching releases." : `That’s every release since ${entries[entries.length - 1]?.month ?? "the start"}.`}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
