"use client";

/**
 * Viewers tab: every view of one document or file (backend services/doc_views.py). Who — a
 * signed-in viewer's name and email, or an anonymous "Visitor 3F2A" — when, active time, how far
 * they got, where from and on what; breakdowns that filter the list; a per-person rollup; a view's
 * activity timeline in a drawer (a bottom sheet on phones); CSV. A viewer of a workspace item sees
 * the counts only. Filters live in the URL (?who=, ?completion=, ?country=, …, ?view=<id>).
 */
import { useMemo, useState } from "react";
import { Avatar, Badge, Button, Drawer, EmptyState, Icon, SegmentedControl, Select, Skeleton, Switch, Tag, cx, useToast } from "@/components/ui";
import { usePhone } from "@/components/dashboard/hooks";
import {
  downloadViewersCsv, getViewTimeline, getViewerPeople, getViewers,
  type AnalyticsRange, type ViewCompletion, type ViewStep, type ViewSummary, type ViewerPerson, type ViewerWho,
  type ViewersQuery, type ViewersResponse, TRACK_KEYS, type Track,
} from "@/lib/analytics";
import { BarList } from "./charts";
import { TRACK_LABEL } from "./AnalyticsSettings";
import { clock, countryName, deviceLabel, num, pct, secs } from "./format";
import { KpiTile, LoadError, Panel, PanelSkeleton, Quiet, useLoad, useParams } from "./parts";

const PAGE = 50;
const WHO: { value: ViewerWho; label: string }[] = [
  { value: "all", label: "Everyone" }, { value: "signed_in", label: "Signed in" }, { value: "anonymous", label: "Anonymous" },
];
const COMPLETION: { value: ViewCompletion; label: string }[] = [
  { value: "any", label: "Any completion" }, { value: "low", label: "Under 25%" }, { value: "mid", label: "25–75%" },
  { value: "high", label: "75% or more" }, { value: "done", label: "Finished (90%+)" },
];
const DIMS = ["country", "device", "os", "browser", "source"] as const;
type Dim = (typeof DIMS)[number];
const DIM_WORD: Record<Dim, string> = { country: "Country", device: "Device", os: "OS", browser: "Browser", source: "Source" };

