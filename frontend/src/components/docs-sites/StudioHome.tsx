"use client";

import { useRouter } from "next/navigation";
import { Alert, Badge, Button, EmptyState, Meter, Select, Skeleton, type Tone } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { useLocationSearch } from "@/components/shell/useLocation";
import { preloadDocsEditor } from "@/components/docs-editor";
import { canEditRole, presetName, primaryAddress, type SiteSummary } from "@/lib/docsSites";
import { firstName, num, plural, timeAgo } from "./format";
import SiteThumb from "./SiteThumb";
import { StudioLoader, useStudioSession } from "./SiteContext";
import { RoleBadge } from "./people/roles";
import { PERSONAL, siteBase, STUDIO, studioHome, studioMembers, studioNew } from "./routes";
import { useStudio } from "./studio/StudioContext";
import { groupSites } from "./studio/StudioShell";

const FREE_AI = 1000;

function statusOf(s: SiteSummary): { label: string; tone: Tone } {
  if (s.in_review) return { label: "In review", tone: "warning" };
  if (s.status === "live") return { label: "Live", tone: "success" };
  if (s.status === "unpublished") return { label: "Unpublished", tone: "neutral" };
  return { label: "Draft", tone: "neutral" };
}

function metaOf(s: SiteSummary): string {
  const parts = [`${presetName(s.preset)} theme`];
  if (s.page_count !== undefined) parts.push(plural(s.page_count, "page"));
  if (s.in_review) parts.push(s.review_requested_by_name ? `${firstName(s.review_requested_by_name)}'s changes waiting for review` : "changes waiting for review");
  else if (s.status === "live" && s.last_published_at) {
    const who = s.last_published_by_name ? ` by ${firstName(s.last_published_by_name)}` : "";
    parts.push(`published ${timeAgo(s.last_published_at)}${who}`);
  } else if (s.status === "unpublished") parts.push("taken down");
  else parts.push("not published yet");
  return parts.join(" · ");
}

export function SiteCard({ site }: { site: SiteSummary }) {
  const st = statusOf(site);
  const base = siteBase(site.id);
  const address = primaryAddress(site);
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <SiteThumb preset={site.preset} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 px-[18px] pb-[18px] pt-4">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-6 text-text" dir="auto">{site.name}</h3>
          <Badge tone={st.tone} size="sm" dot>{st.label}</Badge>
        </div>
        {site.workspace_id && site.your_role_source === "site" && (
          <div className="-mt-1"><RoleBadge role={site.your_role} title="Your role on this site (different from your workspace role)" /> <span className="text-[12px] text-text-muted">on this site</span></div>
        )}
        <code className="font-mono text-[12.5px] text-text-secondary [overflow-wrap:anywhere]">{address}</code>
        <p className="text-[13px] leading-5 text-text-muted">{metaOf(site)}</p>
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <span onPointerEnter={preloadDocsEditor} onFocus={preloadDocsEditor}>
            <Button variant="secondary" size="sm" iconLeft="edit" href={base}>
              {canEditRole(site.your_role) ? "Open editor" : "Open"}
            </Button>
          </span>
          {site.status === "live" && (
            <Button variant="ghost" size="sm" iconRight="external" href={`https://${address}`} target="_blank">View site</Button>
          )}
        </div>
      </div>
    </article>
  );
}

function CardSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading docs sites">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-surface pb-4">
          <Skeleton variant="rect" height={132} />
          <div className="flex flex-col gap-2 px-4"><Skeleton width="60%" /><Skeleton width="80%" /><Skeleton width="70%" /></div>
        </div>
      ))}
    </div>
  );
}

/**
 * /docs-studio (Docs Studio's home): every docs site you can open, grouped by where it lives (each
 * workspace you belong to, then your personal sites), with a workspace filter (?ws=<id>|personal),
 * "New docs site", and each scope's use of the free plan.
 */
