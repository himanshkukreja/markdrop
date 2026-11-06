"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Field, Select, Skeleton, useToast } from "@/components/ui";
import {
  jiraDisconnectSite, jiraIssueTypes, jiraProjects, jiraSetSite, jiraSites, jiraStart, jiraStatus,
  type JiraOption, type JiraProject, type JiraSite, type JiraStatus,
} from "@/lib/jira";
import { JiraMark } from "./JiraMark";

/**
 * Workspace settings › Integrations › Jira. A workspace admin connects the Jira site with their own
 * Atlassian account (Atlassian's consent screen), then picks the site, the default project and issue type
 * for new issues, and which projects feed the Team board (none: Team shows nothing from Jira). Everyone
 * connects their own Atlassian account so issues are created and moved as them (Settings › Account › Jira).
 * Backend: routers/jira.py.
 */
export function JiraWorkspaceCard({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const toast = useToast();
  const [st, setSt] = useState<JiraStatus | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "site" | "me" | "save">("");
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await jiraStatus(id);
      setSt(s);
      setError("");
      // Back from Atlassian (?jira=pick): an admin picks the site and projects next.
      const pick = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("jira") === "pick";
      if (pick && s.can_manage && s.me.connected) setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load Jira's settings.");
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function go(kind: "site" | "me") {
    setBusy(kind);
    try {
      const { url } = await jiraStart({ kind, workspace_id: id, back: kind === "me" ? `/settings/workspaces/${id}?tab=integrations` : null });
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
      setBusy("");
    }
  }

  if (error) {
    return <Alert tone="danger" title="Couldn't load Jira" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{error}</Alert>;
  }
  if (!st) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5" aria-busy="true">
        <Skeleton width="40%" height={18} />
        <Skeleton width="80%" height={14} />
      </div>
    );
  }
  const site = st.site;
  const canConnect = isAdmin && st.configured;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section aria-labelledby="jira-h" data-testid="jira-card" className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-5">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg"><JiraMark /></span>
          <div className="min-w-0 flex-[1_1_280px]">
            <h2 id="jira-h" className="flex flex-wrap items-center gap-2 text-body-strong text-text">
              Jira
              {site ? <Badge tone="success" size="sm" dot data-testid="jira-connected">Connected</Badge> : st.configured ? null : <Badge size="sm">Not set up yet</Badge>}
            </h2>
            <p className="mt-0.5 text-[13px] leading-5 text-text-secondary">
              Create issues from meeting action items, decisions, Team blockers and any text in a page (Markdrop AI drafts them, you
              review), see each person&apos;s tickets on Team, keep linked to-dos and issues in step both ways, and ask about tickets.
              Everything in Jira happens as the person doing it, through their own Atlassian account.
            </p>
          </div>
          {!site && canConnect && !editing && (
            <Button iconLeft="plus" loading={busy === "site"} onClick={() => void (st.me.connected && !st.me.broken ? setEditing(true) : go("site"))} data-testid="jira-connect-site">
              Connect Jira site
            </Button>
          )}
        </div>

        {!st.configured && <p className="text-[13px] text-text-muted">Jira isn&apos;t switched on for this server yet.</p>}
        {st.configured && !site && !isAdmin && <p className="text-[13px] text-text-muted">A workspace admin connects the Jira site here.</p>}

        {editing && isAdmin && (
          <SitePicker id={id} st={st} onCancel={() => setEditing(false)} onSaved={(s) => { setSt(s); setEditing(false); toast.success("Jira is connected to this workspace."); }}
            onReconnect={() => void go("site")} />
        )}

        {site && !editing && (
          <>
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-text-muted">Jira site</dt>
              <dd className="ph-sensitive ph-mask min-w-0 text-text [overflow-wrap:anywhere]" data-testid="jira-site">
                {site.name} <a className="text-accent-text hover:underline" href={site.url} target="_blank" rel="noreferrer">{site.url.replace(/^https:\/\//, "")}</a>
              </dd>
              <dt className="text-text-muted">New issues</dt>
              <dd className="text-text" data-testid="jira-default">{site.default_project} · {site.default_issue_type || "Task"}</dd>
              <dt className="text-text-muted">On Team</dt>
              <dd className="text-text" data-testid="jira-team-projects">{site.projects.length ? site.projects.join(", ") : <span className="text-text-muted">No projects yet</span>}</dd>
              <dt className="text-text-muted">Connected</dt>
              <dd className="text-text">{site.connected_by ? `by ${site.connected_by}` : ""}{site.connected_people ? ` · ${site.connected_people} ${site.connected_people === 1 ? "person has" : "people have"} connected their account` : ""}</dd>
            </dl>
            {site.projects.length === 0 && (
              <Alert tone="info" title="Pick projects for Team">
                Team shows nothing from Jira until {isAdmin ? "you choose" : "an admin chooses"} which projects feed it.
              </Alert>
            )}
            {!site.connector_ok && (
              <Alert tone="warning" title="The admin connection stopped working"
                actions={isAdmin ? <Button size="sm" loading={busy === "site"} onClick={() => void go("site")}>Reconnect</Button> : undefined}>
                Status updates from Jira pause until an admin reconnects the site.
              </Alert>
            )}
            {isAdmin && site.connector_ok && site.webhook.error && (
              <Alert tone="warning" title="Jira didn't accept the updates subscription">{site.webhook.error}</Alert>
            )}
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" iconLeft="edit" onClick={() => (st.me.connected && !st.me.broken ? setEditing(true) : void go("site"))} data-testid="jira-edit">Change projects</Button>
                <Button size="sm" variant="secondary" iconLeft="logOut" onClick={() => setConfirm(true)}>Disconnect Jira…</Button>
              </div>
            )}
          </>
        )}
      </section>

      {st.configured && (
        <section aria-labelledby="jira-me-h" data-testid="jira-me" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-5">
          <div className="flex min-w-0 flex-wrap items-start gap-3">
            <div className="min-w-0 flex-[1_1_280px]">
              <h2 id="jira-me-h" className="text-body-strong text-text">Your Atlassian account</h2>
              <p className="mt-0.5 text-[13px] leading-5 text-text-secondary" data-testid="jira-me-state">
                {st.me.broken ? "Your connection stopped working. Reconnect it."
                  : st.me.connected ? <>Connected{st.me.name ? <> as <strong className="ph-sensitive ph-mask">{st.me.name}</strong></> : null}.{site && !st.me.reaches_site ? " It doesn't reach this workspace's Jira site." : " Issues you create or move are yours in Jira."}</>
                  : "Connect it to create issues, move them by ticking to-dos, and see tickets on Team and in Ask. Markdrop only ever acts as you, with what your Jira lets you do."}
              </p>
            </div>
            {(!st.me.connected || st.me.broken) && (
              <Button size="sm" iconLeft="link" loading={busy === "me"} onClick={() => void go("me")} data-testid="jira-connect-me">
                {st.me.broken ? "Reconnect" : "Connect my Atlassian account"}
              </Button>
            )}
          </div>
          {st.me.connected && (
            <Link href="/settings/account#jira" className="text-[13px] font-medium text-accent-text hover:underline">Manage in Settings › Account</Link>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Disconnect Jira?"
        description={<>Issues stay in Jira, and links on pages stay, but Team, status sync and chips stop for <strong>{site?.name}</strong> until it&apos;s connected again.</>}
        confirmLabel="Disconnect"
        onConfirm={async () => {
          setSt(await jiraDisconnectSite(id));
          setConfirm(false);
          toast.success("Jira is disconnected.");
        }}
      />
    </div>
  );
}

function SitePicker({ id, st, onCancel, onSaved, onReconnect }: {
  id: string; st: JiraStatus; onCancel: () => void; onSaved: (s: JiraStatus) => void; onReconnect: () => void;
}) {
  const toast = useToast();
  const [sites, setSites] = useState<JiraSite[] | null>(null);
  const [cloud, setCloud] = useState(st.site?.cloud_id ?? "");
  const [projects, setProjects] = useState<JiraProject[] | null>(null);
  const [team, setTeam] = useState<string[]>(st.site?.projects ?? []);
  const [def, setDef] = useState(st.site?.default_project ?? "");
  const [types, setTypes] = useState<JiraOption[]>([]);
  const [type, setType] = useState(st.site?.default_issue_type ?? "Task");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    jiraSites(id).then((r) => {
      setSites(r.sites);
      if (!cloud && r.sites.length) setCloud(r.sites[0].id);
    }).catch((e) => setErr(e instanceof Error ? e.message : "Couldn't list your Jira sites."));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cloud) return;
    setProjects(null);
    jiraProjects(id, cloud).then((r) => {
      setProjects(r.projects);
      setDef((d) => d && r.projects.some((p) => p.key === d) ? d : (r.projects[0]?.key ?? ""));
      setTeam((t) => t.filter((k) => r.projects.some((p) => p.key === k)));
    }).catch((e) => setErr(e instanceof Error ? e.message : "Couldn't list the projects."));
  }, [id, cloud]);

  useEffect(() => {
    if (!cloud || !def) return;
    jiraIssueTypes(id, def, cloud).then((r) => {
      setTypes(r.issue_types);
      setType((t) => r.issue_types.some((x) => x.name === t) ? t : (r.issue_types.find((x) => x.name === "Task")?.name ?? r.issue_types[0]?.name ?? "Task"));
    }).catch(() => setTypes([]));
  }, [id, cloud, def]);

  const sorted = useMemo(() => (projects ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  if (err) {
    return <Alert tone="danger" title="Couldn't read your Jira" actions={<><Button size="sm" onClick={onReconnect}>Connect again</Button><Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button></>}>{err}</Alert>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4 border-t border-border pt-4" data-testid="jira-picker">
      {sites === null ? <Skeleton width="60%" height={14} /> : sites.length > 1 ? (
        <div className="max-w-[360px]">
          <Field label="Jira site" hint="The sites your Atlassian account reaches.">
            <Select value={cloud} onChange={(e) => setCloud(e.target.value)} data-testid="jira-site-select"
              options={sites.map((s) => ({ value: s.id, label: `${s.name} (${s.url.replace(/^https:\/\//, "")})` }))} />
          </Field>
        </div>
      ) : sites.length === 1 ? (
        <p className="text-[13px] text-text-secondary">Site: <strong className="text-text">{sites[0].name}</strong> ({sites[0].url.replace(/^https:\/\//, "")})</p>
      ) : <Alert tone="warning">Your Atlassian account doesn&apos;t reach any Jira site.</Alert>}

      {projects === null ? <Skeleton width="50%" height={14} /> : (
        <>
          <div className="grid max-w-[560px] gap-3 sm:grid-cols-2">
            <Field label="Default project for new issues" hint="People can pick another one when they create an issue.">
              <Select value={def} onChange={(e) => setDef(e.target.value)} data-testid="jira-default-project"
                options={sorted.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }))} />
            </Field>
            <Field label="Default issue type">
              <Select value={type} onChange={(e) => setType(e.target.value)} data-testid="jira-default-type"
                options={(types.length ? types : [{ id: "", name: type || "Task" }]).map((t) => ({ value: t.name, label: t.name }))} />
            </Field>
          </div>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-[13px] font-medium text-text">Projects on Team</legend>
            <p className="text-caption text-text-muted">Issues assigned to this workspace&apos;s members in these projects show on Team (updated in the last 30 days). None: Team shows nothing from Jira.</p>
            <div className="grid max-h-[220px] min-w-0 gap-1 overflow-auto sm:grid-cols-2" data-testid="jira-team-projects-pick">
              {sorted.map((p) => (
                <Checkbox key={p.key} label={`${p.name} (${p.key})`} checked={team.includes(p.key)}
                  onChange={(e) => setTeam((t) => e.target.checked ? [...t, p.key] : t.filter((k) => k !== p.key))} />
              ))}
            </div>
          </fieldset>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} disabled={!cloud || !def} data-testid="jira-save-site" onClick={async () => {
          setBusy(true);
          try {
            onSaved(await jiraSetSite({ workspace_id: id, cloud_id: cloud, projects: team, default_project: def || null, default_issue_type: type || null }));
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "That didn't save.");
          } finally { setBusy(false); }
        }}>Save</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
