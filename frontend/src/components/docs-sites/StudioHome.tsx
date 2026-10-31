"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Anchor, Badge, Button, ConfirmDialog, EmptyState, Icon, Meter, SegmentedControl, Select, Skeleton, Tabs, useToast,
} from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { docsUrl } from "@/components/shell/links";
import { useLocationSearch } from "@/components/shell/useLocation";
import { DOCS_PAGES } from "@/lib/docsLinks";
import {
  deleteSite, docsErrorMessage, getHomeInsights, primaryAddress, type AllSitesResponse, type HomeInsights, type SiteSummary,
} from "@/lib/docsSites";
import { num } from "./format";
import { EmptyBoard, STARTS } from "./home/EmptyBoard";
import { GuideCard, GuideCardSkeleton, GuideRow, type CardInsights } from "./home/GuideCard";
import { GUIDE_TABS, inTab, isLive, touched, type GuideTab } from "./home/model";
import { StudioLoader, useStudioSession } from "./SiteContext";
import { PERSONAL, STUDIO, studioHome, studioMembers, studioNew, type StudioScope } from "./routes";
import { useStudio } from "./studio/StudioContext";

const FREE_AI = 1000;
const FREE_PAGES = 1000;
const LAYOUT_KEY = "md_guides_home_layout";
type Layout = "cards" | "list";
type InsightsLoad = { state: "loading" } | { state: "error" } | { state: "ok"; data: HomeInsights };

/** Cards or list, remembered in this browser (storage may be off: then just for this visit). */
function useLayout(): [Layout, (l: Layout) => void] {
  const [layout, setLayout] = useState<Layout>("cards");
  useEffect(() => {
    try {
      const v = localStorage.getItem(LAYOUT_KEY);
      if (v === "cards" || v === "list") setLayout(v);
    } catch { /* storage off */ }
  }, []);
  return [layout, (l) => {
    setLayout(l);
    try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* storage off */ }
  }];
}

/** The 7-day numbers, loaded after the listing (and again when it changes: a guide created or deleted). */
function useHomeInsights(all: AllSitesResponse | null): InsightsLoad {
  const [load, setLoad] = useState<InsightsLoad>({ state: "loading" });
  const key = all ? all.sites.map((s) => `${s.id}:${s.status}:${s.insights_enabled ? 1 : 0}`).join(",") : null;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    getHomeInsights()
      .then((data) => live && setLoad({ state: "ok", data }))
      .catch(() => live && setLoad({ state: "error" }));
    return () => { live = false; };
  }, [key]);
  return load;
}