export default function StudioHome() {
  const { ready } = useStudioSession(STUDIO);
  const { all, allError, reloadAll } = useStudio();
  const router = useRouter();
  const search = useLocationSearch();
  const filter = new URLSearchParams(search).get("ws") || "";

  if (!ready) return <StudioLoader />;

  const groups = all ? groupSites(all.sites, all.workspaces) : [];
  const known = !filter || filter === PERSONAL || !!all?.workspaces.some((w) => w.id === filter);
  // Filtered: that scope alone. Otherwise every workspace (an empty one still offers "New site here"
  // to its admins), and personal sites when there are some.
  const shown = filter ? groups.filter((g) => g.scope === filter) : groups.filter((g) => g.scope !== PERSONAL || g.sites.length > 0);
  const canCreateSomewhere = !all || all.workspaces.some((w) => w.can_create) || all.personal.can_create;
  const usageOf = (scope: string) => (scope === PERSONAL ? all?.personal.usage : all?.workspaces.find((w) => w.id === scope)?.usage);
  const canCreateIn = (scope: string) => (scope === PERSONAL ? !!all?.personal.can_create : !!all?.workspaces.find((w) => w.id === scope)?.can_create);
  const total = all?.sites.length ?? 0;
  const noRole = all?.workspaces.filter((w) => w.your_role === "none") ?? [];
  const busiest = all?.sites.reduce<SiteSummary | null>((m, s) => (!m || s.ai_used > m.ai_used ? s : m), null) ?? null;

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 pb-16 pt-8 outline-none sm:px-6 sm:pt-10">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1.5">
          <h1 className="text-[28px] font-extrabold leading-9 tracking-[-0.02em] text-text">Your docs sites</h1>
          <p className="max-w-[640px] text-[15px] leading-6 text-text-secondary">
            Documentation websites your team writes here and publishes to their own address, with search, Ask AI and a changelog built in.{" "}
            <ReadMore topic="docsStudio" />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {all && (all.workspaces.length > 0) && (
            <Select
              aria-label="Show sites from"
              className="w-[220px] max-w-full"
              value={known ? filter : ""}
              onChange={(e) => router.replace(studioHome(e.target.value || null))}
              options={[
                { value: "", label: "All workspaces" },
                ...all.workspaces.map((w) => ({ value: w.id, label: w.name })),
                { value: PERSONAL, label: "Personal" },
              ]}
            />
          )}
          {canCreateSomewhere && (
            <Button variant="primary" iconLeft="plus" href={studioNew(filter && known ? filter : null)}>New docs site</Button>
          )}
        </div>
      </div>

      {allError && (
        <Alert tone="danger" title="We couldn't load your docs sites" actions={<Button size="sm" variant="secondary" onClick={() => void reloadAll()}>Try again</Button>}>
          {allError}
        </Alert>
      )}

      {!all && !allError && <CardSkeletons />}

      {all && total === 0 && !filter && (
        <EmptyState
          icon="layers"
          title="No docs sites yet"
          description={noRole.length > 0
            ? `You don't have a Docs Studio role in ${noRole.map((w) => w.name).join(", ")} yet. A Docs Studio admin there can give you one; until then its docs sites don't show here. You can still start a personal site.`
            : "Start blank, from a template, or bring your GitBook docs across. Nothing is public until you publish."}
          actions={<Button variant="primary" iconLeft="plus" href={studioNew()}>New docs site</Button>}
        />
      )}

      {all && !known && (
        <EmptyState icon="users" title="That workspace isn't one of yours" description="You may have left it, or it was deleted." actions={<Button variant="secondary" href={studioHome()}>Show all docs sites</Button>} />
      )}

      {all && (total > 0 || filter) && shown.map((g) => {
        const usage = usageOf(g.scope);
        const ws = all.workspaces.find((w) => w.id === g.scope);
        const canCreate = canCreateIn(g.scope);
        const full = !!usage && usage.sites >= usage.limit;
        return (
          <section key={g.scope} aria-labelledby={`grp-${g.scope}`} className="flex flex-col gap-3.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border pb-2.5">
              <h2 id={`grp-${g.scope}`} className="min-w-0 truncate text-[17px] font-semibold text-text" dir="auto">{g.name}</h2>
              {ws && <RoleBadge role={ws.your_role} title="Your Docs Studio role in this workspace" />}
              {usage && (
                <Meter
                  className="w-[150px]"
                  size="sm"
                  label={<span className="text-caption text-text-muted">{num(usage.sites)} of {num(usage.limit)} sites</span>}
                  value={usage.sites}
                  max={usage.limit}
                  threshold={1}
                  valueText={`${usage.sites} of ${usage.limit} sites`}
                />
              )}
              {ws?.can_manage_people && (
                <Button className="ml-auto" variant="ghost" size="sm" iconLeft="users" href={studioMembers(ws.id)}>Members</Button>
              )}
              {canCreate && (
                <Button className={ws?.can_manage_people ? undefined : "ml-auto"} variant="ghost" size="sm" iconLeft="plus" href={full ? undefined : studioNew(g.scope)} disabled={full}
                  title={full ? `The free plan has ${usage?.limit} docs sites per workspace.` : undefined}>
                  New site here
                </Button>
              )}
            </div>
            {g.sites.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {g.sites.map((s) => <SiteCard key={s.id} site={s} />)}
              </div>
            ) : (
              <p className="text-body text-text-muted">
                {g.scope === PERSONAL
                  ? "Sites only you can edit. Create one to try things out."
                  : canCreate ? "No docs sites in this workspace yet."
                  : ws?.your_role === "none" ? "You don't have a Docs Studio role here yet. A Docs Studio admin of this workspace can give you one."
                  : "No docs sites yet. A Docs Studio admin can create one."}
              </p>
            )}
          </section>
        );
      })}

      {all && total > 0 && (
        <section aria-labelledby="docs-usage-h" className="flex flex-wrap gap-4 rounded-xl border border-border bg-surface px-5 py-[18px]">
          <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
            <h2 id="docs-usage-h" className="text-body-strong text-text">Free plan</h2>
            <p className="text-body text-text-secondary">
              {num(all.usage.limit)} sites per workspace, 1,000 pages per site, {num(all.usage.ai_limit ?? FREE_AI)} Ask AI answers a month per site, unlimited editors.{" "}
              <ReadMore topic="studioFaq" />
            </p>
          </div>
          <Meter
            className="min-w-0 flex-[1_1_220px] self-center"
            size="sm"
            label={
              <span className="text-caption text-text-muted">
                Ask AI this month · {num(busiest?.ai_used ?? 0)} of {num(all.usage.ai_limit ?? FREE_AI)}
                {busiest && busiest.ai_used > 0 && total > 1 ? ` (${busiest.name})` : ""}
              </span>
            }
            value={busiest?.ai_used ?? 0}
            max={all.usage.ai_limit ?? FREE_AI}
            threshold={0.9}
            valueText={`${busiest?.ai_used ?? 0} of ${all.usage.ai_limit ?? FREE_AI} answers`}
          />
        </section>
      )}
    </main>
  );
}
