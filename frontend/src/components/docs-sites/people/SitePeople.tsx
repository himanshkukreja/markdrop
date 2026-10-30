"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  Alert, Avatar, Badge, Button, Dialog, Disclosure, Field, IconButton, Select, Skeleton, useToast,
} from "@/components/ui";
import {
  docsErrorMessage, getSitePeople, getSitePeopleHistory, removeSitePerson, roleLabel, roleSourceLabel, setSitePerson,
  type RoleEvent, type SitePeopleResponse, type SitePerson, type StudioRole,
} from "@/lib/docsSites";
import { firstName, plural, timeAgo } from "../format";
import { studioMembers } from "../routes";
import { useSite } from "../SiteContext";
import { aRole, LockedAdmin, RoleBadge, RoleHistory, RoleSelect } from "./roles";

function Person({ p, you, children, meta }: { p: SitePerson; you: boolean; children?: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border py-2.5 first:border-t-0">
      <Avatar name={p.name || p.email || "?"} src={p.picture || undefined} size="sm" />
      <div className="min-w-0 flex-[1_1_180px]">
        <div className="truncate text-body-strong text-text" dir="auto">
          {p.name}{you && <span className="font-normal text-text-muted"> (you)</span>}
        </div>
        <div className="text-[12.5px] text-text-muted [overflow-wrap:anywhere]">{meta ?? p.email}</div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </li>
  );
}

/**
 * Site › Settings › People (admins of the site): this site's role overrides. Everyone in the
 * workspace has their Docs Studio role from Members; here an admin gives someone a different role
 * on this site only, higher or lower ("No access" hides the site from them), changes or removes
 * it, and sees everyone's resulting role and the history of changes. The workspace owner and
 * admins are always admins. A personal site is its owner's alone.
 */
