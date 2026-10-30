"use client";

/**
 * The release hub's interactive list: filters (area, kind, product), "Since your version", and
 * "New to you" from the reader's last visit. Entries arrive pre-rendered where they need the
 * server (media); everything else is plain data.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Button, CopyButton, Icon, Select, cx } from "@/components/ui";
import type { ChangeKind } from "../types";
import { useChangelogLastVisit } from "./state";
import { InlineCode } from "../ui/InlineCode";

export interface HubEntry {
  id: string;
  date: string;
  dateLabel: string;
  month: string;
  title: string;
  kind: ChangeKind;
  area: string;
  products: Array<{ id: string; label: string }>;
  versions: Array<{ product: string; label: string; version: string }>;
  summary: string;
  highlights: string[];
  docs: Array<{ path: string; title: string }>;
  try?: { label: string; href: string };
}

const KIND_LABEL: Record<ChangeKind, string> = { new: "New", improved: "Improved", fixed: "Fixed" };
const KIND_TONE: Record<ChangeKind, "info" | "success" | "neutral"> = { new: "info", improved: "success", fixed: "neutral" };

function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function KindBadge({ kind }: { kind: ChangeKind }) {
  return (
    <Badge tone={KIND_TONE[kind]} size="sm" upper>
      {KIND_LABEL[kind]}
    </Badge>
  );
}

export function EntryMeta({ e }: { e: HubEntry }) {
  return (
    <div className="dx-entry__badges">
      <KindBadge kind={e.kind} />
      <Badge size="sm">{e.area}</Badge>
      {e.products.map((p) => (
        <Badge key={p.id} size="sm" variant="outline">
          {p.label}
        </Badge>
      ))}
      {e.versions.map((v) => (
        <Badge key={v.product} size="sm" icon="code">
          {v.label} {v.version}
        </Badge>
      ))}
    </div>
  );
}

export function EntryFooter({ e, siteUrl }: { e: HubEntry; siteUrl: string }) {
  return (
    <>
      {e.highlights.length > 0 && (
        <ul className="dx-entry__highlights">
          {e.highlights.map((h) => (
            <li key={h}>
              <Icon name="check" />
              <InlineCode text={h} />
            </li>
          ))}
        </ul>
      )}
      <div className="dx-entry__actions">
        {e.try && (
          <Button href={e.try.href} size="sm" variant="secondary" iconRight={/^https?:/.test(e.try.href) ? "external" : "arrowRight"} target={/^https?:/.test(e.try.href) ? "_blank" : undefined}>
            {e.try.label}
          </Button>
        )}
        <CopyButton text={`${siteUrl}/changelog/${e.id}`} label="Copy link" size="sm" variant="ghost" announceText="Link copied" />
      </div>
      {e.docs.length > 0 && (
        <div className="dx-entry__docs">
          <span className="dx-entry__docslabel">Docs updated:</span>
          {e.docs.map((d) => (
            <Link key={d.path} href={d.path} className="dx-pill">
              {d.title}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function ChangelogHub({ entries, media, siteUrl, versionProduct }: { entries: HubEntry[]; media: Record<string, React.ReactNode>; siteUrl: string; versionProduct?: { id: string; label: string } }) {
  const [area, setArea] = useState("All");
  const [kind, setKind] = useState("all");
  const [product, setProduct] = useState("all");
  const [since, setSince] = useState("");
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const lastVisit = useChangelogLastVisit(today);

  const areas = useMemo(() => {
    const count = new Map<string, number>();
    entries.forEach((e) => count.set(e.area, (count.get(e.area) ?? 0) + 1));
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  }, [entries]);
  const products = useMemo(() => {
    const m = new Map<string, string>();
    entries.forEach((e) => e.products.forEach((p) => m.set(p.id, p.label)));
    return [...m.entries()];
  }, [entries]);
  const versions = useMemo(() => {
    if (!versionProduct) return [];
    const m = new Map<string, string>();
    for (const e of entries) {
      const v = e.versions.find((x) => x.product === versionProduct.id)?.version;
      if (v && (!m.has(v) || e.date < m.get(v)!)) m.set(v, e.date);
    }
    return [...m.entries()].sort((a, b) => cmpVersion(b[0], a[0]));
  }, [entries, versionProduct]);

  const sinceDate = versions.find(([v]) => v === since)?.[1];
  const shown = entries.filter((e) => {
    if (area !== "All" && e.area !== area) return false;
    if (kind !== "all" && e.kind !== kind) return false;
    if (product !== "all" && !e.products.some((p) => p.id === product)) return false;
    if (since && versionProduct) {
      const need = e.versions.find((x) => x.product === versionProduct.id)?.version;
      if (need) return cmpVersion(need, since) > 0;
      return !!sinceDate && e.date > sinceDate;
    }
    return true;
  });
  const unread = lastVisit ? entries.filter((e) => e.date > lastVisit).length : 0;

  const months: Array<{ month: string; items: HubEntry[] }> = [];
  for (const e of shown) {
    const last = months[months.length - 1];
    if (last && last.month === e.month) last.items.push(e);
    else months.push({ month: e.month, items: [e] });
  }

  return (
    <div className="dx-hub">
      {unread > 0 && (
        <div className="dx-hub__unread">
          <Badge tone="info" icon="bulb">
            {unread === 1 ? "1 update since your last visit" : `${unread} updates since your last visit`}
          </Badge>
        </div>
      )}
      <div className="dx-hub__filters">
        <div role="radiogroup" aria-label="Area" className="dx-chips">
          {["All", ...areas].map((a) => (
            <button key={a} type="button" role="radio" aria-checked={a === area} className="dx-chip dx-chip--filter" data-on={a === area ? "" : undefined} onClick={() => setArea(a)}>
              {a}
            </button>
          ))}
        </div>
        <div className="dx-hub__selects">
          <label className="dx-hub__select">
            <span>Kind</span>
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              options={[{ value: "all", label: "All kinds" }, ...(["new", "improved", "fixed"] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))]}
            />
          </label>
          {products.length > 1 && (
            <label className="dx-hub__select">
              <span>Product</span>
              <Select value={product} onChange={(e) => setProduct(e.target.value)} options={[{ value: "all", label: "All products" }, ...products.map(([id, label]) => ({ value: id, label }))]} />
            </label>
          )}
          {versionProduct && versions.length > 0 && (
            <label className="dx-hub__select">
              <span>Since your version</span>
              <Select
                value={since}
                onChange={(e) => setSince(e.target.value)}
                options={[{ value: "", label: `Any ${versionProduct.label} version` }, ...versions.map(([v]) => ({ value: v, label: `${versionProduct.label} ${v}` }))]}
              />
            </label>
          )}
        </div>
        {since && versionProduct && (
          <p className="dx-hub__sincenote">
            Changes that need a newer {versionProduct.label} than {since}, plus everything else released after {versionProduct.label} {since}.
          </p>
        )}
      </div>

      {!shown.length && <p className="dx-hub__empty">Nothing matches these filters.</p>}
      {months.map((m) => (
        <section key={m.month} className="dx-month" aria-labelledby={`m-${m.month.replace(/\s/g, "-")}`}>
          <h2 id={`m-${m.month.replace(/\s/g, "-")}`} className="dx-month__title">
            {m.month}
          </h2>
          <ol className="dx-timeline">
            {m.items.map((e) => (
              <li key={e.id} className={cx("dx-entry", lastVisit && e.date > lastVisit && "dx-entry--unread")} id={e.id}>
                <div className="dx-entry__when">
                  <time dateTime={e.date}>{e.dateLabel}</time>
                  {lastVisit && e.date > lastVisit && (
                    <Badge tone="info" size="sm" dot>
                      New to you
                    </Badge>
                  )}
                </div>
                <div className="dx-entry__main">
                  <h3 className="dx-entry__title">
                    <Link href={`/changelog/${e.id}`}>{e.title}</Link>
                  </h3>
                  <EntryMeta e={e} />
                  <p className="dx-entry__summary"><InlineCode text={e.summary} /></p>
                  {media[e.id]}
                  <EntryFooter e={e} siteUrl={siteUrl} />
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
