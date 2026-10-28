"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Anchor, Breadcrumb, Button, EmptyState, Icon, Tabs } from "@/components/ui";
import { useLocationSearch } from "@/components/shell/useLocation";
import { WorkspaceTile } from "@/components/shell/SideNav";
import { useAuth } from "@/contexts/AuthContext";
import {
  can, getWorkspace, listDomains, listInvitations, listMembers,
  type Domain, type Invitation, type Member, type Workspace,
} from "@/lib/workspaces";
import { useWorkspaceTree } from "@/lib/workspaceStore";
import { SettingsLoader, plural, useRequireUser } from "../../settings-shared";
import { OLD_TABS, TAB_IDS, TAB_NEEDS, type Resource, type TabId, type WsTabProps } from "./ws-shared";
import PeopleTab from "./tabs/PeopleTab";
import LookTab from "./tabs/LookTab";
import AdvancedTab from "./tabs/AdvancedTab";

/** `?tab=` → a tab; old names map onto the new ones; "folders" opens the folder view. */
function tabFromSearch(search: string): TabId | "folders" {
  const t = new URLSearchParams(search).get("tab") ?? "";
  if ((TAB_IDS as string[]).includes(t)) return t as TabId;
  return OLD_TABS[t] ?? "people";
}

/**
 * /settings/workspaces/[id] (simpler UI, Settings board): "Back to {workspace}", the workspace's tile,
 * name and one line of facts, then three tabs — People · Look and domain · Advanced — synced to
 * `?tab=` (read after mount, written with history.replaceState). Old tab names still work:
 * general/brand/domains → Look and domain, people → People, folders → the workspace's folder view.
 *
 * Loading stays lazy and per resource (the API has a per-IP burst limit): counts live on the
 * workspace response, and each collection loads with the first tab that shows it, once.
 */
export default function WorkspaceClient({ id }: { id: string }) {
  const { ready } = useRequireUser(`/settings/workspaces/${id}`);
  const { user } = useAuth();
  const router = useRouter();
  const search = useLocationSearch();
  const wanted = tabFromSearch(search);
  const tab: TabId = wanted === "folders" ? "people" : wanted;

  // ?tab=folders: folders are managed in the workspace itself now.
  useEffect(() => {
    if (wanted === "folders") router.replace(`/w/${encodeURIComponent(id)}`);
  }, [wanted, id, router]);

  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadingWs, setLoadingWs] = useState(true);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[] | null>(null);
  const [tabError, setTabError] = useState("");
  const fetched = useRef<Set<Resource>>(new Set());
  const roleRef = useRef<Workspace["role"] | undefined>(undefined);
  // Tabs visited at least once stay mounted (hidden), so a half-edited form survives a peek elsewhere.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set());
  const { tree } = useWorkspaceTree(ready ? id : null);

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

  const loadResources = useCallback(async (wantedRes: Resource[], force = false) => {
    const todo = wantedRes.filter((r) => force || !fetched.current.has(r));
    if (todo.length === 0) return;
    todo.forEach((r) => fetched.current.add(r));
    try {
      await Promise.all(todo.map(async (r) => {
        if (r === "domains") setDomains(await listDomains(id));
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
        <Breadcrumb items={[{ label: "My files", href: "/dashboard" }, { label: "Workspace settings" }]} />
        <h1 className="md-visually-hidden">Workspace</h1>
        <EmptyState
          icon="alertCircle"
          title="We couldn't open this workspace"
          description={loadError ? `${loadError} It may have been deleted, or you may no longer be a member.` : "It may have been deleted, or you may no longer be a member."}
          actions={<Button variant="secondary" href="/dashboard" iconLeft="arrowLeft">Back to My files</Button>}
        />
      </div>
    );
  }


  // The workspace's chosen address, falling back to the oldest verified one — the same order the
  // server uses. Before domains load, the server's own pick (primary_host) stands in.
  const host =
    (domains
      ? domains.find((d) => d.status === "verified" && d.kind === "app" && d.is_primary)?.host
        ?? domains.find((d) => d.status === "verified" && d.kind === "app")?.host
      : null) ?? ws.primary_host ?? null;
  const isOwner = ws.role === "owner";
  const isAdmin = can(ws.role, "admin");
  const isMember = can(ws.role, "member");

  const setTab = (t: TabId) => {
    const url = new URL(window.location.href);
    if (t === "people") url.searchParams.delete("tab");
    else url.searchParams.set("tab", t);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  };

  const tabProps: WsTabProps = {
    id, ws, isOwner, isAdmin, isMember, meId: user?.id ?? null, host,
    domains, members, invites, refresh, setWs,
  };

  const facts = [
    plural(ws.member_count, "person", "people"),
    tree ? plural(tree.folders.length, "folder") : null,
    host,
  ].filter(Boolean).join(" · ");

  const panels: Record<TabId, React.ReactNode> = {
    people: <PeopleTab {...tabProps} />,
    look: <LookTab {...tabProps} />,
    advanced: <AdvancedTab {...tabProps} />,
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Anchor href={`/w/${encodeURIComponent(id)}`} className="md-focus inline-flex items-center gap-1.5 self-start rounded-sm text-[13px] font-medium text-accent-text no-underline hover:underline">
        <Icon name="chevronLeft" size={14} /> Back to {ws.name}
      </Anchor>
      <div className="flex min-w-0 items-center gap-3.5">
        <WorkspaceTile ws={ws} active size={44} />
        <div className="min-w-0">
          <h1 className="text-h1 text-text [overflow-wrap:anywhere]" dir="auto">{ws.name}</h1>
          <p className="mt-0.5 text-[13px] text-text-muted">{facts}</p>
        </div>
      </div>

      <Tabs
        aria-label="Settings sections"
        idPrefix="ws"
        variant="line"
        value={tab}
        onChange={(v) => setTab(v as TabId)}
        items={[
          { value: "people", label: "People", icon: "user", count: ws.member_count + ws.pending_invite_count },
          { value: "look", label: "Look and domain", icon: "globe" },
          { value: "advanced", label: "Advanced", icon: "settings" },
        ]}
      />

      {!isAdmin && (
        <Alert tone="info">You can see this workspace&apos;s settings. Changing them needs the Admin role.</Alert>
      )}
      {tabError && (
        <Alert tone="danger" title="Couldn't load this tab" actions={<Button size="sm" variant="secondary" onClick={() => { setTabError(""); loadResources(TAB_NEEDS[tab], true); }}>Try again</Button>}>
          {tabError}
        </Alert>
      )}

      {TAB_IDS.map((t) => (
        <div
          key={t}
          role="tabpanel"
          id={`ws-panel-${t}`}
          aria-labelledby={`ws-tab-${t}`}
          hidden={t !== tab}
          tabIndex={-1}
          className="min-w-0 outline-none"
        >
          {(visited.has(t) || t === tab) ? panels[t] : null}
        </div>
      ))}
    </div>
  );
}
