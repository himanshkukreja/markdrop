"use client";

import { ReadMore } from "@/components/ReadMore";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Avatar, Badge, Button, Disclosure, EmptyState, Input, SegmentedControl, Select, Skeleton, useToast,
} from "@/components/ui";
import { useLocationSearch } from "@/components/shell/useLocation";
import {
  docsErrorMessage, docsErrorStatus, getStudioHistory, getStudioMembers, roleLabel, setStudioMember,
  type RoleEvent, type StudioMember, type StudioMembersResponse, type StudioRole,
} from "@/lib/docsSites";
import { firstName, plural, timeAgo } from "../format";
import { StudioLoader, useStudioSession } from "../SiteContext";
import { siteBase, studioHome, studioMembers } from "../routes";
import { useStudio } from "../studio/StudioContext";
import { aRole, LockedAdmin, RoleBadge, RoleHistory, RoleSelect, RolesExplainer } from "./roles";

type Filter = "all" | "access" | "none";

const WS_ROLE: Record<string, string> = { owner: "Workspace owner", admin: "Workspace admin", member: "Workspace member", viewer: "Workspace viewer" };

function MemberRow({ m, you, busy, onChange }: { m: StudioMember; you: boolean; busy: boolean; onChange: (r: StudioRole) => void }) {
  const granted = !m.locked && m.role !== "none" && m.granted_at
    ? `${m.granted_by_name === "Markdrop" ? "Carried over from their workspace role" : `Given by ${firstName(m.granted_by_name)}`} · ${timeAgo(m.granted_at)}`
    : null;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 first:border-t-0 sm:px-5">
      <Avatar name={m.name || m.email || "?"} src={m.picture || undefined} size="md" />
      <div className="min-w-0 flex-[1_1_200px]">
        <div className="truncate text-body-strong text-text" dir="auto" title={m.name || undefined}>
          {m.name}
          {you && <span className="font-normal text-text-muted"> (you)</span>}
        </div>
        <div className="truncate text-[12.5px] text-text-muted" title={m.email || undefined}>
          {m.email}{m.email ? " · " : ""}{WS_ROLE[m.workspace_role ?? ""] ?? "Workspace member"}
        </div>
        {(granted || m.site_overrides.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-text-muted">
            {granted && <span>{granted}</span>}
            {m.site_overrides.map((o) => (
              <a key={o.site_id} href={`${siteBase(o.site_id)}/settings#people`} className="md-focus rounded-full no-underline" title={`Their role on ${o.site_name ?? "this site"} only`}>
                <Badge size="sm" variant="outline" icon="layers">{roleLabel(o.role)} on {o.site_name ?? "a site"}</Badge>
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {m.locked ? (
          <LockedAdmin workspaceRole={m.workspace_role} />
        ) : you ? (
          <span title="You can't change your own role. Ask another admin."><RoleBadge role={m.role} size="md" /></span>
        ) : (
          <RoleSelect value={m.role} onChange={onChange} disabled={busy} label={`Docs Studio role for ${m.name}`} />
        )}
      </div>
    </li>
  );
}

/**
 * /docs-studio/members?ws=<id> (Docs Studio › Members): everyone in a workspace with their Docs
 * Studio role, a role select for each (the owner and admins are locked to admin), the per-site
 * overrides, search and a filter, "who can do what", and the history of changes. Studio admins
 * only; anyone else is told who to ask.
 */
export default function StudioMembers() {
  const { ready, user } = useStudioSession("/docs-studio/members");
  const { all } = useStudio();
  const router = useRouter();
  const toast = useToast();
  const search = useLocationSearch();
  const wsParam = new URLSearchParams(search).get("ws") || "";
  const manageable = useMemo(() => (all?.workspaces ?? []).filter((w) => w.can_manage_people), [all]);
  const wsId = wsParam || manageable[0]?.id || "";
  const [data, setData] = useState<StudioMembersResponse | null>(null);
  const [history, setHistory] = useState<RoleEvent[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      const [d, h] = await Promise.all([getStudioMembers(wsId), getStudioHistory(wsId, 30)]);
      setData(d);
      setHistory(h.events);
      setError(null);
    } catch (e) {
      setError({ status: docsErrorStatus(e), message: docsErrorMessage(e, "Couldn't load the members.") });
    }
  }, [wsId]);

  useEffect(() => {
    setData(null);
    setHistory(null);
    if (ready) void load();
  }, [ready, load]);

  async function change(m: StudioMember, role: StudioRole) {
    if (role === m.role) return;
    setBusy(m.user_id);
    try {
      const row = await setStudioMember(wsId, m.user_id, role);
      setData((d) => d && { ...d, members: d.members.map((x) => (x.user_id === m.user_id ? row : x)) });
      toast.success(role === "none" ? `${firstName(m.name)} no longer has access to Docs Studio here.` : `${firstName(m.name)} is now ${aRole(role)}.`);
      void getStudioHistory(wsId, 30).then((h) => setHistory(h.events)).catch(() => {});
    } catch (e) {
      toast.error(docsErrorMessage(e, "Couldn't change the role. Try again."));
    } finally {
      setBusy("");
    }
  }

  if (!ready) return <StudioLoader />;

  const wsName = data?.workspace.name ?? all?.workspaces.find((w) => w.id === wsId)?.name ?? "";
  const q = query.trim().toLowerCase();
  const rows = (data?.members ?? []).filter((m) =>
    (!q || m.name.toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q))
    && (filter === "all" || (filter === "none" ? m.role === "none" : m.role !== "none")));
  const withAccess = data?.members.filter((m) => m.role !== "none").length ?? 0;
  const noAccess = (data?.members.length ?? 0) - withAccess;

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 pb-16 pt-8 outline-none sm:px-6 sm:pt-10">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-1.5">
          <a href={studioHome(wsId || null)} className="md-focus self-start rounded text-[13px] text-text-muted no-underline hover:text-text">← Docs sites</a>
          <h1 className="text-[28px] font-extrabold leading-9 tracking-[-0.02em] text-text">Members</h1>
          <p className="max-w-[680px] text-[15px] leading-6 text-text-secondary">
            Who can do what in {wsName ? <strong className="font-semibold text-text" dir="auto">{wsName}</strong> : "this workspace"}&apos;s docs sites.
            Docs Studio has its own roles: people in the workspace see nothing here until you give them one.{" "}
            <ReadMore topic="studioRoles" />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {manageable.length > 1 && (
            <Select
              aria-label="Workspace"
              className="w-[220px] max-w-full"
              value={wsId}
              onChange={(e) => router.replace(studioMembers(e.target.value))}
              options={manageable.map((w) => ({ value: w.id, label: w.name }))}
            />
          )}
          {wsId && (
            <Button variant="secondary" iconLeft="userPlus" href={`/settings/workspaces/${encodeURIComponent(wsId)}?tab=people`}>
              Invite to the workspace
            </Button>
          )}
        </div>
      </div>

      {!wsId && all && (
        <EmptyState
          icon="users"
          title="No workspace to manage"
          description="Docs Studio admins of a workspace give its members their roles here. You aren't one in any workspace yet."
          actions={<Button variant="secondary" href={studioHome()}>All docs sites</Button>}
        />
      )}

      {error && (error.status === 403 || error.status === 404) && (
        <EmptyState
          icon="lock"
          title={error.status === 403 ? "Only Docs Studio admins manage members" : "That workspace isn't one of yours"}
          description={error.status === 403 ? "Ask an admin of the workspace to change who can do what." : "You may have left it, or it was deleted."}
          actions={<Button variant="secondary" href={studioHome()}>All docs sites</Button>}
        />
      )}
      {error && error.status !== 403 && error.status !== 404 && (
        <Alert tone="danger" title="We couldn't load the members" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{error.message}</Alert>
      )}

      {wsId && !error && (
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <section aria-labelledby="members-h" className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
              <h2 id="members-h" className="text-[16px] font-semibold text-text">
                {data ? plural(data.members.length, "person", "people") : "People"}
              </h2>
              <div className="flex min-w-0 flex-[1_1_260px] flex-wrap items-center justify-end gap-2">
                <SegmentedControl<Filter>
                  size="sm"
                  aria-label="Show"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All" },
                    { value: "access", label: `With access${data ? ` · ${withAccess}` : ""}` },
                    { value: "none", label: `No access${data ? ` · ${noAccess}` : ""}` },
                  ]}
                />
                <Input
                  type="search"
                  aria-label="Search people"
                  placeholder="Search people"
                  wrapClassName="min-w-0 flex-[1_1_180px] sm:max-w-[240px]"
                  prefix="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            {!data ? (
              <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label="Loading members">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rect" height={52} />)}
              </div>
            ) : rows.length === 0 ? (
              <p className="px-5 py-8 text-center text-body text-text-muted">{q ? `No one matches “${query.trim()}”.` : filter === "none" ? "Everyone here has a Docs Studio role." : "No one yet."}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0" aria-label="Members">
                {rows.map((m) => (
                  <MemberRow key={m.user_id} m={m} you={m.user_id === (data.you || user?.id)} busy={busy === m.user_id} onChange={(r) => void change(m, r)} />
                ))}
              </ul>
            )}
          </section>

          <aside className="flex w-full min-w-0 flex-col gap-5 lg:w-[380px] lg:shrink-0">
            <RolesExplainer />
            <section aria-labelledby="history-h" className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface p-4 sm:p-5">
              <Disclosure summary={<span id="history-h" className="text-[15px] font-semibold text-text">Recent changes</span>} defaultOpen>
                <div className="flex flex-col gap-1 pt-2"><RoleHistory events={history} /></div>
              </Disclosure>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
