"use client";

/**
 * Video / Listening tab (Video board): retention second by second with drop/hold/rewatch marks,
 * moment cards (frame thumbnails for video), the rewatch/skip strip, the version compare (video,
 * when there is an earlier version), How they watch, and playback quality (video only).
 */
import { useState } from "react";
import { Alert, Badge, EmptyState, Icon, Select } from "@/components/ui";
import { getMedia, getVersions, type AnalyticsRange, type MediaAnalytics, type Overview } from "@/lib/analytics";
import { BarList, CompareChart, HeatStrip, RetentionChart } from "./charts";
import { RANGE_WORDS, clock, countryName, ms, num, pct } from "./format";
import { TrackingNote } from "./OverviewTab";
import { FrameThumb, LoadError, Panel, PanelSkeleton, Quiet, useLoad } from "./parts";

const REASON: Record<string, string> = { network: "network", decode: "couldn't decode", src: "file not supported", expired: "link expired", other: "other" };

function rateLabel(r: string) {
  const n = Number(r);
  return Number.isFinite(n) ? `${n}×` : r;
}

function Qoe({ m }: { m: MediaAnalytics }) {
  const q = m.qoe;
  if (!q) return null;
  const slowPhones = (q.phone_slow_pct ?? 0) >= 20;
  const failing = q.failed_pct >= 2;
  const tiles = [
    { label: "Time to start (typical)", value: ms(q.startup_p50_ms), note: q.startup_p95_ms != null ? `Slowest 5%: ${ms(q.startup_p95_ms)}` : null },
    { label: "Sessions that stalled", value: pct(q.stalled_pct), note: "Waited for the video to load mid-play" },
    {
      label: "Plays that failed", value: pct(q.failed_pct),
      note: q.failed_n ? `${num(q.failed_n)} ${q.failed_n === 1 ? "play" : "plays"}${q.failed_by.length ? ` · ${q.failed_by.map((f) => `${REASON[f.reason] ?? f.reason} (${num(f.n)})`).join(", ")}` : ""}` : "None failed",
    },
    ...(q.phone_slow_pct != null ? [{
      label: "Phone viewers waiting > 5 s", value: pct(q.phone_slow_pct),
      note: q.phone_slow_by.length ? q.phone_slow_by.slice(0, 3).map((c) => `${countryName(c.country)} ${pct(c.pct)}`).join(", ") : null,
    }] : []),
  ];
  return (
    <Panel id="md-qoe" title="Could people actually watch it?"
      headerExtra={failing ? <Badge tone="danger" icon="alertCircle">Plays failing</Badge>
        : slowPhones ? <Badge tone="warning" icon="alert">Slow starts on phones</Badge>
        : <Badge tone="success" icon="checkCircle">Plays smoothly</Badge>}>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] sm:gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="min-w-0 rounded-lg bg-surface-inset p-3">
            <div className="text-caption text-text-muted">{t.label}</div>
            <div className="text-[22px] leading-7 font-bold text-text tabular-nums">{t.value}</div>
            {t.note && <div className="text-caption text-text-secondary">{t.note}</div>}
          </div>
        ))}
      </div>
      {q.suggestion
        ? <Alert tone="info" title="Suggestion">{q.suggestion}</Alert>
        : q.bitrate_kbps ? <Quiet>This file streams at about {(q.bitrate_kbps / 1000).toFixed(q.bitrate_kbps < 10000 ? 1 : 0)} Mbps.</Quiet> : null}
    </Panel>
  );
}