/** 🇮🇳 from "IN" (regional indicator letters); empty for anything else. */
export function flag(cc: string | null | undefined): string {
  if (!cc || !/^[A-Z]{2}$/i.test(cc)) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "Today 10:02" · "Yesterday 18:40" · "Nov 3, 09:15" (the viewer's own clock). */
export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const t = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today ${t}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`;
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}, ${t}`;
}

const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

function deviceIcon(d: string | null | undefined): string {
  return d === "Mobile" || d === "Phone" ? "phone" : d === "Tablet" ? "tablet" : "laptop";
}

/** "Visitor 3F2A · Chrome 131 on macOS · Mumbai" for the anonymous; the name otherwise. */
function whoLine(v: { viewer: ViewSummary["viewer"] }): string {
  return v.viewer.name || v.viewer.email || "Someone";
}

function placeShort(v: ViewSummary): string | null {
  return v.location.city || v.location.region || (v.location.country ? countryName(v.location.country) : null);
}

const ACT_ICON: Record<string, { icon: string; word: string }> = {
  dl: { icon: "download", word: "Downloaded" }, link: { icon: "link", word: "Opened links" }, copy: { icon: "copy", word: "Copied code" },
  print: { icon: "printer", word: "Printed" }, ask: { icon: "message", word: "Asked AI" }, signoff: { icon: "checkCircle", word: "Signed off" },
  fs: { icon: "expand", word: "Full screen" },
};

function Completion({ value, className }: { value: number | null; className?: string }) {
  if (value == null) return <span className={cx("tabular-nums text-text-muted", className)}>—</span>;
  return (
    <span className={cx("inline-flex items-center gap-1.5 tabular-nums", className)}>
      <span className="h-1.5 w-10 rounded-full bg-(--chart-track)" aria-hidden>
        <span className="block h-1.5 rounded-full bg-(--chart-1)" style={{ width: `${Math.max(3, Math.min(100, value))}%` }} />
      </span>
      {pct(value)}
    </span>
  );
}

function ViewRow({ v, onOpen, track }: { v: ViewSummary; onOpen: () => void; track: Partial<Track> }) {
  const anon = v.viewer.type === "anonymous";
  const place = track.location === false ? null : placeShort(v);
  const acts = Object.entries(v.acts).filter(([, n]) => (n ?? 0) > 0);
  return (
    <li className="border-t border-border first:border-t-0">
      <button type="button" onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-(--border-focus) pointer-coarse:min-h-14">
        {anon
          ? <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-inset text-text-muted" aria-hidden><Icon name={track.device === false ? "user" : deviceIcon(v.system.device)} size={18} /></span>
          : <Avatar name={whoLine(v)} src={v.viewer.avatar ?? undefined} size="md" className="ph-mask" />}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={cx("min-w-0 truncate text-body-strong text-text", !anon && "ph-sensitive ph-mask")}>{whoLine(v)}</span>
            {!anon && v.viewer.email && v.viewer.name && <span className="ph-sensitive ph-mask hidden min-w-0 truncate text-caption text-text-muted sm:inline">{v.viewer.email}</span>}
            {v.own && <Badge size="sm" tone="neutral">You</Badge>}
            {v.internal && !v.own && <Badge size="sm" tone="info">Member</Badge>}
            {(v.visit_n ?? 1) > 1 && <Badge size="sm" tone="neutral">{ordinal(v.visit_n!)} visit</Badge>}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-caption text-text-muted">
            <span>{when(v.started_at)}</span>
            {track.device !== false && <><span aria-hidden>·</span><span className="truncate">{v.system.label}</span></>}
            {place && <><span aria-hidden>·</span><span className="truncate">{flag(v.location.country)} {place}</span></>}
            {track.source !== false && v.source && v.source !== "Direct" && <><span aria-hidden>·</span><span className="truncate">via {v.source}</span></>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-[13px] text-text">
          <span className="tabular-nums">{secs(v.active_s)}</span>
          <Completion value={v.completion} className="text-caption text-text-secondary" />
        </span>
        {acts.length > 0 && (
          <span className="hidden shrink-0 items-center gap-1 text-text-muted md:flex">
            {acts.slice(0, 3).map(([k]) => <Icon key={k} name={ACT_ICON[k]?.icon ?? "zap"} size={14} aria-label={ACT_ICON[k]?.word} />)}
          </span>
        )}
        <Icon name="chevronRight" size={16} className="shrink-0 text-text-muted" />
      </button>
    </li>
  );
}

function PersonRow({ p, onOpen }: { p: ViewerPerson; onOpen: () => void }) {
  const anon = p.viewer.type === "anonymous";
  const name = p.viewer.name || p.viewer.email || "Someone";
  return (
    <li className="border-t border-border first:border-t-0">
      <button type="button" onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-(--border-focus) pointer-coarse:min-h-14">
        {anon ? <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-inset text-text-muted" aria-hidden><Icon name="user" size={18} /></span>
          : <Avatar name={name} src={p.viewer.avatar ?? undefined} size="md" className="ph-mask" />}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cx("min-w-0 truncate text-body-strong text-text", !anon && "ph-sensitive ph-mask")}>{name}</span>
            {p.own && <Badge size="sm" tone="neutral">You</Badge>}
            {p.internal && !p.own && <Badge size="sm" tone="info">Member</Badge>}
          </span>
          <span className="truncate text-caption text-text-muted">
            Last {when(p.last_at)} · {p.system}{p.place ? ` · ${p.place}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-[13px]">
          <span className="tabular-nums text-text">{num(p.views)} view{p.views === 1 ? "" : "s"} · {secs(p.active_s)}</span>
          <Completion value={p.best_completion} className="text-caption text-text-secondary" />
        </span>
        <Icon name="chevronRight" size={16} className="shrink-0 text-text-muted" />
      </button>
    </li>
  );
}

const STEP_ICON: Record<string, string> = {
  open: "eye", section: "lines", page: "doc", slide: "slides", tab: "table", watch: "play", pause: "pause", seek: "arrowRight",
  end: "checkCircle", rate: "zap", fullscreen: "expand", depth: "arrowDown", link: "link", copy: "copy", download: "download",
  print: "printer", find: "search", ask: "message", signoff: "checkCircle", leave: "logOut",
};

function Steps({ steps, started }: { steps: ViewStep[]; started: string }) {
  const t0 = new Date(started).getTime();
  return (
    <ol className="ph-no-capture m-0 flex list-none flex-col p-0" aria-label="What they did">
      {steps.map((s, i) => {
        const at = new Date(s.at);
        const clockTime = Number.isNaN(at.getTime()) ? "" : at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
        return (
          <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
            {i < steps.length - 1 && <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border" aria-hidden />}
            <span className={cx("relative z-[1] grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface",
              s.kind === "ask" || s.kind === "signoff" ? "text-accent-text" : s.kind === "download" ? "text-success" : "text-text-secondary")} aria-hidden>
              <Icon name={STEP_ICON[s.kind] ?? "zap"} size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col pt-1">
              <span className="text-[13px] leading-5 text-text break-words">
                {s.kind === "link" && s.url ? <>Opened a link: <span className="font-mono text-caption break-all">{s.url}</span></> : s.text}
              </span>
              <span className="text-micro text-text-muted tabular-nums">
                {clockTime}{Number.isFinite(t0) && s.t > 0 ? ` · +${clock(s.t)}` : ""}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Fact({ icon, children, label }: { icon: string; children: React.ReactNode; label: string }) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-[13px] text-text-secondary">
      <Icon name={icon} size={14} className="mt-[3px] shrink-0 text-text-muted" aria-hidden />
      <span className="min-w-0 break-words"><span className="md-visually-hidden">{label}: </span>{children}</span>
    </li>
  );
}

function TimelineDrawer({ slug, viewId, onClose, onOpen, track }: { slug: string; viewId: string | null; onClose: () => void; onOpen: (id: string) => void; track: Partial<Track> }) {
  const phone = usePhone();
  const tl = useLoad(viewId ? `view:${slug}:${viewId}` : null, () => getViewTimeline(slug, viewId!));
  const v = viewId && tl.data?.id === viewId ? tl.data : null;
  const anon = v?.viewer.type === "anonymous";
  const sys = v?.system;
  const title = v ? whoLine(v) : "View";
  return (
    <Drawer open={!!viewId} onClose={onClose} side={phone ? "bottom" : "right"} width={460}
      title={<span className={cx(!anon && "ph-sensitive ph-mask")}>{title}</span>}
      description={v ? <span className={cx(!anon && "ph-sensitive ph-mask")}>{anon ? "Not signed in · identified only by this browser" : v.viewer.email ?? (v.viewer.deleted ? "This account was deleted" : "")}</span> : undefined}>
      {tl.error && !v ? <LoadError error={tl.error} retry={tl.retry} what="this view" /> : !v ? (
        <div className="flex flex-col gap-3" aria-busy><Skeleton width="70%" /><Skeleton width="50%" /><Skeleton variant="rect" height={220} /></div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-3 gap-2">
            {[
              { k: "Opened", v: when(v.started_at) },
              { k: "Active", v: secs(v.active_s) },
              { k: v.kind === "video" || v.kind === "audio" ? "Watched" : "Completion", v: v.completion == null ? "—" : pct(v.completion) },
            ].map((x) => (
              <div key={x.k} className="flex min-w-0 flex-col rounded-lg border border-border bg-surface-inset px-2.5 py-2">
                <span className="text-micro text-text-muted">{x.k}</span>
                <span className="truncate text-body-strong text-text tabular-nums">{x.v}</span>
              </div>
            ))}
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {track.location !== false && (v.location.label || v.location.timezone) && (
              <Fact icon="globe" label="Where">
                {v.location.label ? `${flag(v.location.country)} ${v.location.label}`.trim() : "Location unknown"}{v.location.timezone ? ` · ${v.location.timezone}` : ""}
              </Fact>
            )}
            {sys && track.device !== false && <Fact icon={deviceIcon(sys.device)} label="Device">{deviceLabel(sys.device)} · {sys.label}{sys.viewport ? ` · ${sys.viewport}` : ""}{sys.language ? ` · ${sys.language}` : ""}</Fact>}
            {sys && track.device !== false && sys.app !== "tab" && <Fact icon="monitor" label="App">{sys.app === "pwa" ? "Installed Markdrop app" : `Embedded${sys.embed_host ? ` on ${sys.embed_host}` : ""}`}</Fact>}
            {track.source !== false && v.source && <Fact icon="arrowUpRight" label="Source">{v.source === "Direct" ? "Direct or bookmarked" : `From ${v.source}`}{v.referrer ? <> · <span className="font-mono text-caption break-all">{v.referrer}</span></> : null}</Fact>}
            {v.utm && <Fact icon="hash" label="Campaign"><span className="font-mono text-caption">{[v.utm.source, v.utm.medium, v.utm.campaign].filter(Boolean).join(" / ")}</span></Fact>}
            {(v.visit_n ?? 1) > 1 && <Fact icon="refresh" label="Visit">{ordinal(v.visit_n!)} visit</Fact>}
          </ul>
          <section aria-labelledby="vw-steps" className="flex flex-col gap-3">
            <h3 id="vw-steps" className="m-0 text-h4 text-text">What they did</h3>
            <Steps steps={v.steps} started={v.started_at} />
            {v.truncated && <Quiet>This view did a lot: only its first steps are kept.</Quiet>}
          </section>
          {v.other_views.length > 0 && (
            <section aria-labelledby="vw-other" className="flex flex-col gap-2">
              <h3 id="vw-other" className="m-0 text-h4 text-text">Their other views</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {v.other_views.map((o) => (
                  <li key={o.id}>
                    <button type="button" onClick={() => onOpen(o.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-text hover:bg-surface-hover pointer-coarse:min-h-11">
                      <span className="flex-1">{when(o.started_at)}</span>
                      <span className="tabular-nums text-text-muted">{secs(o.active_s)}</span>
                      <Icon name="chevronRight" size={14} className="text-text-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

function Breakdowns({ data, onPick, track }: { data: NonNullable<ViewersResponse["breakdowns"]>; onPick: (dim: Dim, key: string) => void; track: Partial<Track> }) {
  const total = Math.max(1, data.device.reduce((a, r) => a + r.views, 0));
  const panels: { id: string; title: string; dim: Dim | null; rows: { key: string; label: React.ReactNode; views: number }[] }[] = [
    { id: "vw-country", title: "Countries", dim: "country", rows: data.country.map((r) => ({ key: r.key, label: r.key === "Unknown" ? "Unknown" : `${flag(r.key)} ${countryName(r.key)}`, views: r.views })) },
    { id: "vw-city", title: "Cities", dim: null, rows: data.city.map((r) => ({ key: r.key, label: r.key, views: r.views })) },
    { id: "vw-device", title: "Devices", dim: "device", rows: data.device.map((r) => ({ key: r.key, label: deviceLabel(r.key), views: r.views })) },
    { id: "vw-os", title: "Operating systems", dim: "os", rows: data.os.map((r) => ({ key: r.key, label: r.key, views: r.views })) },
    { id: "vw-browser", title: "Browsers and apps", dim: "browser", rows: data.browser.map((r) => ({ key: r.key, label: r.key, views: r.views })) },
    { id: "vw-source", title: "Sources", dim: "source", rows: data.source.map((r) => ({ key: r.key, label: r.key === "Direct" ? "Direct or bookmarked" : r.key, views: r.views })) },
  ];
  // What the item doesn't collect isn't shown (backend services/analytics_prefs.py).
  const hidden = new Set<string>([
    ...(track.location === false ? ["vw-country", "vw-city"] : []),
    ...(track.device === false ? ["vw-device", "vw-os", "vw-browser"] : []),
    ...(track.source === false ? ["vw-source"] : []),
  ]);
  if (panels.every((p) => hidden.has(p.id))) return null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {panels.filter((p) => !hidden.has(p.id)).map((p) => (
        <Panel key={p.id} id={p.id} title={p.title}>
          {p.rows.length ? (
            p.dim ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {p.rows.map((r) => (
                  <li key={r.key}>
                    <button type="button" onClick={() => onPick(p.dim!, r.key)} aria-label={`Show only ${typeof r.label === "string" ? r.label : r.key}`}
                      className="flex w-full flex-col gap-1 rounded-md px-1.5 py-1 text-left hover:bg-surface-hover pointer-coarse:min-h-11 pointer-coarse:justify-center">
                      <span className="flex items-baseline gap-2 text-[13px]">
                        <span className="min-w-0 flex-1 truncate text-text">{r.label}</span>
                        <strong className="font-semibold tabular-nums text-text">{num(r.views)}</strong>
                      </span>
                      <span className="h-1.5 rounded-full bg-(--chart-track)" aria-hidden>
                        <span className="block h-1.5 rounded-full bg-(--chart-1)" style={{ width: `${Math.max(2, (r.views / Math.max(1, p.rows[0]!.views)) * 100)}%` }} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <BarList rows={p.rows.map((r) => ({ key: r.key, label: r.label, value: r.views, display: num(r.views) }))} />
          ) : <Quiet>Nothing yet.</Quiet>}
        </Panel>
      ))}
      <span className="md-visually-hidden">{num(total)} views in these breakdowns</span>
    </div>
  );
}

export default function ViewersTab({ slug, range, workspaceName }: { slug: string; range: AnalyticsRange; workspaceName?: string | null }) {
  const [params, setParams] = useParams();
  const toast = useToast();
  const who = (WHO.some((w) => w.value === params.get("who")) ? params.get("who") : "all") as ViewerWho;
  const completion = (COMPLETION.some((c) => c.value === params.get("completion")) ? params.get("completion") : "any") as ViewCompletion;
  const own = params.get("own") === "1";
  const members = params.get("members") !== "0";
  const mode = params.get("by") === "person" ? "person" : "view";
  const dims = Object.fromEntries(DIMS.map((d) => [d, params.get(d)])) as Record<Dim, string | null>;
  const viewId = params.get("view");
  const [shown, setShown] = useState(PAGE);
  const [csvBusy, setCsvBusy] = useState(false);

  const query: ViewersQuery = useMemo(() => ({ range, who, completion, own, internal: members, ...dims }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, who, completion, own, members, dims.country, dims.device, dims.os, dims.browser, dims.source]);
  const qkey = JSON.stringify(query);
  const res = useLoad(`viewers:${slug}:${qkey}:${shown}`, () => getViewers(slug, query, 0, shown));
  const people = useLoad(mode === "person" ? `people:${slug}:${qkey}` : null, () => getViewerPeople(slug, query));
  const data = res.data;

  const setFilter = (patch: Record<string, string | null>) => {
    setShown(PAGE);
    setParams(patch);
  };
  async function csv() {
    setCsvBusy(true);
    try {
      await downloadViewersCsv(slug, query);
    } catch {
      toast.error("Couldn't download the CSV. Try again.");
    } finally {
      setCsvBusy(false);
    }
  }

  if (res.error && !data) return <LoadError error={res.error} retry={res.retry} what="viewers" />;
  if (!data) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="rect" height={78} />)}</div>
        <PanelSkeleton height={260} />
        <span className="md-visually-hidden">Loading viewers</span>
      </div>
    );
  }

  const t = data.totals;
  const tiles = (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(128px,1fr))] max-sm:[&>*:last-child:nth-child(odd)]:col-span-2">
      <KpiTile range={range} kpi={{ key: "views", label: "Views", value: t.views, unit: "count" }} />
      <KpiTile range={range} kpi={{ key: "people", label: "People", value: t.people, unit: "count" }} />
      <KpiTile range={range} kpi={{ key: "signed_in", label: "Signed in", value: t.signed_in, unit: "count", note: `${num(t.anonymous)} anonymous` }} />
      {data.access === "full" && <KpiTile range={range} kpi={{ key: "time", label: "Avg active time", value: t.avg_active_s ?? 0, unit: "seconds" }} />}
      {data.access === "full" && t.avg_completion != null && <KpiTile range={range} kpi={{ key: "read_end", label: "Avg completion", value: t.avg_completion, unit: "percent" }} />}
    </div>
  );

  if (data.access !== "full") {
    return (
      <div className="flex flex-col gap-4">
        {tiles}
        <Quiet>You can see how many people viewed this. Its owner and the workspace&apos;s admins and editors can see who, and what each view did.</Quiet>
      </div>
    );
  }

  const views = data.views ?? [];
  const track: Partial<Track> = data.track ?? {};
  const notCollected = TRACK_KEYS.filter((k) => k !== "counts" && track[k] === false);
  const activeDims = DIMS.filter((d) => dims[d]);
  const filtered = who !== "all" || completion !== "any" || activeDims.length > 0;

  const controls = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl size="sm" aria-label="List" value={mode} onChange={(m) => setParams({ by: m === "person" ? "person" : null })}
          options={[{ value: "view", label: "Every view" }, { value: "person", label: "By person" }]} />
        <Select aria-label="Who" value={who} onChange={(e) => setFilter({ who: e.target.value === "all" ? null : e.target.value })}
          options={WHO} className="!w-auto min-w-[8.5rem]" />
        {mode === "view" && (
          <Select aria-label="Completion" value={completion} onChange={(e) => setFilter({ completion: e.target.value === "any" ? null : e.target.value })}
            options={COMPLETION} className="!w-auto min-w-[9.5rem]" />
        )}
        <span className="grow" />
        <Button variant="secondary" size="sm" iconLeft="download" loading={csvBusy} onClick={csv}>Export views</Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Switch label="Hide my own views" checked={!own} onChange={(e) => setFilter({ own: e.target.checked ? null : "1" })} />
        {workspaceName && (
          <Switch label={<>Include <span className="ph-sensitive ph-mask">{workspaceName}</span> members</>} checked={members}
            onChange={(e) => setFilter({ members: e.target.checked ? null : "0" })} />
        )}
        {!own && (t.own_hidden ?? 0) > 0 && <span className="text-caption text-text-muted">{num(t.own_hidden!)} of your own hidden</span>}
      </div>
      {activeDims.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Filters">
          {activeDims.map((d) => (
            <Tag key={d} onRemove={() => setFilter({ [d]: null })} removeLabel={`Remove the ${DIM_WORD[d]} filter`}>
              {DIM_WORD[d]}: {d === "country" ? `${flag(dims[d])} ${countryName(dims[d])}` : d === "device" ? deviceLabel(dims[d]) : dims[d]}
            </Tag>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setFilter(Object.fromEntries(DIMS.map((d) => [d, null])))}>Clear</Button>
        </div>
      )}
    </div>
  );

  const openView = (id: string) => setParams({ view: id });
  const list = mode === "person" ? (
    people.error ? <LoadError error={people.error} retry={people.retry} what="people" />
      : !people.data ? <PanelSkeleton height={200} />
        : people.data.people.length ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {people.data.people.map((p) => <PersonRow key={p.key} p={p} onOpen={() => openView(p.last_view)} />)}
          </ul>
        ) : <Quiet>Nobody in this period.</Quiet>
  ) : views.length ? (
    <>
      <ul className="m-0 flex list-none flex-col p-0">
        {views.map((v) => <ViewRow key={v.id} v={v} track={track} onOpen={() => openView(v.id)} />)}
      </ul>
      {data.next != null && (
        <Button variant="secondary" size="sm" className="self-center" loading={res.loading} onClick={() => setShown((n) => n + PAGE)}>
          Show more ({num((data.total ?? 0) - views.length)} more)
        </Button>
      )}
    </>
  ) : (
    <EmptyState icon="eye" title={filtered ? "No views match these filters" : "No views in this period"}
      description={filtered ? "Try fewer filters or a longer date range." : "When someone opens it, their view shows up here within a few seconds."} />
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {tiles}
      <Panel id="vw-list" title={mode === "person" ? "People" : "Every view"} aside={mode === "view" ? `${num(data.total ?? 0)} in this period` : people.data ? `${num(people.data.total)} people` : undefined}>
        {controls}
        <div className={cx("flex min-w-0 flex-col gap-3 transition-opacity", res.loading && "opacity-60")}>{list}</div>
        {notCollected.length > 0 && (
          <Quiet>
            Not collected for this item: {notCollected.map((k) => TRACK_LABEL[k].toLowerCase()).join(", ")}.{" "}
            <button type="button" className="font-semibold text-accent-text underline underline-offset-2" onClick={() => setParams({ settings: "1" })}>Analytics settings</button>
          </Quiet>
        )}
        <Quiet>
          Signed-in viewers are shown by name; everyone else is an anonymous visitor (their city at most, never an IP address).
          Each view&apos;s detail is kept for {num(data.retention_days)} days.
        </Quiet>
      </Panel>
      {data.breakdowns && views.length > 0 && <Breakdowns data={data.breakdowns} track={track} onPick={(d, k) => setFilter({ [d]: k })} />}
      <TimelineDrawer slug={slug} viewId={viewId} track={track} onClose={() => setParams({ view: null })} onOpen={openView} />
    </div>
  );
}
