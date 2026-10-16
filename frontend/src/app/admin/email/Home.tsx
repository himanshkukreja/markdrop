"use client";

import { useMemo, useState } from "react";
import { Alert, Button, EmptyState, Icon, Tabs, cx } from "@/components/ui";
import { StatTile } from "@/components/kit/StatTile";
import { LoadingBlock, PageHead, plural } from "../shared";
import type { CampaignStatus, CampaignSummary, Info, TemplatesResponse } from "./api";
import { CampaignBadge, Section, TimeAgo, num, pct } from "./bits";
import type { Navigate } from "./EmailSection";
import Senders from "./Senders";

type SortKey = "name" | "status" | "sent" | "opened" | "clicked" | "updated";
const STATUS_ORDER: Record<CampaignStatus, number> = { sending: 0, scheduled: 1, paused: 2, draft: 3, sent: 4, cancelled: 5 };

export function ConsoleBanner({ info }: { info: Info | null }) {
  if (!info || info.setup.transport !== "console") return null;
  return (
    <Alert tone="warning" title="Console transport · nothing is emailed" className="mb-4">
      This server has no Resend API key (or <code className="font-mono">MARKDROP_EMAIL_TRANSPORT=console</code>), so every test and
      campaign is rendered and stored in <code className="font-mono">email_outbox</code> instead of being sent. Tracking, reports and
      unsubscribes work as usual.
    </Alert>
  );
}

function campaignHref(id: string) {
  return `/admin?tab=email&campaign=${encodeURIComponent(id)}`;
}

function CampaignLink({ c, navigate }: { c: CampaignSummary; navigate: Navigate }) {
  return (
    <a
      href={campaignHref(c.id)}
      className="md-focus block min-w-0 rounded-sm text-text no-underline hover:underline"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate({ campaign: c.id, ct: null, template: null, et: null });
      }}
    >
      <span className="block truncate text-body-strong">{c.name}</span>
    </a>
  );
}

function SortHeader({ k, label, sort, setSort, align }: {
  k: SortKey; label: string; sort: { key: SortKey; dir: 1 | -1 }; setSort: (s: { key: SortKey; dir: 1 | -1 }) => void; align?: "right";
}) {
  const on = sort.key === k;
  return (
    <button
      type="button"
      className={cx("md-focus inline-flex items-center gap-1 rounded-sm font-medium hover:text-text", align === "right" && "flex-row-reverse", on ? "text-text" : "text-text-secondary")}
      onClick={() => setSort({ key: k, dir: on ? (sort.dir === 1 ? -1 : 1) : k === "name" ? 1 : -1 })}
      aria-label={`Sort by ${label}${on ? `, currently ${sort.dir === 1 ? "ascending" : "descending"}` : ""}`}
    >
      {label}
      <Icon name={on ? (sort.dir === 1 ? "arrowUp" : "arrowDown") : "sort"} size={13} />
    </button>
  );
}

