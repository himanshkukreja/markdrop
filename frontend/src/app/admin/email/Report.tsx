"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Disclosure, EmptyState, Input, SegmentedControl, Tooltip, useToast } from "@/components/ui";
import { StatTile } from "@/components/kit/StatTile";
import { TrendChart } from "../analytics/charts";
import { LoadingBlock, isUnauthorized, useOnUnauthorized } from "../shared";
import { emailApi, type CampaignSummary, type MessageRow, type RecipientFilter, type Report as ReportData } from "./api";
import { MessageBadge, Section, TimeAgo, exact, num, pct, saveBlob, useDebounced, usePoll } from "./bits";

const FILTERS: { value: RecipientFilter; label: string }[] = [
  { value: "all", label: "All" }, { value: "opened", label: "Opened" }, { value: "unopened", label: "Unopened" },
  { value: "clicked", label: "Clicked" }, { value: "failed", label: "Failed" }, { value: "skipped", label: "Skipped" },
  { value: "queued", label: "Queued" }, { value: "unsubscribed", label: "Unsubscribed" }, { value: "bounced", label: "Bounced" },
];
const PAGE = 50;

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname === "/" ? "" : x.pathname}`;
  } catch {
    return u;
  }
}

function Funnel({ c, webhooks }: { c: CampaignSummary["counts"]; webhooks: boolean }) {
  const rows = [
    { label: "Queued", n: c.total, of: c.total, base: "of all", accent: false },
    { label: "Sent", n: c.sent, of: c.total, base: "of queued", accent: false },
    ...(webhooks ? [{ label: "Delivered", n: c.delivered, of: c.sent, base: "of sent", accent: false }] : []),
    { label: "Opened", n: c.opened, of: c.sent, base: "of sent", accent: true },
    { label: "Clicked", n: c.clicked, of: c.sent, base: "of sent", accent: true },
  ];
  return (
    <ul className="flex flex-col gap-2.5" aria-label="Delivery funnel">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-3">
          <span className="text-caption text-text-secondary">{r.label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-surface-inset" aria-hidden>
            <span className={`block h-full rounded-full ${r.accent ? "bg-accent" : "bg-border-strong"}`}
              style={{ width: `${c.total ? Math.max(1, (r.n / c.total) * 100) : 0}%` }} />
          </span>
          <span className="whitespace-nowrap text-right text-caption tabular-nums text-text">
            {num(r.n)} <span className="text-text-muted">· {r.label === "Queued" ? "100%" : pct(r.n, r.of)}</span>
            <span className="md-visually-hidden"> {r.base}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Recipients({ token, campaign, live }: { token: string; campaign: CampaignSummary; live: boolean }) {
  const toast = useToast();
  const onUnauthorized = useOnUnauthorized();
  const [filter, setFilter] = useState<RecipientFilter>("all");
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 300);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: MessageRow[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await emailApi.messages(token, campaign.id, { filter, q: dq, offset, limit: PAGE });
      setData({ rows: r.rows, total: r.total });
      setError(null);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(e instanceof Error ? e.message : "Couldn't load");
    }
  }, [token, campaign.id, filter, dq, offset, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setOffset(0); }, [filter, dq]);
  usePoll(load, live ? 10_000 : 30_000, true);

  const total = data?.total ?? 0;
  return (
    <Section
      id="email-recipients"
      label="Recipients"
      title={filter === "all" ? `${num(campaign.counts.total)} recipients` : `${num(total)} ${FILTERS.find((f) => f.value === filter)?.label.toLowerCase()}`}
      actions={
        <Button size="sm" variant="secondary" iconLeft="download" loading={exporting} onClick={async () => {
          setExporting(true);
          try {
            const r = await emailApi.csv(token, campaign.id, filter, dq);
            saveBlob(r.blob, r.filename);
          } catch (e) {
            if (isUnauthorized(e)) onUnauthorized();
            else toast.error("Couldn't export the CSV");
          } finally { setExporting(false); }
        }}>CSV</Button>
      }
      bodyClassName="flex flex-col gap-3"
    >
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <SegmentedControl<RecipientFilter> size="sm" aria-label="Filter recipients" value={filter} onChange={setFilter} options={FILTERS} />
      </div>
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email or name" aria-label="Search recipients" prefix="search" wrapClassName="max-w-md" />
      {error ? <Alert tone="danger">{error}</Alert> : !data ? <LoadingBlock label="Loading recipients" minHeight={160} /> : data.rows.length === 0 ? (
        <EmptyState icon="users" title="Nobody matches this filter" className="py-6" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] text-caption">
            <caption className="md-visually-hidden">Recipients</caption>
            <thead className="bg-surface-inset text-text-secondary">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">Recipient</th>
                <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
                <th scope="col" className="px-3 py-2 text-left font-medium max-sm:hidden">Sent</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Opens</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Clicks</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((m) => (
                <tr key={m.id} className="border-t border-border align-top">
                  <td className="max-w-[16rem] px-3 py-2">
                    <span className="block truncate text-text">{m.email}</span>
                    {m.name && <span className="block truncate text-micro text-text-secondary">{m.name}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex flex-col items-start gap-1">
                      <MessageBadge status={m.display_status} />
                      {m.unsubscribed_at && <Badge size="sm" tone="warning" variant="outline">Unsubscribed</Badge>}
                      {m.error && (
                        <Tooltip content={m.error}>
                          <span tabIndex={0} className="md-focus block max-w-[14rem] truncate rounded-sm font-mono text-micro text-text-secondary">{m.error}</span>
                        </Tooltip>
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-text-secondary max-sm:hidden">{m.sent_at ? <time dateTime={m.sent_at} title={exact(m.sent_at)}>{new Date(m.sent_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time> : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums" title={m.first_open_at ? `First ${exact(m.first_open_at)}${m.last_open_at ? ` · last ${exact(m.last_open_at)}` : ""}` : undefined}>
                    <span className="text-text">{m.open_count || (m.first_open_at ? "✓" : "—")}</span>
                    {m.last_open_at && <span className="block text-micro text-text-muted"><TimeAgo iso={m.last_open_at} /></span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums" title={m.first_click_at ? `First ${exact(m.first_click_at)}` : undefined}>
                    <span className="text-text">{m.click_count || "—"}</span>
                    {m.last_click_at && <span className="block text-micro text-text-muted"><TimeAgo iso={m.last_click_at} /></span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && total > PAGE && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption tabular-nums text-text-secondary">{num(offset + 1)}–{num(Math.min(offset + PAGE, total))} of {num(total)}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" iconLeft="chevronLeft" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>Previous</Button>
            <Button size="sm" variant="secondary" iconRight="chevronRight" disabled={offset + PAGE >= total} onClick={() => setOffset((o) => o + PAGE)}>Next</Button>
          </div>
        </div>
      )}
    </Section>
  );
}

export default function Report({ token, campaign }: { token: string; campaign: CampaignSummary }) {
  const onUnauthorized = useOnUnauthorized();
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<"opens" | "clicks">("opens");
  const live = campaign.status === "sending";

  const load = useCallback(async () => {
    try {
      setData(await emailApi.report(token, campaign.id));
      setError(null);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(e instanceof Error ? e.message : "Couldn't load the report");
    }
  }, [token, campaign.id, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);
  usePoll(load, live ? 5000 : 15_000, true);

  if (error && !data) {
    return <Alert tone="danger" title="Couldn't load the report" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Retry</Button>}>{error}</Alert>;
  }
  const c = data?.counts ?? campaign.counts;
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const webhooks = !!data?.webhooks;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 ${webhooks ? "xl:grid-cols-4" : "xl:grid-cols-6"}`}>
        <StatTile size="md" label="Sent" value={num(c.sent)} caption={`of ${num(c.total)} queued`} />
        <StatTile size="md" label="Failed" value={num(c.failed)} caption={c.skipped ? `${num(c.skipped)} skipped` : "rejected at send"} />
        <StatTile size="md" label="Opened · unique" value={pct(c.opened, c.sent)} caption={`${num(c.opened)} people · ${num(c.opens)} opens`} />
        <StatTile size="md" label="Clicked · unique" value={pct(c.clicked, c.sent)} caption={`${num(c.clicked)} people · ${num(c.clicks)} clicks`} />
        <StatTile size="md" label="Click-to-open" value={pct(c.clicked, c.opened)} caption="of openers" />
        <StatTile size="md" label="Unsubscribed" value={num(c.unsubscribed)} caption={pct(c.unsubscribed, c.sent)} />
        {webhooks && (
          <>
            <StatTile size="md" label="Delivered" value={pct(c.delivered, c.sent)} caption={`${num(c.delivered)} confirmed by Resend`} />
            <StatTile size="md" label="Bounced · complaints" value={`${num(c.bounced)} · ${num(c.complained)}`} caption="auto-suppressed" />
          </>
        )}
      </div>
      {!webhooks && data && (
        <Alert tone="neutral" title="No delivery data yet">
          Delivered, bounced and complained counts need the Resend webhook (Email → Senders shows the URL and secret to set). Sends,
          opens, clicks and unsubscribes are tracked already.
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Section id="email-funnel" label="Funnel" title={webhooks ? "Queued → sent → delivered → opened → clicked" : "Queued → sent → opened → clicked"}>
          <Funnel c={c} webhooks={webhooks} />
          <Disclosure summary="How accurate are opens?" className="mt-4">
            <p className="text-caption text-text-secondary">
              Opens come from a 1×1 image. Apple Mail Privacy Protection loads images for every message, so Apple Mail users can show as
              opened without reading (over-counted), while people whose client blocks images never trigger it (under-counted). A click
              also counts as an open. Corporate link scanners can occasionally pre-click links. Clicks are the reliable signal.
            </p>
          </Disclosure>
        </Section>
        <Section id="email-timeline" label="Over time" title={series === "opens" ? "First opens" : "First clicks"}
          actions={<SegmentedControl<"opens" | "clicks"> size="sm" aria-label="Series" value={series} onChange={setSeries}
            options={[{ value: "opens", label: "Opens" }, { value: "clicks", label: "Clicks" }]} />}>
          {!data ? <LoadingBlock label="Loading activity over time" minHeight={220} /> : data.timeline.points.length < 2 ? (
            <EmptyState icon="chart" title="Not enough time yet" description="The chart fills in as people open and click." className="py-6" />
          ) : (
            <TrendChart
              points={data.timeline.points.map((p) => ({ t: p.t, v: series === "opens" ? p.opens : p.clicks }))}
              unit={data.timeline.unit}
              tz={tz}
              label={series === "opens" ? "People opening for the first time" : "People clicking for the first time"}
            />
          )}
        </Section>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section id="email-links" label="Links" title="Clicks per link">
          {!data ? <LoadingBlock label="Loading link clicks" minHeight={120} /> : data.links.length === 0 ? (
            <EmptyState icon="link" title="No clicks yet" className="py-6" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-caption">
                <caption className="md-visually-hidden">Clicks per link</caption>
                <thead className="bg-surface-inset text-text-secondary">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">Link</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">People</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Clicks</th>
                  </tr>
                </thead>
                <tbody>
                  {data.links.map((l) => (
                    <tr key={l.url} className="border-t border-border">
                      <td className="max-w-[18rem] px-3 py-2"><span className="block truncate font-mono text-text" title={l.url}>{shortUrl(l.url)}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums text-text">{num(l.people)} <span className="text-text-muted">· {pct(l.people, c.sent)}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums text-text">{num(l.clicks)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section id="email-activity" label="Activity" title="Latest opens, clicks and unsubscribes">
          {!data ? <LoadingBlock label="Loading activity" minHeight={120} /> : data.events.length === 0 ? (
            <EmptyState icon="inbox" title="Nothing yet" description="Opens and clicks appear here as they happen." className="py-6" />
          ) : (
            <ul className="md-focus flex max-h-85 flex-col overflow-y-auto rounded-sm" tabIndex={0} aria-label="Latest activity">
              {data.events.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex min-w-0 items-center gap-3 border-b border-border py-2 last:border-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-caption text-text">{e.email ?? "—"}</span>
                    <span className="block truncate font-mono text-micro text-text-secondary">{e.url ? shortUrl(e.url) : e.type}</span>
                  </span>
                  <Badge size="sm" tone={e.type === "click" ? "success" : e.type === "open" ? "info" : e.type === "unsubscribe" ? "warning" : e.type === "delivered" ? "neutral" : "danger"}>
                    {e.type === "click" ? "Clicked" : e.type === "open" ? "Opened" : e.type === "unsubscribe" ? "Unsubscribed" : e.type === "bounce" ? "Bounced" : e.type === "complaint" ? "Complaint" : e.type}
                  </Badge>
                  <TimeAgo iso={e.at} className="text-micro text-text-muted" />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Recipients token={token} campaign={campaign} live={live} />
    </div>
  );
}