export function SitePeople() {
  const { site, wsId } = useSite();
  const toast = useToast();
  const uid = useId();
  const [data, setData] = useState<SitePeopleResponse | null>(null);
  const [history, setHistory] = useState<RoleEvent[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const [pickRole, setPickRole] = useState<StudioRole>("editor");
  const [addError, setAddError] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, h] = await Promise.all([getSitePeople(site.id), getSitePeopleHistory(site.id, 20)]);
      setData(d);
      setHistory(h.events);
      setError("");
    } catch (e) {
      setError(docsErrorMessage(e, "Couldn't load the people."));
    }
  }, [site.id]);
  useEffect(() => { void load(); }, [load]);

  const overrides = useMemo(() => (data?.members ?? []).filter((p) => p.override !== null), [data]);
  const candidates = useMemo(() => (data?.members ?? []).filter((p) => p.override === null && !p.locked && p.user_id !== data?.you), [data]);
  const everyone = data?.members ?? [];

  function replace(row: SitePerson) {
    setData((d) => d && { ...d, members: d.members.map((x) => (x.user_id === row.user_id ? row : x)) });
    void getSitePeopleHistory(site.id, 20).then((h) => setHistory(h.events)).catch(() => {});
  }

  async function setRole(p: SitePerson, role: StudioRole) {
    setBusy(p.user_id);
    try {
      replace(await setSitePerson(site.id, p.user_id, role));
      toast.success(role === "none" ? `${firstName(p.name)} can't see ${site.name} now.` : `${firstName(p.name)} is ${aRole(role)} on ${site.name}.`);
    } catch (e) {
      toast.error(docsErrorMessage(e, "Couldn't change the role. Try again."));
    } finally {
      setBusy("");
    }
  }

  async function clear(p: SitePerson) {
    setBusy(p.user_id);
    try {
      const row = await removeSitePerson(site.id, p.user_id);
      replace(row);
      toast.success(`${firstName(p.name)} is back to their workspace role (${roleLabel(row.effective_role)}).`);
    } catch (e) {
      toast.error(docsErrorMessage(e, "Couldn't remove it. Try again."));
    } finally {
      setBusy("");
    }
  }

  async function add() {
    const p = candidates.find((c) => c.user_id === pick);
    if (!p) { setAddError("Choose someone from the workspace."); return; }
    setBusy("add");
    setAddError("");
    try {
      replace(await setSitePerson(site.id, p.user_id, pickRole));
      setAdding(false);
      setPick("");
      toast.success(`${firstName(p.name)} is ${aRole(pickRole)} on ${site.name}.`);
    } catch (e) {
      setAddError(docsErrorMessage(e, "Couldn't add them. Try again."));
    } finally {
      setBusy("");
    }
  }

  if (!wsId) {
    return (
      <p className="text-body text-text-secondary">
        A personal site is yours alone. To write it with others, create it in a workspace instead.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-body text-text-secondary">
        Everyone in the workspace has their Docs Studio role from <a className="text-accent-text underline-offset-2 hover:underline" href={studioMembers(wsId)}>Members</a>.
        Give someone a different role on this site only, higher or lower. No access hides the site from them.
      </p>
      {error && <Alert tone="danger" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{error}</Alert>}
      {!data && !error && <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading people"><Skeleton variant="rect" height={44} /><Skeleton variant="rect" height={44} /></div>}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 text-body-strong text-text">
              {overrides.length ? `Different on this site · ${overrides.length}` : "No one has a different role on this site"}
            </h3>
            <Button variant="secondary" size="sm" iconLeft="userPlus" disabled={!candidates.length}
              title={!candidates.length ? "Everyone who can have one already does." : undefined}
              onClick={() => { setAdding(true); setAddError(""); setPick(candidates[0]?.user_id ?? ""); setPickRole("editor"); }}>
              Add person
            </Button>
          </div>
          {overrides.length > 0 && (
            <ul className="m-0 flex list-none flex-col rounded-lg border border-border px-3" aria-label="Roles on this site">
              {overrides.map((p) => (
                <Person key={p.user_id} p={p} you={p.user_id === data.you}
                  meta={<>Workspace-wide: {roleLabel(p.studio_role)}{p.override_by_name ? ` · set by ${firstName(p.override_by_name)} ${timeAgo(p.override_at)}` : ""}</>}>
                  <RoleSelect value={p.override ?? "none"} onChange={(r) => void setRole(p, r)} disabled={busy === p.user_id || p.user_id === data.you}
                    label={`Role on this site for ${p.name}`} />
                  <IconButton icon="x" size="sm" label={`Remove ${p.name}'s role on this site`} disabled={busy === p.user_id || p.user_id === data.you} onClick={() => void clear(p)} />
                </Person>
              ))}
            </ul>
          )}

          <Disclosure summary={<span className="text-body-strong text-text">Everyone&apos;s role on this site · {plural(everyone.length, "person", "people")}</span>}>
            <ul className="m-0 flex list-none flex-col p-0 pt-1" aria-label="Everyone's role on this site">
              {everyone.map((p) => (
                <Person key={p.user_id} p={p} you={p.user_id === data.you} meta={roleSourceLabel(p.source) || "No Docs Studio role"}>
                  {p.locked ? <LockedAdmin workspaceRole={p.workspace_role} /> : <RoleBadge role={p.effective_role} size="md" />}
                  {p.override !== null && <Badge size="sm" variant="outline">This site</Badge>}
                </Person>
              ))}
            </ul>
          </Disclosure>
          <Disclosure summary={<span className="text-body-strong text-text">History</span>}>
            <div className="flex flex-col gap-1 pt-1"><RoleHistory events={history} empty="No one's role on this site has changed yet." /></div>
          </Disclosure>
        </>
      )}

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={`Give someone a role on ${site.name}`}
        description="For this site only. Their role on the workspace's other sites stays as it is."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" loading={busy === "add"} onClick={() => void add()}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {addError && <Alert tone="danger">{addError}</Alert>}
          <Field label="Person" htmlFor={`${uid}-who`} hint="People in the workspace. To add someone new, invite them to the workspace first.">
            <Select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              options={candidates.map((c) => ({ value: c.user_id, label: `${c.name}${c.email && c.email !== c.name ? ` (${c.email})` : ""} · now ${roleLabel(c.effective_role)}` }))}
            />
          </Field>
          <Field label="Role on this site" htmlFor={`${uid}-role`}>
            <RoleSelect value={pickRole} onChange={setPickRole} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

export default SitePeople;