export default function MediaTab({ slug, ov, range, internal }: { slug: string; ov: Overview; range: AnalyticsRange; internal: boolean }) {
  const video = ov.doc.kind === "video";
  const noun = video ? "watching" : "listening";
  const fileVersion = ov.doc.file_version ?? 1;
  // The version on show (null = the current one); the list comes back with the media answer.
  const [ver, setVer] = useState<number | null>(null);
  const media = useLoad(ov.has_engagement ? `media:${slug}:${range}:${internal}:${ver ?? ""}` : null, () => getMedia(slug, { range, internal }, ver));
  const versions = useLoad(video && fileVersion > 1 && ov.has_engagement ? `ver:${slug}:${range}:${internal}` : null, () => getVersions(slug, { range, internal }));

  if (!ov.has_engagement) {
    return (
      <div className="flex flex-col gap-4">
        <TrackingNote since={ov.tracking_since} />
        <EmptyState icon={video ? "film" : "music"} title={`No ${video ? "watch" : "listening"} data yet`} description="It appears here as soon as someone presses play." />
      </div>
    );
  }
  if (media.error) return <LoadError error={media.error} retry={media.retry} />;
  const m = media.data;
  if (!m) return <div className="flex flex-col gap-4"><PanelSkeleton height={240} /><PanelSkeleton height={120} /></div>;
  if (!m.sessions) {
    return <EmptyState icon={video ? "film" : "music"} title="Nobody pressed play in this period" description="Try a longer date range." />;
  }

  const marks = m.moments.map((x) => ({ t: x.t, label: x.title }));
  const withCurve = (versions.data?.versions ?? []).filter((v) => v.first_minute && v.first_minute.length > 1);
  const cur = withCurve[0], prev = withCurve[1];
  const extras = [
    video && m.fullscreen_pct > 0 ? `${pct(m.fullscreen_pct)} go fullscreen` : null,
    m.muted_pct > 0 ? `${pct(m.muted_pct)} ${video ? "watch" : "listen"} muted` : null,
    video && m.pip_pct > 0 ? `${pct(m.pip_pct)} use picture-in-picture` : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <Panel id="md-ret" title={video ? "Who's still watching, second by second" : "Who's still listening, second by second"}
        aside={`${num(m.viewers)} ${video ? "viewers" : "listeners"}${fileVersion > 1 ? ` · version ${m.ver}` : ""} · ${RANGE_WORDS[range]}`}
        headerExtra={m.versions.length > 1 ? <VersionSelect versions={m.versions.map((v) => v.version)} value={m.ver} onChange={setVer} /> : undefined}>
        <RetentionChart points={m.retention} dur={m.dur} marks={marks} noun={noun} />
        {m.moments.length > 0 && (
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
            {m.moments.map((mo) => (
              <li key={`${mo.kind}-${mo.t}`} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                {video
                  ? <FrameThumb slug={slug} t={mo.t} ver={m.ver} alt={`Frame at ${clock(mo.t)}`} fallback={`frame ${clock(mo.t)}`} />
                  : <span className="grid h-[54px] w-[72px] shrink-0 place-items-center rounded-md bg-surface-inset font-mono text-micro text-text-muted"><Icon name="music" size={14} />{clock(mo.t)}</span>}
                <div className="min-w-0">
                  <div className="text-[13px] leading-5 font-semibold text-text">{mo.title}</div>
                  <div className="text-caption text-text-muted">{mo.body}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {m.rewatch.length > 0 && (
          <div>
            <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-caption text-text-muted">
              <span>Rewatched and skipped</span>
              <span>darker = more rewatching · gaps = skipped</span>
            </div>
            <HeatStrip values={m.rewatch} dur={m.dur} />
          </div>
        )}
      </Panel>

      <div className="flex flex-wrap gap-4">
        {cur && prev && (
          <Panel id="md-cmp" title={`Version ${cur.version} vs version ${prev.version}, first minute`} className="flex-[999_1_480px]"
            headerExtra={<Legend a={`Version ${cur.version} (now)`} b={`Version ${prev.version}`} />}>
            <CompareChart noun={noun} a={{ label: `Version ${cur.version}`, points: cur.first_minute! }} b={{ label: `Version ${prev.version}`, points: prev.first_minute! }} />
          </Panel>
        )}
        <Panel id="md-how" title={video ? "How they watch" : "How they listen"} className="flex-[1_1_300px]">
          {m.speeds.length
            ? <BarList labelWidth={52} rows={m.speeds.map((s) => ({ key: s.rate, label: rateLabel(s.rate), value: s.pct, display: pct(s.pct) }))} />
            : <Quiet>No speed data yet.</Quiet>}
          {extras.length > 0 && <Quiet>{extras.join(" · ")}</Quiet>}
        </Panel>
      </div>

      {video && <Qoe m={m} />}
    </div>
  );
}

export function Legend({ a, b }: { a: string; b: string }) {
  return (
    <span className="flex flex-wrap items-center gap-3 text-caption text-text-secondary">
      <span className="flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-3.5 bg-(--chart-1)" />{a}</span>
      <span className="flex items-center gap-1.5"><span aria-hidden className="w-3.5 border-t-2 border-dashed border-(--chart-2)" />{b}</span>
    </span>
  );
}

/** A version picker for the media tab (unused when there is one version). */
export function VersionSelect({ versions, value, onChange }: { versions: number[]; value: number; onChange: (v: number) => void }) {
  return (
    <Select aria-label="Version" value={String(value)} onChange={(e) => onChange(+e.target.value)}
      options={versions.map((v) => ({ value: String(v), label: `Version ${v}` }))} />
  );
}
