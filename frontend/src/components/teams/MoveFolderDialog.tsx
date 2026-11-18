"use client";

/**
 * "Move to team…" on a folder in a team's Files & pages (backend services/folder_move.py; 2026-11-19). Pick the
 * team, see what moves and what happens to who can open it (the server's preview: pages, documents and files;
 * workspace-visible → that team only; private stays private; people it was shared with keep it; public links keep
 * working, listed), confirm. Big folders finish in the background: the dialog shows the progress and may be closed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Dialog, Field, Icon, Progress, Select, Skeleton, useToast } from "@/components/ui";
import { browseTeams, folderMoveJob, moveFolderToTeam, previewFolderMove, type FolderMoveJob, type FolderMovePreview, type TeamCard } from "@/lib/teams";
import { refreshTree } from "@/lib/workspaceStore";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export interface MoveFolderTarget { id: string; name: string }

export function MoveFolderDialog({ ws, folder, fromTeam, onClose, admin }: {
  ws: string; folder: MoveFolderTarget | null; fromTeam: Pick<TeamCard, "id" | "name">; onClose: () => void;
  /** Workspace admin: every team; else the teams you're in. */
  admin: boolean;
}) {
  const open = !!folder;
  const toast = useToast();
  const [teams, setTeams] = useState<TeamCard[] | null>(null);
  const [team, setTeam] = useState("");
  const [plan, setPlan] = useState<FolderMovePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<FolderMoveJob | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setTeam(""); setPlan(null); setError(null); setJob(null); setBusy(false);
    browseTeams(ws).then((r) => setTeams(r.teams)).catch(() => setTeams([]));
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [open, ws]);

  const options = useMemo(() => (teams ?? [])
    .filter((t) => t.id !== fromTeam.id && t.can_read && (admin || !!t.my_role || !!t.general))
    .sort((a, b) => Number(!!b.general) - Number(!!a.general) || a.name.localeCompare(b.name)), [teams, fromTeam.id, admin]);

  useEffect(() => {
    if (!open || !folder || !team) { setPlan(null); return; }
    let live = true;
    setPlan(null); setError(null);
    previewFolderMove(ws, folder.id, team)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Couldn't check this move."); });
    return () => { live = false; };
  }, [open, ws, folder, team]);

  const finish = (name: string) => {
    refreshTree(ws, 0);
    toast.success(`Moved “${folder?.name}” to ${name}`);
    onClose();
  };
  const poll = (name: string) => {
    if (!folder) return;
    timer.current = window.setTimeout(() => {
      folderMoveJob(ws, folder.id).then(({ job: j }) => {
        setJob(j);
        if (!j || j.state === "done") finish(name);
        else poll(name);
      }).catch(() => poll(name));
    }, 1200);
  };
  const submit = async () => {
    if (!folder || !plan) return;
    setBusy(true); setError(null);
    try {
      const out = await moveFolderToTeam(ws, folder.id, team);
      if (out.job?.state === "running") { setJob(out.job); refreshTree(ws, 0); poll(out.to_team.name); }
      else finish(out.to_team.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't move the folder.");
      setBusy(false);
    }
  };

  const c = plan?.counts;
  const to = plan?.to_team.name ?? "the team";
  const moving = !!job && job.state === "running";
  const what = c ? [c.pages && plural(c.pages, "page"), c.documents && plural(c.documents, "document"), c.files && plural(c.files, "file")].filter(Boolean).join(", ") : "";

  return (
    <Dialog open={open} onClose={onClose} size="md" className="tz-dialog" dismissible={!busy || moving}
      title={folder ? `Move “${folder.name}” to another team` : "Move to team"}
      description={`The folder and everything in it leave ${fromTeam.name}'s Files & pages.`}
      glyph={<Icon name="folder" />}
      footer={moving ? <Button variant="ghost" onClick={onClose}>Close — it keeps going</Button> : (
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!plan?.can_move} data-testid="move-folder-confirm">
            {plan ? `Move to ${to}` : "Move"}
          </Button>
        </>
      )}>
      <div className="flex flex-col gap-4" data-testid="move-folder-dialog">
        <Field label="Move to">
          <Select value={team} onChange={(e) => setTeam(e.target.value)} disabled={busy || !teams} data-testid="move-folder-team">
            <option value="" disabled>{teams ? (options.length ? "Choose a team" : "No other team you're in") : "Loading teams…"}</option>
            {options.map((t) => <option key={t.id} value={t.id}>{t.name}{t.visibility === "private" && !t.general ? " (private)" : ""}</option>)}
          </Select>
        </Field>

        {team && !plan && !error && <Skeleton variant="rect" height={132} />}

        {plan && c && (
          <>
            <p className="m-0 text-body text-text">
              <strong>{what || "No items"}</strong>
              {c.folders > 1 ? ` in ${plural(c.folders, "folder")}` : ""} will move to <strong>{to}</strong>.
            </p>
            <ul className="tz-move__list" aria-label="What happens to access">
              <li><Icon name="users" size={16} />
                <span><strong>{c.workspace_to_team.toLocaleString()}</strong> visible to the whole workspace become visible to {to} only
                  {plan.to_team_open && <span className="tz-muted"> ({to} is an open team: everyone in the workspace can still view them)</span>}</span></li>
              <li><Icon name="lock" size={16} /><span><strong>{c.private.toLocaleString()}</strong> private stay private</span></li>
              <li><Icon name="userPlus" size={16} /><span><strong>{c.shared_with_people.toLocaleString()}</strong> shared with people: those people keep access</span></li>
              <li><Icon name="link" size={16} />
                <span><strong>{c.public_links.toLocaleString()}</strong> public {c.public_links === 1 ? "link keeps" : "links keep"} working
                  {c.public_links > 0 && <span className="tz-muted"> — anyone who has the link can still open it</span>}</span></li>
              {(c.team_grants_repointed > 0 || plan.keeps_inherited_rule) && (
                <li><Icon name="shield" size={16} />
                  <span>Folder access moves with it{c.team_grants_repointed > 0 ? `: ${fromTeam.name}'s access now goes to ${to}` : ""}
                    {plan.keeps_inherited_rule ? `${c.team_grants_repointed > 0 ? "; " : ": "}the restriction it had from its parent folder is kept` : ""}</span></li>
              )}
              {c.projects_dropped > 0 && (
                <li><Icon name="layers" size={16} /><span>Taken out of {plural(c.projects_dropped, "project")} not linked to {to}</span></li>
              )}
            </ul>
            {(plan.public_links.length > 0 || plan.folder_links.length > 0) && (
              <details className="tz-move__links" open={c.public_links <= 5}>
                <summary>Public links that keep working</summary>
                <ul>
                  {plan.folder_links.map((n) => <li key={`f:${n}`}><Icon name="folder" size={14} /><span>{n} <span className="tz-muted">(folder link)</span></span></li>)}
                  {plan.public_links.map((l) => (
                    <li key={l.slug}><Icon name={l.kind === "file" ? "doc" : "lines"} size={14} />
                      <a href={`/${encodeURIComponent(l.slug)}`} target="_blank" rel="noreferrer">{l.title || l.slug}</a>
                      {l.password && <span className="tz-muted"> · password</span>}</li>
                  ))}
                  {plan.public_links_more > 0 && <li className="tz-muted">and {plan.public_links_more.toLocaleString()} more you can&apos;t open</li>}
                </ul>
              </details>
            )}
            {plan.moves_to_top && (
              <p className="tz-muted m-0">Its parent folder stays in {fromTeam.name}, so it moves to the top of the workspace. Old addresses redirect.</p>
            )}
            {plan.background && !moving && <p className="tz-muted m-0">A big folder: the items move in the background after you confirm.</p>}
            {!plan.can_move && (
              <Alert tone="neutral" icon="lock">
                {plan.same_team ? `It's already in ${to}.` : `Only workspace admins, or a lead of ${fromTeam.name} who is also in ${to}, can move it.`}
              </Alert>
            )}
          </>
        )}
        {moving && job && (
          <Progress value={job.done} max={job.total || 1} label={`Moving items to ${to}`} meta={`${job.done.toLocaleString()} / ${job.total.toLocaleString()}`} />
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

export default MoveFolderDialog;