/** One summary tile: label, the number ("—" when there's none), a quiet note. */
function StatTile({ label, phoneLabel, value, note, loading, className }: {
  label: string; phoneLabel?: string; value: React.ReactNode; note?: React.ReactNode; loading?: boolean; className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-3.5 max-sm:gap-0.5 max-sm:px-3.5 max-sm:py-3 ${className ?? ""}`}>
      <span className="truncate text-[12px] leading-4 text-text-muted">
        {phoneLabel ? <><span className="sm:hidden">{phoneLabel}</span><span className="max-sm:hidden">{label}</span></> : label}
      </span>
      {loading ? (
        <span className="flex items-baseline gap-2 py-1"><Skeleton width={56} height={22} /><Skeleton width={90} className="max-sm:hidden" /></span>
      ) : (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <strong className="text-[22px] font-bold leading-7 text-text max-sm:text-[20px] max-sm:leading-[26px]">{value}</strong>
          {note && <span className="min-w-0 truncate text-[12px] text-text-muted max-sm:hidden">{note}</span>}
        </span>
      )}
    </div>
  );
}

function SummaryRow({ all, ins }: { all: AllSitesResponse; ins: InsightsLoad }) {
  const total = all.sites.length;
  const liveN = all.sites.filter(isLive).length;
  const loading = ins.state === "loading";
  const t = ins.state === "ok" ? ins.data.totals : null;
  const none = ins.state === "ok" && t?.readers === null
    ? (ins.data.insights_off > 0 && ins.data.insights_off === ins.data.guides ? "Insights is off" : "Nothing published yet")
    : ins.state === "error" ? "Couldn't load" : undefined;
  const change = t?.readers_change;
  const readersNote = none ?? (change === null || change === undefined ? "last 7 days" : `${change > 0 ? "+" : change < 0 ? "−" : "±"}${Math.abs(change)}% vs last week`);
  const dash = (v: number | null | undefined, f: (n: number) => string = num) => (v === null || v === undefined ? "—" : f(v));
  return (
    <section aria-label="Across your guides, last 7 days" className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
      <StatTile label="Live guides" value={num(liveN)} note={`of ${num(total)}`} className="max-sm:hidden" />
      <StatTile label="Readers" phoneLabel="Readers, 7 days" value={dash(t?.readers)} note={readersNote} loading={loading} />
      <StatTile
        label="Ask AI answers"
        value={dash(t?.ask_answered)}
        note={none ?? `${num(t?.ask_unanswered ?? 0)} unanswered`}
        loading={loading}
        className="max-sm:hidden"
      />
      <StatTile
        label="Page feedback"
        phoneLabel="Found it helpful"
        value={dash(t?.helpful_pct, (n) => `${n}%`)}
        note={none ?? (t && t.helpful_pct === null ? "No votes yet" : "found it helpful")}
        loading={loading}
      />
    </section>
  );
}

/** The dashed "Start a new guide" tile (cards) and bar (phones, list), with the four ways to start. */
function StartTile({ scope, bar }: { scope: StudioScope | null; bar?: boolean }) {
  if (bar) {
    return (
      <Anchor href={studioNew(scope)} className="md-focus flex items-center gap-3 rounded-xl border-[1.5px] border-dashed border-border-strong p-3.5 text-text no-underline hover:bg-surface-hover">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden><Icon name="plus" size={18} /></span>
        <span className="flex min-w-0 flex-col">
          <strong className="font-semibold">Start a new guide</strong>
          <span className="text-[12px] text-text-muted">Blank, template, GitBook or OpenAPI</span>
        </span>
      </Anchor>
    );
  }
  return (
    <div className="flex min-h-[360px] flex-col justify-center gap-3.5 rounded-xl border-[1.5px] border-dashed border-border-strong p-6">
      <span className="grid size-10 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden><Icon name="plus" size={20} /></span>
      <span className="flex flex-col gap-1">
        <Anchor href={studioNew(scope)} className="md-focus self-start rounded text-[16px] font-semibold leading-6 text-text no-underline hover:underline">Start a new guide</Anchor>
        <span className="text-body text-text-secondary">Blank, from a template, from your GitBook, or an API reference from an OpenAPI file.</span>
      </span>
      <ul className="flex flex-wrap gap-1.5" aria-label="Ways to start">
        {STARTS.map((s) => (
          <li key={s.start}>
            <Anchor href={studioNew(scope, s.start)} className="md-focus inline-flex rounded-full no-underline" title={s.title}>
              <Badge icon={s.icon} className="hover:bg-surface-hover">{s.short}</Badge>
            </Anchor>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Free while in beta": guides in the selected (or busiest) workspace of its limit, and Ask AI this month. */
function PlanCard({ all, scope }: { all: AllSitesResponse; scope: StudioScope }) {
  const ws = all.workspaces.find((w) => w.id === scope);
  const usage = scope === PERSONAL ? all.personal.usage : ws?.usage;
  const where = scope === PERSONAL ? "Personal" : ws?.name ?? "this workspace";
  const aiLimit = all.usage.ai_limit ?? FREE_AI;
  const busiest = all.sites.reduce<SiteSummary | null>((m, s) => (!m || s.ai_used > m.ai_used ? s : m), null);
  const aiUsed = busiest?.ai_used ?? 0;
  return (
    <section aria-labelledby="plan-h" className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-[18px] max-sm:p-4">
      <div className="flex items-center gap-2">
        <h2 id="plan-h" className="flex-1 text-[16px] font-semibold leading-6 text-text">Free while in beta</h2>
        <Badge tone="info" size="sm" upper>Beta</Badge>
      </div>
      {usage && (
        <Meter
          className="max-sm:hidden"
          size="sm"
          label={<span className="text-caption text-text-muted">Guides in <span className="ph-sensitive ph-mask">{where}</span>: {num(usage.sites)} of {num(usage.limit)}</span>}
          value={usage.sites}
          max={usage.limit}
          threshold={1}
          valueText={`${usage.sites} of ${usage.limit} guides`}
        />
      )}
      <Meter
        size="sm"
        label={
          <span className="text-caption text-text-muted">
            Ask AI answers this month: {num(aiUsed)} of {num(aiLimit)}
            {busiest && aiUsed > 0 && all.sites.length > 1 ? <> (busiest: <span className="ph-sensitive ph-mask">{busiest.name}</span>)</> : null}
          </span>
        }
        value={aiUsed}
        max={aiLimit}
        threshold={0.9}
        valueText={`${aiUsed} of ${aiLimit} answers`}
      />
      <p className="text-[12px] leading-4 text-text-muted max-sm:hidden">
        Each workspace holds {num(all.usage.limit)} guides of up to {num(FREE_PAGES)} pages, with {num(aiLimit)} Ask AI answers a month each, your own domain, Insights and the API reference included.{" "}
        <ReadMore topic="studioFaq">Limits</ReadMore>
      </p>
    </section>
  );
}

const TIPS: Array<{ icon: string; title: string; note: string; topic: keyof typeof DOCS_PAGES }> = [
  { icon: "globe", title: "Use your own domain", note: "help.yourcompany.com with one DNS record", topic: "studioDomain" },
  { icon: "code", title: "Add an API reference", note: "Upload an OpenAPI file; readers get Try it", topic: "studioApiReference" },
  { icon: "eye", title: "See what readers look for", note: "Insights: top pages, searches with no results", topic: "studioInsights" },
];

function TipsCard() {
  return (
    <section aria-labelledby="tips-h" className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface px-5 py-[18px] max-sm:hidden">
      <h2 id="tips-h" className="text-[16px] font-semibold leading-6 text-text">Make the most of it</h2>
      <ul className="flex flex-col">
        {TIPS.map((t) => (
          <li key={t.title}>
            <a href={docsUrl(DOCS_PAGES[t.topic])} target="_blank" rel="noopener" className="md-focus -mx-2.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-text no-underline hover:bg-surface-hover">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-md bg-surface-inset text-text-secondary" aria-hidden><Icon name={t.icon} size={15} /></span>
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="font-semibold">{t.title}</strong>
                <span className="truncate text-[12px] leading-4 text-text-muted">{t.note}</span>
              </span>
              <Icon name="chevronRight" size={15} className="shrink-0 text-text-muted" aria-hidden />
              <span className="md-visually-hidden"> (opens the docs in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Title({ actions }: { actions?: React.ReactNode }) {
  return (
    <section aria-labelledby="home-title" className="flex flex-wrap items-end gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-[1_1_520px] flex-col gap-1.5">
        <h1 id="home-title" className="text-[26px] font-bold leading-8 tracking-[-0.02em] text-text sm:text-[30px] sm:leading-9">Your guides</h1>
        <p className="max-w-[620px] text-body text-text-secondary">
          Help centers, product guides and handbooks. Write in the editor, publish to your own address, with search and Ask AI built in.{" "}
          <ReadMore topic="guidesOverview">How guides work</ReadMore>
        </p>
      </div>
      {actions}
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-busy="true" aria-label="Loading your guides">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3.5 ${i === 0 || i === 2 ? "max-sm:hidden" : ""}`}>
            <Skeleton width={70} /><Skeleton width={100} height={22} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3"><Skeleton width={300} height={34} /><span className="flex-1" /><Skeleton width={200} height={34} className="max-md:hidden" /></div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => <GuideCardSkeleton key={i} />)}
      </div>
    </div>
  );
}

