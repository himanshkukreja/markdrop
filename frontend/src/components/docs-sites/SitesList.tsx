"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, EmptyState, Meter, Skeleton, type Tone } from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import { ReadMore } from "@/components/ReadMore";
import { useAuth } from "@/contexts/AuthContext";
import { can, getWorkspace, type Workspace } from "@/lib/workspaces";
import {
  docsErrorMessage, isAdminRole, listSites, presetName, primaryAddress, type DocsRole, type SiteSummary, type Usage,
} from "@/lib/docsSites";
import { firstName, num, plural, timeAgo } from "./format";
import SiteThumb from "./SiteThumb";
import { docsListHref, siteBase } from "./SiteContext";

const FREE_SITES = 3;
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

function SiteCard({ wsId, site }: { wsId: string; site: SiteSummary }) {
  const st = statusOf(site);
  const base = siteBase(wsId, site.id);
  const address = primaryAddress(site);
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <SiteThumb preset={site.preset} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 px-[18px] pb-[18px] pt-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-6 text-text" dir="auto">{site.name}</h2>
          <Badge tone={st.tone} size="sm" dot>{st.label}</Badge>
        </div>
        <code className="font-mono text-[12.5px] text-text-secondary [overflow-wrap:anywhere]">{address}</code>
        <p className="text-[13px] leading-5 text-text-muted">{metaOf(site)}</p>
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Button variant="secondary" size="sm" iconLeft="edit" href={base}>
            {site.your_role === "viewer" ? "Open" : "Open editor"}
          </Button>
          {site.status === "live" && (
            <Button variant="ghost" size="sm" iconRight="external" href={`https://${address}`} target="_blank">View site</Button>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * /w/<ws>/docs (Main board, "Docs sites in a workspace"): the workspace's documentation sites as
 * cards (theme thumbnail, status, address, last publish), "New docs site" for admins, and the free
 * plan's usage: sites used and Ask AI answers this month.
 */
export default function SitesList({ wsId }: { wsId: string }) {
  const { user, loading: authLoading } = useAuth();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [sites, setSites] = useState<SiteSummary[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [role, setRole] = useState<DocsRole | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [w, r] = await Promise.all([getWorkspace(wsId).catch(() => null), listSites(wsId)]);
      setWs(w);
      setSites(r.sites);
      setUsage(r.usage ?? null);
      setRole(r.your_role ?? null);
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't load this workspace's docs sites."));
    }
  }, [wsId]);

  useEffect(() => {
    if (!authLoading && user) void load();
  }, [authLoading, user, load]);

  const isAdmin = role ? isAdminRole(role) : ws ? can(ws.role, "admin") : false;
  // Ask AI is allowed per site: show the busiest site against its own allowance.
  const busiest = sites?.reduce<SiteSummary | null>((m, s) => (!m || s.ai_used > m.ai_used ? s : m), null) ?? null;
  const limit = usage?.limit ?? FREE_SITES;
  const used = usage?.sites ?? sites?.length ?? 0;
  const atLimit = used >= limit;
  const newHref = `${docsListHref(wsId)}/new`;

  const newButton = isAdmin ? (
    <Button variant="primary" iconLeft="plus" href={atLimit ? undefined : newHref} disabled={atLimit} title={atLimit ? `The free plan has ${limit} docs sites per workspace.` : undefined}>
      New docs site
    </Button>
  ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        eyebrow={ws?.name}
        title="Docs sites"
        description="Documentation websites your team writes here and publishes to their own address, with search, Ask AI and a changelog built in."
        actions={newButton}
      />

      {error && (
        <Alert tone="danger" title="We couldn't load the docs sites" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>
          {error}
        </Alert>
      )}

      {!sites && !error && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading docs sites">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-surface pb-4">
              <Skeleton variant="rect" height={132} />
              <div className="flex flex-col gap-2 px-4"><Skeleton width="60%" /><Skeleton width="80%" /><Skeleton width="70%" /></div>
            </div>
          ))}
        </div>
      )}

      {sites && sites.length === 0 && (
        <EmptyState
          icon="layers"
          title="No docs sites yet"
          description={isAdmin
            ? "Start blank, from a template, or bring your GitBook docs across. Nothing is public until you publish."
            : "When an admin of this workspace creates a docs site, it shows up here."}
          actions={newButton}
        />
      )}

      {sites && sites.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sites.map((s) => <SiteCard key={s.id} wsId={wsId} site={s} />)}
        </div>
      )}

      {sites && (
        <section aria-labelledby="docs-usage-h" className="flex flex-wrap gap-4 rounded-xl border border-border bg-surface px-5 py-[18px]">
          <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1">
            <h2 id="docs-usage-h" className="text-body-strong text-text">Free plan</h2>
            <p className="text-body text-text-secondary">
              {num(limit)} sites per workspace, 1,000 pages per site, {num(usage?.ai_limit ?? FREE_AI)} Ask AI answers a month per site, unlimited editors.{" "}
              <ReadMore topic="limits" />
            </p>
          </div>
          <Meter
            className="min-w-0 flex-[1_1_220px] self-center"
            size="sm"
            label={<span className="text-caption text-text-muted">Sites · {num(used)} of {num(limit)}</span>}
            value={used}
            max={limit}
            threshold={1}
            valueText={`${used} of ${limit} sites`}
          />
          <Meter
            className="min-w-0 flex-[1_1_220px] self-center"
            size="sm"
            label={
              <span className="text-caption text-text-muted">
                Ask AI this month · {num(busiest?.ai_used ?? 0)} of {num(usage?.ai_limit ?? FREE_AI)}
                {busiest && busiest.ai_used > 0 && sites && sites.length > 1 ? ` (${busiest.name})` : ""}
              </span>
            }
            value={busiest?.ai_used ?? 0}
            max={usage?.ai_limit ?? FREE_AI}
            threshold={0.9}
            valueText={`${busiest?.ai_used ?? 0} of ${usage?.ai_limit ?? FREE_AI} answers`}
          />
        </section>
      )}
    </div>
  );
}
