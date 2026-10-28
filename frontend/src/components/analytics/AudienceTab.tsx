"use client";

/**
 * Audience tab (Audience board): new and returning, devices, countries (k-anonymous), channels,
 * share signals (link-preview fetches), campaigns (utm_ tags), and the "Hide views from {Workspace}
 * members" switch when the document is filed in a workspace.
 */
import { Badge, Switch } from "@/components/ui";
import { getAudience, type AnalyticsRange, type Overview } from "@/lib/analytics";
import { BarList } from "./charts";
import { channelLabel, countryName, day, deviceLabel, engagedWord, num, pct } from "./format";
import { LoadError, Panel, PanelSkeleton, Quiet, useLoad } from "./parts";

function Row({ label, extra, value, mono }: { label: React.ReactNode; extra?: React.ReactNode; value: string; mono?: boolean }) {
  return (
    <li className="flex items-center gap-2.5 text-[13px]">
      <span className={mono ? "min-w-0 flex-1 truncate font-mono text-caption text-text" : "min-w-0 flex-1 truncate text-text"}>{label}</span>
      {extra && <span className="shrink-0 text-caption text-text-muted">{extra}</span>}
      <strong className="w-11 shrink-0 text-right font-semibold tabular-nums text-text">{value}</strong>
    </li>
  );
}

export function InternalSwitch({ name, internal, onChange }: { name: string; internal: boolean; onChange: (v: boolean) => void }) {
  return <Switch label={`Hide views from ${name} members`} checked={!internal} onChange={(e) => onChange(!e.target.checked)} />;
}

export default function AudienceTab({ slug, ov, range, internal, onInternal }: {
  slug: string; ov: Overview; range: AnalyticsRange; internal: boolean; onInternal: (v: boolean) => void;
}) {
  const aud = useLoad(`aud:${slug}:${range}:${internal}`, () => getAudience(slug, { range, internal }));
  const kind = ov.doc.kind;
  const ws = ov.doc.workspace ?? aud.data?.workspace ?? null;
  const word = engagedWord(kind);
  const eng = (v: number | null | undefined) => (v == null || !ov.has_engagement ? undefined : `${pct(v)} ${word}`);

  const header = ws ? (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {!internal && (aud.data?.internal_hidden ?? 0) > 0 && (
        <span className="text-caption text-text-muted">{num(aud.data!.internal_hidden)} views from {ws.name} members hidden</span>
      )}
      <InternalSwitch name={ws.name} internal={internal} onChange={onInternal} />
    </div>
  ) : null;

  if (aud.error) return <div className="flex flex-col gap-4">{header}<LoadError error={aud.error} retry={aud.retry} /></div>;
  const a = aud.data;
  if (!a) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
          {Array.from({ length: 4 }, (_, i) => <PanelSkeleton key={i} height={120} />)}
        </div>
      </div>
    );
  }

  const total = a.new + a.returning;
  const newPct = total ? (a.new / total) * 100 : 0;
  const phone = a.devices.find((d) => d.device === "Mobile" || d.device === "Phone");
  const desk = a.devices.find((d) => d.device === "Desktop");
  let deviceNote: string | null = null;
  if (ov.has_engagement && phone?.engaged_pct && desk?.engaged_pct && phone.pct >= 10) {
    const r = desk.engaged_pct / phone.engaged_pct;
    if (r >= 1.5) deviceNote = `Phone ${kind === "doc" || kind === "pdf" ? "readers" : "viewers"} finish ${r.toFixed(r >= 2.95 ? 0 : 1).replace(/\.0$/, "")}× less often than desktop.`;
    else if (r <= 1 / 1.5) deviceNote = `Phone ${kind === "doc" || kind === "pdf" ? "readers" : "viewers"} finish more often than desktop.`;
  }

  return (
    <div className="flex flex-col gap-4">
      {header}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
        <Panel id="au-nr" title="New and returning">
          {total ? (
            <>
              <div className="flex h-3.5 gap-0.5" role="img" aria-label={`${Math.round(newPct)}% new, ${100 - Math.round(newPct)}% returning`}>
                <span className="rounded-l-[3px] bg-(--chart-1)" style={{ flex: Math.max(1, a.new) }} />
                <span className="rounded-r-[3px]" style={{ flex: Math.max(a.returning ? 1 : 0, a.returning), background: "color-mix(in srgb, var(--chart-1) 45%, transparent)" }} />
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-text">
                <span><strong className="font-bold tabular-nums">{num(a.new)}</strong> new · {pct(newPct)}</span>
                <span><strong className="font-bold tabular-nums">{num(a.returning)}</strong> came back · {pct(100 - newPct)}</span>
              </div>
              {a.returning_ratio_note && <Quiet>{a.returning_ratio_note}</Quiet>}
            </>
          ) : <Quiet>No viewers in this period.</Quiet>}
        </Panel>

        <Panel id="au-dev" title="Devices">
          {a.devices.length
            ? <BarList labelWidth={64} rows={a.devices.map((d) => ({ key: d.device, label: deviceLabel(d.device), value: d.pct, display: pct(d.pct) }))} />
            : <Quiet>No device data yet.</Quiet>}
          {deviceNote && <Quiet>{deviceNote}</Quiet>}
        </Panel>

        <Panel id="au-geo" title="Countries">
          {a.countries.length ? (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {a.countries.map((c) => <Row key={c.country} label={c.country === "Other" ? "Other" : countryName(c.country)} extra={eng(c.engaged_pct)} value={num(c.people)} />)}
            </ul>
          ) : <Quiet>No location data yet.</Quiet>}
          <Quiet>Places with fewer than 5 viewers are grouped as Other.</Quiet>
        </Panel>

        <Panel id="au-ch" title="Channels">
          {a.channels.length ? (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {a.channels.map((c) => <Row key={c.channel} label={channelLabel(c.channel)} extra={eng(c.engaged_pct)} value={num(c.views)} />)}
            </ul>
          ) : <Quiet>No views in this period.</Quiet>}
        </Panel>

        <Panel id="au-sig" title={<>Share signals <Badge tone="info" size="sm" upper>New</Badge></>}>
          <p className="m-0 text-[13px] text-text-secondary">Times an app showed a preview of your link, which usually means someone shared it there.</p>
          {a.signals.length ? (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {a.signals.map((s) => <Row key={s.platform} label={s.platform} extra={s.last ? `last ${day(s.last)}` : undefined} value={num(s.n)} />)}
            </ul>
          ) : <Quiet>No previews in this period.</Quiet>}
          <p className="m-0 text-micro text-text-muted">Approximate: apps cache previews. No people are tracked.</p>
        </Panel>

        <Panel id="au-utm" title="Campaigns">
          {a.campaigns.length ? (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {a.campaigns.map((c, i) => {
                const tag = [c.source, c.medium, c.campaign].filter(Boolean).join(" / ") || "Untagged";
                return <Row key={`${tag}-${i}`} mono label={tag} extra={eng(c.engaged_pct)} value={num(c.people)} />;
              })}
            </ul>
          ) : <Quiet>No tagged visits in this period.</Quiet>}
          <Quiet>From <code className="font-mono">utm_</code> tags on your links.</Quiet>
        </Panel>
      </div>
    </div>
  );
}