const EMPTY_TAB: Record<GuideTab, string> = {
  all: "No guides here yet.",
  live: "No live guides yet. A guide is live once it's published.",
  review: "Nothing is waiting for a review.",
  drafts: "No drafts: every guide here has been published.",
};

/**
 * /guides (Markdrop Guides' home, Main board): every guide you can open, with the last 7 days
 * across them (Insights; a guide with Insights off adds nothing), filters (All / Live / In review /
 * Drafts, the workspace: ?ws=<id>|personal), cards or a list, "Start a new guide", the beta plan
 * and tips. No guides at all: the first-visit board (EmptyBoard).
 */
export default function StudioHome() {
  const { ready } = useStudioSession(STUDIO);
  const { all, allError, reloadAll } = useStudio();
  const router = useRouter();
  const toast = useToast();
  const search = useLocationSearch();
  const filter = new URLSearchParams(search).get("ws") || "";
  const [tab, setTab] = useState<GuideTab>("all");
  const [layout, setLayout] = useLayout();
  const [deleting, setDeleting] = useState<SiteSummary | null>(null);
  const ins = useHomeInsights(all);

  const known = !filter || filter === PERSONAL || !!all?.workspaces.some((w) => w.id === filter);
  const scoped = useMemo(() => {
    const sites = [...(all?.sites ?? [])].sort((a, b) => touched(b) - touched(a));
    if (!filter) return sites;
    return sites.filter((s) => (filter === PERSONAL ? !s.workspace_id : s.workspace_id === filter));
  }, [all, filter]);

  if (!ready) return <StudioLoader />;

  const ws = filter && filter !== PERSONAL ? all?.workspaces.find((w) => w.id === filter) : null;
  const canCreateIn = (scope: string) => (scope === PERSONAL ? !!all?.personal.can_create : !!all?.workspaces.find((w) => w.id === scope)?.can_create);
  // Where "New guide" puts it: the filtered workspace when you may create there, else the form decides.
  const newScope = filter && known && canCreateIn(filter) ? filter : null;
  const noRole = all?.workspaces.filter((w) => w.your_role === "none").map((w) => w.name) ?? [];

  if (all && all.sites.length === 0 && !filter) return <EmptyBoard scope={null} noRole={noRole} />;

  // The plan card's workspace: the filtered one, else where you create the most.
  const planScope = (() => {
    if (filter && known) return filter;
    if (!all) return PERSONAL;
    const options = [...all.workspaces.filter((w) => w.can_create).map((w) => ({ id: w.id, n: w.usage.sites })), { id: PERSONAL, n: all.personal.usage.sites }];
    return options.reduce((m, o) => (o.n > m.n ? o : m), options[0]!).id;
  })();

  const counts = Object.fromEntries(GUIDE_TABS.map((t) => [t.value, scoped.filter((s) => inTab(s, t.value)).length])) as Record<GuideTab, number>;
  const shown = scoped.filter((s) => inTab(s, tab));
  const where = (s: SiteSummary) => (s.workspace_id ? s.workspace?.name ?? all?.workspaces.find((w) => w.id === s.workspace_id)?.name ?? "Workspace" : "Personal");
  const cardIns = (s: SiteSummary): CardInsights =>
    ins.state === "ok" ? { state: "ok", data: ins.data.sites[s.id], days: ins.data.days } : ins;
  const managesPeople = (s: SiteSummary) => !!all?.workspaces.find((w) => w.id === s.workspace_id)?.can_manage_people;
  const showStart = !!all && (newScope !== null || (!filter && (all.personal.can_create || all.workspaces.some((w) => w.can_create))));
  const item = { onDelete: setDeleting };

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1168px] flex-col gap-7 px-4 pb-16 pt-6 outline-none max-sm:gap-[18px] sm:px-6 sm:pt-9">
      <Title
        actions={
          <div className="flex gap-2 max-sm:w-full">
            <Button variant="secondary" iconLeft="download" href={studioNew(newScope, "gitbook")} className="max-sm:hidden">Import from GitBook</Button>
            <Button variant="primary" iconLeft="plus" href={studioNew(newScope)} className="max-sm:w-full">New guide</Button>
          </div>
        }
      />

      {allError && (
        <Alert tone="danger" title="We couldn't load your guides" actions={<Button size="sm" variant="secondary" onClick={() => void reloadAll()}>Try again</Button>}>
          {allError}
        </Alert>
      )}

      {!all && !allError && <HomeSkeleton />}

      {all && (
        <>
          <SummaryRow all={all} ins={ins} />

          <section aria-labelledby="list-h" className="flex flex-col gap-4">
            <h2 id="list-h" className="md-visually-hidden">Guides</h2>
            <div className="flex flex-wrap items-center gap-3">
              <div className="-mx-4 min-w-0 overflow-x-auto px-4 max-sm:w-[calc(100%+32px)] sm:mx-0 sm:px-0">
                <Tabs
                  variant="pill"
                  aria-label="Filter guides"
                  idPrefix="guides"
                  value={tab}
                  onChange={(v) => setTab(v as GuideTab)}
                  items={GUIDE_TABS.map((t) => ({ value: t.value, label: t.label, count: counts[t.value] }))}
                />
              </div>
              <span className="flex-1 max-sm:hidden" />
              {all.workspaces.length > 0 && (
                <label className="flex items-center gap-2 text-[13px] text-text-muted max-sm:w-full">
                  <span className="shrink-0">Workspace</span>
                  <Select
                    aria-label="Workspace"
                    className="ph-no-capture w-[220px] max-w-full max-sm:flex-1"
                    value={known ? filter : ""}
                    onChange={(e) => router.replace(studioHome(e.target.value || null))}
                    options={[
                      { value: "", label: "All workspaces" },
                      { value: PERSONAL, label: "Personal" },
                      ...all.workspaces.map((w) => ({ value: w.id, label: w.name })),
                    ]}
                  />
                </label>
              )}
              {ws?.can_manage_people && <Button variant="ghost" size="sm" iconLeft="users" href={studioMembers(ws.id)}>Members</Button>}
              <SegmentedControl
                aria-label="Layout"
                size="sm"
                iconOnly
                className="max-sm:hidden"
                value={layout}
                onChange={setLayout}
                options={[{ value: "cards", label: "Cards", icon: "table" }, { value: "list", label: "List", icon: "list" }]}
              />
            </div>

            {ws?.your_role === "none" && (
              <Alert tone="info" title="You don't have a Guides role here yet">
                A Guides admin of <span className="ph-sensitive ph-mask">{ws.name}</span> can give you one. Until then its guides don&apos;t show here.
              </Alert>
            )}

            <div role="tabpanel" id={`guides-panel-${tab}`} aria-labelledby={`guides-tab-${tab}`} className="flex flex-col gap-4">
              {!known ? (
                <EmptyState icon="users" title="That workspace isn't one of yours" description="You may have left it, or it was deleted." actions={<Button variant="secondary" href={studioHome()}>Show all guides</Button>} />
              ) : (
                <>
                  {shown.length === 0 && <p className="text-body text-text-muted">{EMPTY_TAB[tab]}</p>}
                  {layout === "list" && shown.length > 0 ? (
                    <ul className="ph-no-capture hidden flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface sm:flex" aria-label="Guides">
                      {shown.map((s) => <GuideRow key={s.id} site={s} where={where(s)} insights={cardIns(s)} canManagePeople={managesPeople(s)} {...item} />)}
                    </ul>
                  ) : null}
                  <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 max-sm:gap-3 ${layout === "list" ? "sm:hidden" : ""}`}>
                    {shown.map((s) => <GuideCard key={s.id} site={s} where={where(s)} insights={cardIns(s)} canManagePeople={managesPeople(s)} {...item} />)}
                    {showStart && layout === "cards" && <div className="max-sm:hidden"><StartTile scope={newScope} /></div>}
                  </div>
                  {showStart && <div className={layout === "cards" ? "sm:hidden" : ""}><StartTile scope={newScope} bar /></div>}
                </>
              )}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <PlanCard all={all} scope={planScope} />
            <TipsCard />
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={<>Delete <span className="ph-sensitive ph-mask">{deleting?.name}</span>?</>}
        body={<>Every page, version and publish goes, and <span className="ph-sensitive ph-mask">{deleting ? primaryAddress(deleting) : ""}</span> stops working. This can&apos;t be undone.</>}
        typeToConfirm={deleting?.name}
        confirmLabel="Delete guide"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteSite(deleting.id);
          } catch (e) {
            throw new Error(docsErrorMessage(e, "We couldn't delete the guide. Try again."));
          }
          toast.success(<><span className="ph-sensitive ph-mask">{deleting.name}</span> was deleted.</>);
          setDeleting(null);
          void reloadAll();
        }}
      />
    </main>
  );
}