function CampaignsTable({ rows, navigate }: { rows: CampaignSummary[]; navigate: Navigate }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "updated", dir: -1 });
  const sorted = useMemo(() => {
    const val = (c: CampaignSummary): number | string => {
      switch (sort.key) {
        case "name": return c.name.toLowerCase();
        case "status": return STATUS_ORDER[c.status] ?? 9;
        case "sent": return c.counts.sent;
        case "opened": return c.counts.sent ? c.counts.opened / c.counts.sent : -1;
        case "clicked": return c.counts.sent ? c.counts.clicked / c.counts.sent : -1;
        default: return c.updated_at ? new Date(c.updated_at).getTime() : 0;
      }
    };
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, sort]);

  const th = "px-3 py-2.5 text-left text-caption";
  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full min-w-[640px] text-body">
          <caption className="md-visually-hidden">All campaigns</caption>
          <thead className="bg-surface-inset">
            <tr>
              <th scope="col" className={th}><SortHeader k="name" label="Campaign" sort={sort} setSort={setSort} /></th>
              <th scope="col" className={th}><SortHeader k="status" label="Status" sort={sort} setSort={setSort} /></th>
              <th scope="col" className={cx(th, "text-right")}><SortHeader k="sent" label="Sent" sort={sort} setSort={setSort} align="right" /></th>
              <th scope="col" className={cx(th, "text-right")}><SortHeader k="opened" label="Opened" sort={sort} setSort={setSort} align="right" /></th>
              <th scope="col" className={cx(th, "text-right")}><SortHeader k="clicked" label="Clicked" sort={sort} setSort={setSort} align="right" /></th>
              <th scope="col" className={cx(th, "text-right")}><SortHeader k="updated" label="Updated" sort={sort} setSort={setSort} align="right" /></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.id} className="cursor-pointer border-t border-border hover:bg-surface-hover"
                onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) navigate({ campaign: c.id, ct: null, template: null, et: null }); }}>
                <td className="max-w-[22rem] px-3 py-2.5">
                  <CampaignLink c={c} navigate={navigate} />
                  <span className="block truncate text-caption text-text-secondary">{c.subject || "(no subject)"}</span>
                </td>
                <td className="px-3 py-2.5"><CampaignBadge status={c.status} legacy={c.legacy} /></td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-caption tabular-nums text-text">
                  {c.counts.total ? `${num(c.counts.sent)}/${num(c.counts.total)}` : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.legacy ? "—" : pct(c.counts.opened, c.counts.sent)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.legacy ? "—" : pct(c.counts.clicked, c.counts.sent)}</td>
                <td className="px-3 py-2.5 text-right text-caption text-text-secondary"><TimeAgo iso={c.updated_at} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Phone list */}
      <ul className="flex flex-col gap-2 md:hidden" aria-label="All campaigns">
        {sorted.map((c) => (
          <li key={c.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface p-3">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
                <CampaignLink c={c} navigate={navigate} />
                <span className="block truncate text-caption text-text-secondary">{c.subject || "(no subject)"}</span>
              </div>
              <CampaignBadge status={c.status} legacy={c.legacy} />
            </div>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
              <span className="tabular-nums">Sent {c.counts.total ? `${num(c.counts.sent)}/${num(c.counts.total)}` : "—"}</span>
              {!c.legacy && <span className="tabular-nums">Opened {pct(c.counts.opened, c.counts.sent)}</span>}
              {!c.legacy && <span className="tabular-nums">Clicked {pct(c.counts.clicked, c.counts.sent)}</span>}
              <TimeAgo iso={c.updated_at} />
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

function TemplatePicker({ meta, metaError, reloadMeta, navigate }: {
  meta: TemplatesResponse | null; metaError: string | null; reloadMeta: () => void; navigate: Navigate;
}) {
  return (
    <Section id="email-new" label="New campaign" title="Pick a starting point">
      {metaError ? (
        <Alert tone="danger" title="Couldn't load templates" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={reloadMeta}>Retry</Button>}>{metaError}</Alert>
      ) : !meta ? (
        <LoadingBlock label="Loading templates" minHeight={148} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {meta.templates.map((t, i) => (
            <li key={t.id} className="min-w-0">
              <a
                href={`/admin?tab=email&campaign=new&template=${encodeURIComponent(t.id)}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate({ campaign: "new", template: t.id, ct: "compose", et: null });
                }}
                className={cx(
                  "md-focus group flex h-full min-h-37 flex-col gap-1.5 rounded-xl border bg-surface-inset p-4 no-underline transition-colors hover:border-border-strong hover:bg-surface-hover",
                  i === 0 ? "border-accent" : "border-border",
                )}
              >
                <span className="text-eyebrow uppercase text-accent-text">{`0${i + 1} · ${t.kind === "blocks" ? "Blocks" : "Full HTML"}`}</span>
                <span className="text-body-strong text-text">{t.name}</span>
                <span className="text-caption text-text-secondary">{t.description}</span>
                <span className="mt-auto inline-flex items-center gap-1 pt-2 text-caption font-medium text-text-secondary group-hover:text-accent-text">
                  Compose <Icon name="arrowRight" size={14} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default function Home({ token, tab, info, infoError, meta, metaError, reload, reloadMeta, navigate }: {
  token: string; tab: "campaigns" | "senders"; info: Info | null; infoError: string | null;
  meta: TemplatesResponse | null; metaError: string | null; reload: () => void; reloadMeta: () => void; navigate: Navigate;
}) {
  const campaigns = info?.campaigns ?? [];
  const real = campaigns.filter((c) => !c.legacy);
  const totals = real.reduce((a, c) => ({ sent: a.sent + c.counts.sent, opened: a.opened + c.counts.opened, clicked: a.clicked + c.counts.clicked }), { sent: 0, opened: 0, clicked: 0 });
  const legacySent = campaigns.filter((c) => c.legacy).reduce((a, c) => a + c.counts.sent, 0);
  const sendingNow = real.filter((c) => c.status === "sending").length;
  const scheduled = real.filter((c) => c.status === "scheduled").length;

  return (
    <>
      <PageHead
        title="Email campaigns"
        caption="Compose with merge tags, preview as a real account, test, then send in throttled batches and watch deliveries, opens and clicks come in."
        actions={tab === "campaigns" ? (
          <Button iconLeft="plus" onClick={() => document.getElementById("email-new")?.scrollIntoView({ behavior: "smooth", block: "start" })}>New campaign</Button>
        ) : undefined}
      />
      <ConsoleBanner info={info} />
      <Tabs
        className="mb-5"
        aria-label="Email"
        value={tab}
        onChange={(v) => navigate({ et: v === "senders" ? "senders" : null }, { replace: true })}
        items={[
          { value: "campaigns", label: "Campaigns", count: info ? campaigns.length : undefined },
          { value: "senders", label: "Senders", count: info ? info.senders.length : undefined },
        ]}
      />
      {infoError && !info && (
        <Alert tone="danger" title="Couldn't load campaigns" className="mb-4" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={reload}>Retry</Button>}>
          {infoError}
        </Alert>
      )}
      {tab === "senders" ? (
        <Senders token={token} info={info} onChanged={reload} />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile size="md" label="Emails sent" loading={!info} value={num(totals.sent)}
              caption={legacySent ? `all campaigns · +${num(legacySent)} legacy` : "all campaigns"} />
            <StatTile size="md" label="Opened · unique" loading={!info} value={pct(totals.opened, totals.sent)} caption={plural(totals.opened, "person", "people")} />
            <StatTile size="md" label="Clicked · unique" loading={!info} value={pct(totals.clicked, totals.sent)} caption={plural(totals.clicked, "person", "people")} />
            <StatTile size="md" label="Sending now" loading={!info} value={num(sendingNow)} caption={scheduled ? `${scheduled} scheduled` : "campaigns in progress"} />
          </div>
          <Section id="email-all" label="Campaigns" title="All campaigns">
            {!info ? (
              <LoadingBlock label="Loading campaigns" minHeight={168} />
            ) : campaigns.length === 0 ? (
              <EmptyState icon="mail" title="No campaigns yet" description="Start one from a template below." />
            ) : (
              <CampaignsTable rows={campaigns} navigate={navigate} />
            )}
          </Section>
          <TemplatePicker meta={meta} metaError={metaError} reloadMeta={reloadMeta} navigate={navigate} />
        </div>
      )}
    </>
  );
}

