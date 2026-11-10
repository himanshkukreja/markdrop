"use client";

/**
 * The Share dialog's "Teams" row (CONTRACT §4.3): which teams and projects an item belongs to (none: company-wide),
 * add it to another team you're in (share to team) or take it out. A page's sub-pages follow it. Hidden when the
 * workspace has no teams you could add it to.
 */
import { useEffect, useState } from "react";
import { Dropdown, Icon, useToast } from "@/components/ui";
import { getItemTeams, setItemTeams, type ItemTeams as Data } from "@/lib/teams";
import { TeamChip } from "./parts";
import "./teams.css";

export default function ItemTeams({ ws, item, onChanged }: { ws: string; item: string; onChanged?: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    getItemTeams(ws, item).then((d) => { if (live) setData(d); }).catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [ws, item]);
  if (!data) return null;
  const { teams, projects, options } = data;
  if (!teams.length && !projects.length && !options.teams.length && !options.projects.length) return null;

  const save = async (team_ids: string[], project_ids: string[], ok: string) => {
    setBusy(true);
    try { setData(await setItemTeams(ws, item, team_ids, project_ids)); toast.success(ok); onChanged?.(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't change its teams"); }
    finally { setBusy(false); }
  };
  const addT = options.teams.filter((t) => !t.general && !data.team_ids.includes(t.id));
  const addP = options.projects.filter((p) => !data.project_ids.includes(p.id));
  const privateIn = teams.filter((t) => t.visibility === "private");
  return (
    <section className="tz-share" aria-labelledby="share-teams-h" data-testid="share-teams">
      <div className="flex items-center justify-between gap-2">
        <h3 id="share-teams-h" className="text-body font-semibold text-text">Teams</h3>
        {data.can_change && (addT.length > 0 || addP.length > 0) && (
          <Dropdown align="right" aria-label="Add to a team"
            trigger={<button type="button" disabled={busy} className="md-focus inline-flex cursor-pointer items-center gap-1 rounded-sm bg-transparent p-0 text-[13px] font-semibold text-accent-text hover:underline" data-testid="share-teams-add"><Icon name="plus" size={14} /> Add to a team</button>}
            items={[
              ...(addT.length ? [{ header: "Teams" }, ...addT.map((t) => ({ label: t.name, icon: t.visibility === "private" ? "lock" : "users", onClick: () => void save([...data.team_ids, t.id], data.project_ids, `Added to ${t.name}`) }))] : []),
              ...(addP.length ? [{ header: "Projects" }, ...addP.map((p) => ({ label: p.name, icon: "layers", onClick: () => void save(data.team_ids, [...data.project_ids, p.id], `Added to ${p.name}`) }))] : []),
            ]} />
        )}
      </div>
      {teams.length || projects.length ? (
        <div className="flex flex-wrap gap-1.5">
          {teams.map((t) => <TeamChip key={t.id} team={t} onRemove={data.can_change && !busy ? () => void save(data.team_ids.filter((x) => x !== t.id), data.project_ids, `Removed from ${t.name}`) : undefined} />)}
          {projects.map((p) => <TeamChip key={p.id} team={p} onRemove={data.can_change && !busy ? () => void save(data.team_ids, data.project_ids.filter((x) => x !== p.id), `Removed from ${p.name}`) : undefined} />)}
        </div>
      ) : <p className="text-caption text-text-muted">In General: everyone in the workspace can find it. Add it to a team to put it in that team&apos;s space.</p>}
      {privateIn.length > 0 && (
        <p className="text-caption text-text-muted">
          {privateIn.map((t) => t.name).join(", ")} {privateIn.length === 1 ? "is" : "are"} private: it shows only in {privateIn.length === 1 ? "that team's" : "those teams'"} space and search.
          People you share it with below, or by link, can still open it.
        </p>
      )}
    </section>
  );
}
