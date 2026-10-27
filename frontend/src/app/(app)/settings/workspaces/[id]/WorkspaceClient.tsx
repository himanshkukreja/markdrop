"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Breadcrumb, Button, EmptyState, IconButton, Tabs, Alert } from "@/components/ui";
import { useLocationSearch } from "@/components/shell/useLocation";
import { BrandTile, type BrandingWithWell } from "@/components/workspace/BrandTile";
import { accentTokens } from "@/components/tenant/branding";
import { useAuth } from "@/contexts/AuthContext";
import {
  can, getWorkspace, libraryCounts, listDomains, listFolders, listInvitations, listMembers,
  type Domain, type Folder, type Invitation, type Member, type Workspace,
} from "@/lib/workspaces";
import { SettingsLoader, plural, shortDate, useRequireUser } from "../../settings-shared";
import { ROLE_LABEL, TAB_IDS, TAB_NEEDS, type Resource, type TabId, type WsTabProps } from "./ws-shared";
import GeneralTab from "./tabs/GeneralTab";
import BrandTab from "./tabs/BrandTab";
import DomainsTab from "./tabs/DomainsTab";
import PeopleTab from "./tabs/PeopleTab";
import FoldersTab from "./tabs/FoldersTab";
import styles from "./workspace.module.css";

function tabFromSearch(search: string): TabId {
  const t = new URLSearchParams(search).get("tab");
  return (TAB_IDS as string[]).includes(t ?? "") ? (t as TabId) : "general";
}

/**
 * /settings/workspaces/[id] (REVAMP_PLAN 7.12): header on a flat accent band, then line tabs
 * General · Brand · Domains · People · Folders, synced to `?tab=` (no useSearchParams: the query is
 * read after mount and written with history.replaceState). The library lives in the dashboard
 * (D11): "Open library" goes to /dashboard?ws=<id>.
 *
 * Loading stays lazy and per resource. This page used to fetch domains, members, invitations,
 * folders and the library on mount — roughly sixteen requests with their CORS preflights before
 * anyone clicked. The API sits behind a per-IP rate limit with a burst of twenty, so two page loads
 * spent the whole budget and everything after that came back 503. Counts live on the workspace
 * response, and each collection loads with the first tab that shows it, once.
 */
