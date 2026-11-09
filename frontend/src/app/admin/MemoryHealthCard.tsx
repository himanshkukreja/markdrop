"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button } from "@/components/ui";
import { adminMemoryHealth, type MemoryHealth, type MemorySample } from "@/lib/api";
import { TrendChart, type Point } from "./analytics/charts";
import { Card, CardError, CardSkeleton, CardTitle, Figure } from "./analytics/ui";
import { isUnauthorized, useOnUnauthorized } from "./shared";

const BUCKET_MS = 15 * 60 * 1000;

/** The API's memory over 24 hours: every process sampled every 5 minutes (services/memory_health.py),
 *  summed per 15-minute bucket (each process's highest sample in it), with each process's latest. */
export function memoryPoints(samples: MemorySample[]): Point[] {
  const buckets = new Map<number, Map<string, number>>();
  for (const s of samples) {
    const b = Math.floor(new Date(s.at).getTime() / BUCKET_MS) * BUCKET_MS;
    const per = buckets.get(b) ?? new Map<string, number>();
    const key = `${s.host ?? ""}:${s.pid}`;
    per.set(key, Math.max(per.get(key) ?? 0, s.rss_mb));
    buckets.set(b, per);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([t, per]) => ({ t: new Date(t).toISOString(), v: Math.round([...per.values()].reduce((n, v) => n + v, 0)) }));
}

function uptime(s: number): string {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

export function MemoryHealthCard({ token }: { token: string }) {
  const onUnauthorized = useOnUnauthorized();
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const [state, setState] = useState<{ data?: MemoryHealth; error?: boolean }>({});
  const load = useCallback(() => {
    adminMemoryHealth(token).then((d) => setState({ data: d }))
      .catch((e) => { if (isUnauthorized(e)) onUnauthorized(); else setState((s) => ({ ...s, error: true })); });
  }, [token, onUnauthorized]);
  useEffect(() => { load(); }, [load]);

  const d = state.data;
  if (!d) return state.error ? <CardError title="API memory" onRetry={() => { setState({}); load(); }} /> : <CardSkeleton title="API memory" height={300} />;
  const points = memoryPoints(d.samples);
  const line = d.alert.rss_mb;
  const hot = d.processes.filter((p) => p.rss_mb >= line || p.swap_mb >= d.alert.swap_mb);
  return (
    <Card aria-labelledby="memory-h">
      <CardTitle id="memory-h" title="API memory"
        sub={`Every API process, sampled every 5 minutes · last 24 hours · owners are emailed over ${line} MB or when swap is used`}
        right={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={load}>Refresh</Button>} />
      {hot.length > 0 && (
        <Alert tone="danger" className="mb-4">
          {hot.map((p) => `${p.role} (pid ${p.pid}) at ${Math.round(p.rss_mb)} MB${p.swap_mb >= d.alert.swap_mb ? `, ${Math.round(p.swap_mb)} MB in swap` : ""}`).join("; ")}.
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        <Figure accent label={`This process (${d.process.role})`} value={`${Math.round(d.process.rss_mb)} MB`}
          foot={`Peak ${Math.round(d.process.peak_mb)} MB · up ${uptime(d.process.uptime_s)}`} />
        <Figure label="Swap" value={`${Math.round(d.process.swap_mb)} MB`} foot={`${d.process.threads} threads · ${d.process.tasks} tasks`} />
        {d.processes.slice(0, 2).map((p) => (
          <Figure key={`${p.host}:${p.pid}`} label={`${p.role} · pid ${p.pid}`} value={`${Math.round(p.rss_mb)} MB`}
            foot={`Last sample ${new Date(p.at).toLocaleTimeString("en", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`} />
        ))}
      </div>
      <div className="mt-5">
        {points.length > 1 ? (
          <TrendChart points={points} unit="hour" tz={tz} label="RSS, all processes (MB)" format={(n) => `${n.toLocaleString("en")} MB`} />
        ) : (
          <p className="text-caption text-text-secondary">The chart fills in as samples arrive (the first comes a minute after a restart).</p>
        )}
      </div>
      {d.tracemalloc && (
        <details className="mt-4 text-caption">
          <summary className="cursor-pointer text-text-secondary">
            Allocation sites <Badge size="sm" tone="info" className="ml-1">{d.tracemalloc.traced_mb} MB traced</Badge>
          </summary>
          <ol className="mt-2 flex flex-col gap-1 font-mono text-micro">
            {d.tracemalloc.top.map((t) => <li key={t.where}>{t.kb.toLocaleString("en")} KB · {t.count.toLocaleString("en")} · {t.where}</li>)}
          </ol>
        </details>
      )}
    </Card>
  );
}
