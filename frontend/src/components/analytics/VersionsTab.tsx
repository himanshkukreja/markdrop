"use client";

/** Versions tab: one row per file version, and (video/audio) the first minute of the two newest versions compared. */
import { EmptyState } from "@/components/ui";
import { getVersions, type AnalyticsRange, type Overview } from "@/lib/analytics";
import { CompareChart } from "./charts";
import { day, num, pct, secs } from "./format";
import { Legend } from "./MediaTab";
import { LoadError, Panel, PanelSkeleton, useLoad } from "./parts";

function metric(m: { label: string; value: number } | null): string {
  if (!m) return "—";
  if (/watched|listened|read|reached|played|finished|%/i.test(m.label)) return pct(m.value);
  if (/time/i.test(m.label)) return secs(m.value);
  return num(m.value);
}

export default function VersionsTab({ slug, ov, range, internal }: { slug: string; ov: Overview; range: AnalyticsRange; internal: boolean }) {
  const res = useLoad(`versions:${slug}:${range}:${internal}`, () => getVersions(slug, { range, internal }));
  if (res.error) return <LoadError error={res.error} retry={res.retry} />;
  const vs = res.data?.versions;
  if (!vs) return <PanelSkeleton height={200} />;
  if (!vs.length) return <EmptyState icon="history" title="No versions yet" description="Upload a new version of this file to compare them here." />;

  const sorted = [...vs].sort((a, b) => b.version - a.version);
  const current = ov.doc.file_version ?? sorted[0]!.version;
  const metricLabel = sorted.find((v) => v.primary_metric)?.primary_metric?.label ?? "Engagement";
  const withCurve = sorted.filter((v) => v.first_minute && v.first_minute.length > 1);
  const a = withCurve[0], b = withCurve[1];
  const noun = ov.doc.kind === "audio" ? "listening" : "watching";

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {a && b && (
        <Panel id="vr-cmp" title={`Version ${a.version} vs version ${b.version}, first minute`}
          headerExtra={<Legend a={`Version ${a.version}${a.version === current ? " (now)" : ""}`} b={`Version ${b.version}`} />}>
          <CompareChart noun={noun} a={{ label: `Version ${a.version}`, points: a.first_minute! }} b={{ label: `Version ${b.version}`, points: b.first_minute! }} />
        </Panel>
      )}
      <Panel id="vr-all" title="Every version">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <caption className="md-visually-hidden">Views, sessions and {metricLabel.toLowerCase()} for each version</caption>
            <thead>
              <tr className="text-left text-eyebrow tracking-[0.08em] text-text-muted uppercase">
                <th scope="col" className="px-2 py-1.5 font-bold">Version</th>
                <th scope="col" className="px-2 py-1.5 font-bold">Went live</th>
                <th scope="col" className="px-2 py-1.5 font-bold">Views</th>
                <th scope="col" className="px-2 py-1.5 font-bold">Sessions</th>
                <th scope="col" className="px-2 py-1.5 font-bold">{metricLabel}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {sorted.map((v) => (
                <tr key={v.version} className="border-t border-border">
                  <th scope="row" className="px-2 py-2 text-left font-semibold text-text">
                    Version {v.version}{v.version === current && <span className="font-normal text-text-muted"> (now)</span>}
                  </th>
                  <td className="px-2 py-2 text-text-secondary">{day(v.created_at)}</td>
                  <td className="px-2 py-2 text-text">{num(v.views)}</td>
                  <td className="px-2 py-2 text-text">{num(v.sessions)}</td>
                  <td className="px-2 py-2 text-text">{metric(v.primary_metric)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