export default function WorkspaceClient({ id }: { id: string }) {
  const { ready } = useRequireUser(`/settings/workspaces/${id}`);
  const { user } = useAuth();
  const search = useLocationSearch();
  const tab = tabFromSearch(search);

  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadingWs, setLoadingWs] = useState(true);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[] | null>(null);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [folderCounts, setFolderCounts] = useState<Record<string, number> | null>(null);
  const [tabError, setTabError] = useState("");
  // Resources already fetched (or in flight), so switching back is free.
  const fetched = useRef<Set<Resource>>(new Set());
  // Tabs visited at least once stay mounted (hidden), so a half-edited Brand form survives a peek at People.
  const roleRef = useRef<Workspace["role"] | undefined>(undefined);
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set());

  const loadWs = useCallback(async () => {
    try {
      const w = await getWorkspace(id);
      roleRef.current = w.role;
      setWs(w);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load this workspace.");
    } finally {
      setLoadingWs(false);
    }
  }, [id]);

  const loadResources = useCallback(async (wanted: Resource[], force = false) => {
    const todo = wanted.filter((r) => force || !fetched.current.has(r));
    if (todo.length === 0) return;
    todo.forEach((r) => fetched.current.add(r));
    try {
      await Promise.all(todo.map(async (r) => {
        if (r === "domains") setDomains(await listDomains(id));
        else if (r === "folders") setFolders(await listFolders(id));
        else if (r === "folderCounts") setFolderCounts(await libraryCounts(id).catch(() => ({})));
        else if (r === "people") {
          // Invitations are admin-only on the API; don't spend a request on a guaranteed 403.
          const admin = can(roleRef.current, "admin");
          const [m, i] = await Promise.all([
            listMembers(id),
            admin ? listInvitations(id).catch(() => [] as Invitation[]) : Promise.resolve([] as Invitation[]),
          ]);
          setMembers(m);
          setInvites(i);
        }
      }));
      setTabError("");
    } catch (e) {
      todo.forEach((r) => fetched.current.delete(r)); // must stay retryable
      setTabError(e instanceof Error ? e.message : "Couldn't load this part of the workspace.");
    }
  }, [id]);

  const refresh = useCallback(async (...resources: Resource[]) => {
    await Promise.all([loadWs(), loadResources(resources, true)]);
  }, [loadWs, loadResources]);

  useEffect(() => {
    if (ready) loadWs();
  }, [ready, loadWs]);

  useEffect(() => {
    if (!ws) return;
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)));
    loadResources(TAB_NEEDS[tab]);
  }, [ws, tab, loadResources]);

  if (!ready || (loadingWs && !ws)) return <SettingsLoader label="Loading workspace" />;

  if (!ws) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <Breadcrumb items={[{ label: "Settings", href: "/settings" }, { label: "Workspaces", href: "/settings/workspaces" }, { label: "Workspace" }]} />
        <h1 className="md-visually-hidden">Workspace</h1>
        <EmptyState
          icon="alertCircle"
          title="We couldn't open this workspace"
          description={loadError ? `${loadError} It may have been deleted, or you may no longer be a member.` : "It may have been deleted, or you may no longer be a member."}
          actions={<Button variant="secondary" href="/settings/workspaces" iconLeft="arrowLeft">All workspaces</Button>}
        />
      </div>
    );
  }

  const b = ws.branding as BrandingWithWell;
  // The workspace's chosen address, falling back to the oldest verified one — the same order the
  // server uses, so the link shown here is the link sent. Before domains load, the server's own
  // pick (primary_host) stands in.
  const host =
    (domains
      ? domains.find((d) => d.status === "verified" && d.kind === "app" && d.is_primary)?.host
        ?? domains.find((d) => d.status === "verified" && d.kind === "app")?.host
      : null) ?? ws.primary_host ?? null;
  const isOwner = ws.role === "owner";
  const isAdmin = can(ws.role, "admin");
  const isMember = can(ws.role, "member");
  const accentFill = accentTokens(b.accent_color)?.accent;

  const setTab = (t: TabId) => {
    const url = new URL(window.location.href);
    if (t === "general") url.searchParams.delete("tab");
    else url.searchParams.set("tab", t);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  };

  const tabProps: WsTabProps = {
    id, ws, isOwner, isAdmin, isMember, meId: user?.id ?? null, host,
    domains, members, invites, folders, folderCounts, refresh, setWs,
  };

  const counts = [
    plural(ws.member_count, "member"),
    ws.pending_invite_count > 0 ? `${ws.pending_invite_count} invited` : null,
    plural(ws.domain_count, "domain"),
    `Created ${shortDate(ws.created_at)}`,
  ].filter(Boolean).join(" · ");

  const panels: Record<TabId, React.ReactNode> = {
    general: <GeneralTab {...tabProps} />,
    brand: <BrandTab {...tabProps} />,
    domains: <DomainsTab {...tabProps} />,
    people: <PeopleTab {...tabProps} />,
    folders: <FoldersTab {...tabProps} />,
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section
        aria-labelledby="ws-title"
        className={`${styles.band} flex min-w-0 flex-col gap-4 px-4 py-4 sm:px-6 sm:py-5`}
        style={accentFill ? ({ "--ws-accent": accentFill } as React.CSSProperties) : undefined}
      >
        <Breadcrumb items={[{ label: "Settings", href: "/settings" }, { label: "Workspaces", href: "/settings/workspaces" }, { label: ws.name }]} />
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="flex min-w-0 flex-[1_1_18rem] items-center gap-4">
            <BrandTile name={ws.name} logoUrl={b.logo_url} logoWell={b.logo_well} accent={b.accent_color} size={48} className="self-start sm:self-center" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                <h1 id="ws-title" className="text-h1 text-text [overflow-wrap:anywhere]" dir="auto">{ws.name}</h1>
                <Badge tone={isOwner ? "info" : "neutral"} icon="user">{ROLE_LABEL[ws.role] ?? ws.role}</Badge>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                {host && (
                  <Badge tone="success" dot className="max-w-full">
                    <span className="truncate font-mono">{host}</span>
                  </Badge>
                )}
                <span className="text-caption text-text-secondary">{counts}</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" iconLeft="folder" href={`/w/${encodeURIComponent(id)}`}>
              Open workspace
            </Button>
            {host && (
              <IconButton icon="external" label={`Visit ${host}`} href={`https://${host}`} target="_blank" rel="noreferrer noopener" />
            )}
          </div>
        </div>
      </section>

      <div className="min-w-0 px-1">
        <Tabs
          aria-label="Workspace settings"
          idPrefix="ws"
          variant="line"
          value={tab}
          onChange={(v) => setTab(v as TabId)}
          items={[
            { value: "general", label: "General", icon: "settings" },
            { value: "brand", label: "Brand", icon: "palette" },
            { value: "domains", label: "Domains", icon: "globe", count: ws.domain_count },
            { value: "people", label: "People", icon: "users", count: ws.member_count + ws.pending_invite_count },
            { value: "folders", label: "Folders", icon: "folder", count: folders?.length },
          ]}
        />
      </div>

      {!isAdmin && (
        <Alert tone="info">
          You can view this workspace. Changing branding, domains or people needs the admin role.
        </Alert>
      )}
      {tabError && (
        <Alert tone="danger" title="Couldn't load this tab" actions={<Button size="sm" variant="secondary" onClick={() => { setTabError(""); loadResources(TAB_NEEDS[tab], true); }}>Try again</Button>}>
          {tabError}
        </Alert>
      )}

      {TAB_IDS.map((t) => (visited.has(t) || t === tab) && (
        <div
          key={t}
          role="tabpanel"
          id={`ws-panel-${t}`}
          aria-labelledby={`ws-tab-${t}`}
          hidden={t !== tab}
          tabIndex={-1}
          className="min-w-0 outline-none"
        >
          {panels[t]}
        </div>
      ))}
    </div>
  );
}
