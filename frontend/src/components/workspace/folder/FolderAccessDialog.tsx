"use client";

/**
 * "Who can access" a folder (backend services/folder_access.py): its people and teams, whether it is
 * restricted, and what new items start as. Everything inside — pages, files, subfolders, and what is
 * added later — follows. People and teams named on a folder above show here as inherited (read-only).
 * Workspace members see it; admins, the folder's creator and its editors change it (`can_manage`).
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Checkbox, Dialog, Icon, IconButton, Input, Select, Skeleton, Switch, useToast } from "@/components/ui";
import {
  getFolderAccess, putFolderAccess,
  type FolderAccess, type FolderDefault, type FolderRole, type TreeFolder,
} from "@/lib/workspaces";
import { workspaceChanged } from "@/lib/workspaceStore";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_OPTIONS = [{ value: "viewer", label: "Can view" }, { value: "editor", label: "Can edit" }];

type Person = { email: string; role: FolderRole };
type Team = { team_id: string; role: FolderRole };

export default function FolderAccessDialog({
  workspaceId, folder, team, onClose,
}: {
  workspaceId: string;
  /** null: closed. */
  folder: TreeFolder | null;
  /** The workspace's short name ("Acme"), for "Acme team". */
  team: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<FolderAccess | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restricted, setRestricted] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [dflt, setDflt] = useState<string>("inherit");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<FolderRole>("viewer");
  const [pickTeam, setPickTeam] = useState("");
  const [notify, setNotify] = useState(true);

  useEffect(() => {
    if (!folder) return;
    let live = true;
    setData(null);
    setError("");
    setBusy(false);
    getFolderAccess(workspaceId, folder.id)
      .then((d) => {
        if (!live) return;
        setData(d);
        setRestricted(d.restricted_here);
        setPeople(d.people.filter((p) => !p.inherited_from && p.email).map((p) => ({ email: p.email as string, role: p.role })));
        setTeams(d.teams.filter((t) => !t.inherited_from).map((t) => ({ team_id: t.id, role: t.role })));
        setDflt(d.default_access ?? "inherit");
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load who can access this folder."));
    return () => { live = false; };
  }, [workspaceId, folder]);

  const editable = !!data?.can_manage;
  const teamName = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of data?.team_options ?? []) m.set(t.id, t.name);
    for (const t of data?.teams ?? []) m.set(t.id, t.name);
    return m;
  }, [data]);
  const inheritedPeople = data?.people.filter((p) => p.inherited_from) ?? [];
  // Read-only callers don't get other people's addresses: show their names instead.
  const shownPeople: Person[] = editable ? people
    : (data?.people ?? []).filter((p) => !p.inherited_from).map((p) => ({ email: p.email ?? p.name ?? "Someone", role: p.role }));
  const inheritedTeams = data?.teams.filter((t) => t.inherited_from) ?? [];
  const freeTeams = (data?.team_options ?? []).filter((t) => !teams.some((x) => x.team_id === t.id));

  function addPerson() {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) { setError("Enter an email address."); return; }
    setError("");
    setPeople((ps) => [...ps.filter((p) => p.email !== e), { email: e, role }]);
    setEmail("");
  }

  async function save() {
    if (!folder || !data) return;
    setBusy(true);
    setError("");
    try {
      const out = await putFolderAccess(workspaceId, folder.id, {
        restricted, people, teams,
        default_access: dflt === "inherit" ? null : (dflt as FolderDefault),
        notify,
      });
      workspaceChanged(workspaceId);
      const told = Object.keys(out.notified ?? {}).length;
      toast.success(`Saved who can access “${folder.name}”${told ? ` · told ${told} ${told === 1 ? "person" : "people"}` : ""}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That didn't save. Try again.");
      setBusy(false);
    }
  }

  const parentRestricted = !!data?.restricted && !data.restricted_here;

  return (
    <Dialog
      open={!!folder}
      onClose={onClose}
      dismissible={!busy}
      size="lg"
      className="!max-w-[600px]"
      glyph={<Icon name="lock" size={18} />}
      title={folder ? <>Who can access <span className="ph-sensitive ph-mask">“{folder.name}”</span></> : "Who can access"}
      description="Everything inside follows: pages, files, subfolders, and anything added later."
      footer={editable ? (
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} data-testid="folder-access-save">Save</Button>
        </>
      ) : <Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      {!data ? (
        error ? <Alert tone="danger">{error}</Alert> : <div className="flex flex-col gap-3"><Skeleton height={20} /><Skeleton height={56} /><Skeleton height={56} /></div>
      ) : (
        <div className="flex min-w-0 flex-col gap-5" data-testid="folder-access">
          <p className="m-0 text-[13px] leading-5 text-text-secondary">{data.summary}</p>

          <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3.5 py-3">
            <Switch
              checked={restricted || parentRestricted}
              disabled={!editable || parentRestricted}
              onChange={(e) => setRestricted(e.currentTarget.checked)}
              label={<strong className="font-semibold">Restrict to the people and teams below</strong>}
              data-testid="folder-access-restrict"
            />
            <p className="m-0 text-caption text-text-muted">
              {parentRestricted
                ? <>Restricted by <span className="ph-sensitive ph-mask">{data.restricted_by}</span>, so this folder is too.</>
                : <>Others in <span className="ph-sensitive ph-mask">{team}</span> won&apos;t see what&apos;s inside, and public links stop working here. Item owners, people an item was shared with, and workspace admins keep access.</>}
            </p>
          </section>

          <section className="flex flex-col gap-2" aria-label="Teams">
            <h3 className="m-0 text-[13px] font-semibold text-text">Teams</h3>
            {teams.length === 0 && inheritedTeams.length === 0 && (
              <p className="m-0 text-caption text-text-muted">No teams yet. Adding someone to a team gives them everything shared with it.</p>
            )}
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {inheritedTeams.map((t) => (
                <li key={`i-${t.id}`} className="flex items-center gap-2 text-[13px]">
                  <Icon name="users" size={16} />
                  <span className="ph-sensitive ph-mask min-w-0 flex-1 truncate">{t.name} team <span className="text-text-muted">· {t.members} people</span></span>
                  <Badge size="sm">{t.role === "editor" ? "Can edit" : "Can view"}</Badge>
                  <span className="text-caption text-text-muted">from <span className="ph-sensitive ph-mask">{t.inherited_from}</span></span>
                </li>
              ))}
              {teams.map((t) => (
                <li key={t.team_id} className="flex items-center gap-2 text-[13px]">
                  <Icon name="users" size={16} />
                  <span className="ph-sensitive ph-mask min-w-0 flex-1 truncate">{teamName.get(t.team_id) ?? "Team"} team</span>
                  <Select
                    aria-label="Role" value={t.role} disabled={!editable} options={ROLE_OPTIONS} className="!w-auto"
                    onChange={(e) => setTeams((ts) => ts.map((x) => x.team_id === t.team_id ? { ...x, role: e.target.value as FolderRole } : x))}
                  />
                  {editable && <IconButton icon="x" label="Remove team" onClick={() => setTeams((ts) => ts.filter((x) => x.team_id !== t.team_id))} />}
                </li>
              ))}
            </ul>
            {editable && freeTeams.length > 0 && (
              <div className="flex items-center gap-2">
                <Select aria-label="Add a team" value={pickTeam} onChange={(e) => setPickTeam(e.target.value)} className="min-w-0 flex-1"
                  options={[{ value: "", label: "Add a team…" }, ...freeTeams.map((t) => ({ value: t.id, label: `${t.name} (${t.members})` }))]} />
                <Button variant="secondary" disabled={!pickTeam} onClick={() => { setTeams((ts) => [...ts, { team_id: pickTeam, role: "editor" }]); setPickTeam(""); }}>Add</Button>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2" aria-label="People">
            <h3 className="m-0 text-[13px] font-semibold text-text">People</h3>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {inheritedPeople.map((p) => (
                <li key={`i-${p.email ?? p.name}-${p.inherited_from}`} className="flex items-center gap-2 text-[13px]">
                  <Icon name="user" size={16} />
                  <span className="ph-sensitive ph-mask min-w-0 flex-1 truncate">{[p.name, p.email].filter(Boolean).join(" · ")}</span>
                  <Badge size="sm">{p.role === "editor" ? "Can edit" : "Can view"}</Badge>
                  <span className="text-caption text-text-muted">from <span className="ph-sensitive ph-mask">{p.inherited_from}</span></span>
                </li>
              ))}
              {shownPeople.map((p, i) => (
                <li key={`${p.email}-${i}`} className="flex items-center gap-2 text-[13px]">
                  <Icon name="user" size={16} />
                  <span className="ph-sensitive ph-mask min-w-0 flex-1 truncate">{p.email}</span>
                  <Select
                    aria-label="Role" value={p.role} disabled={!editable} options={ROLE_OPTIONS} className="!w-auto"
                    onChange={(e) => setPeople((ps) => ps.map((x) => x.email === p.email ? { ...x, role: e.target.value as FolderRole } : x))}
                  />
                  {editable && <IconButton icon="x" label={`Remove ${p.email}`} onClick={() => setPeople((ps) => ps.filter((x) => x.email !== p.email))} />}
                </li>
              ))}
            </ul>
            {editable && (
              <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); addPerson(); }}>
                <Input type="email" aria-label="Email address" placeholder="name@company.com" value={email}
                  onChange={(e) => setEmail(e.target.value)} className="min-w-0 flex-1" data-testid="folder-access-email" />
                <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as FolderRole)} options={ROLE_OPTIONS} className="!w-auto" />
                <Button type="submit" variant="secondary" disabled={!email.trim()}>Add</Button>
              </form>
            )}
          </section>

          <section className="flex flex-col gap-2" aria-label="New items">
            <h3 className="m-0 text-[13px] font-semibold text-text">New items here start as</h3>
            <Select
              aria-label="New items here start as" value={dflt} disabled={!editable} onChange={(e) => setDflt(e.target.value)}
              options={[
                { value: "inherit", label: restricted || parentRestricted ? "People with access to this folder (default)" : "Same as the workspace" },
                { value: "folder", label: "People with access to this folder" },
                { value: "private", label: "Only people added" },
                { value: "workspace", label: `${team} team` },
                { value: "link", label: "Anyone with the link" },
              ]}
            />
            {(restricted || parentRestricted) && (dflt === "workspace" || dflt === "link") && (
              <p className="m-0 text-caption text-text-muted">While the folder is restricted, that still reaches only its people and teams.</p>
            )}
          </section>

          {editable && (
            <Checkbox checked={notify} onChange={(e) => setNotify(e.currentTarget.checked)}
              label="Tell people I add" description="One email and one notification each, not one per item." />
          )}
          {data.job && data.job.state === "running" && (
            <Alert tone="info">Applying to files: {data.job.done} of {data.job.total} done.</Alert>
          )}
          {data.log.length > 0 && (
            <details className="text-caption text-text-muted">
              <summary className="cursor-pointer">Recent changes</summary>
              <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
                {data.log.map((l, i) => (
                  <li key={i}><span className="ph-sensitive ph-mask">{l.by ?? "Someone"}</span> {l.text} · {new Date(l.at).toLocaleString()}</li>
                ))}
              </ul>
            </details>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}
