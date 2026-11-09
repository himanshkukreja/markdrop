"use client";

/**
 * /w/<ws>/teams-review (admins): the one-time guided review. Nothing moved when teams arrived (everything stayed
 * company-wide); this suggests moving meetings (by attendees / series), pages (by author / folder) and folders into
 * teams. Each row starts on its suggestion; the admin changes or unticks rows, applies, and marks the review done.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Checkbox, EmptyState, Select, Skeleton, Tabs, useToast } from "@/components/ui";
import { applyReview, browseHref, finishReview, getReview, getTeams, type ReviewMove, type TeamCard, type TeamsReview as Review } from "@/lib/teams";
import { TeamTile, fmtShortDate } from "./parts";
import { Crumbs } from "./TeamHome";
import "./teams.css";

type Kind = ReviewMove["kind"];
interface Row { kind: Kind; id: string; title: string; sub: string; reason: string; team: string }

const REASON: Record<string, string> = { attendees: "From who attended", series: "Same series as earlier meetings", author: "From who wrote it", folder: "From its folder" };

export default function TeamsReview({ ws }: { ws: string }) {
  const toast = useToast();
  const router = useRouter();
  const [data, setData] = useState<Review | null>(null);
  const [teams, setTeams] = useState<TeamCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Kind>("meeting");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([getReview(ws), getTeams(ws)]).then(([r, s]) => { setData(r); setTeams(s.teams); })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the review."));
  }, [ws]);

  const rows = useMemo<Record<Kind, Row[]>>(() => {
    if (!data) return { meeting: [], page: [], folder: [] };
    return {
      meeting: data.meetings.map((m) => ({ kind: "meeting", id: m.id, title: m.title || "Meeting", sub: [fmtShortDate(m.date), m.series, m.attendees.slice(0, 4).join(", ")].filter(Boolean).join(" · "), reason: m.reason, team: m.suggest[0] ?? "" })),
      page: data.pages.map((p) => ({ kind: "page", id: p.id, title: p.title || p.slug, sub: [p.owner?.name, p.folder?.name].filter(Boolean).join(" · "), reason: p.reason, team: p.suggest[0] ?? "" })),
      folder: data.folders.map((f) => ({ kind: "folder", id: f.id, title: f.name, sub: `${f.item_count} items`, reason: f.reason, team: f.suggest[0] ?? "" })),
    };
  }, [data]);
  const key = (r: Row) => `${r.kind}:${r.id}`;
  const teamOf = (r: Row) => picked[key(r)] ?? r.team;
  const isOn = (r: Row) => on[key(r)] ?? !!r.team;
  const moves = useMemo(() => (["meeting", "page", "folder"] as Kind[]).flatMap((k) => rows[k].filter((r) => isOn(r) && teamOf(r)).map((r) => ({ kind: r.kind, id: r.id, team_ids: [teamOf(r)] }))),
    [rows, picked, on]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="tz-page"><Alert tone="danger">{error}</Alert></div>;
  if (!data) return <div className="tz-page" aria-busy="true"><Skeleton variant="text" width={260} height={32} /><Skeleton variant="rect" height={300} className="mt-6" /></div>;
  const total = rows.meeting.length + rows.page.length + rows.folder.length;
  const list = rows[tab];
  const done = async () => { await finishReview(ws).catch(() => undefined); router.push(browseHref(ws)); };
  return (
    <div className="tz-page" data-testid="teams-review">
      <Crumbs ws={ws} trail={[{ label: "Teams", href: browseHref(ws) }, { label: "Sort content into teams" }]} />
      <header className="tz-head">
        <div className="tz-head__titles">
          <h1 className="tz-title">Sort content into teams</h1>
          <p className="tz-sub">Everything stayed company-wide when teams arrived. These are suggestions from who attended, who wrote it and where it&apos;s filed. Change or untick any row; nothing moves until you apply.</p>
        </div>
      </header>
      {teams.length === 0 ? (
        <EmptyState icon="users" title="Create a team first" description="Suggestions point at teams. Make one, then come back." actions={<Button href={`${browseHref(ws)}?create=1`}>New team</Button>} />
      ) : total === 0 ? (
        <EmptyState icon="checkCircle" title="Nothing to sort" description="No company-wide meetings, pages or folders look like they belong to a team."
          actions={<Button onClick={done}>Finish review</Button>} />
      ) : (
        <div className="tz-review">
          <Tabs value={tab} onChange={(v) => setTab(v as Kind)} aria-label="What to sort"
            items={[{ value: "meeting", label: `Meetings (${rows.meeting.length})` }, { value: "page", label: `Pages (${rows.page.length})` }, { value: "folder", label: `Folders (${rows.folder.length})` }]} />
          <section className="tz-card tz-card--flush">
            {list.length === 0 ? <p className="tz-empty">No suggestions here.</p> : (
              <ul className="m-0 list-none p-0">
                {list.map((r) => (
                  <li key={key(r)} className="tz-rv">
                    <Checkbox checked={isOn(r) && !!teamOf(r)} onChange={(e) => setOn((o) => ({ ...o, [key(r)]: e.target.checked }))} aria-label={`Move ${r.title}`} />
                    <div className="min-w-0">
                      <div className="tz-row__title" dir="auto">{r.title}</div>
                      <div className="tz-row__sub">{[r.sub, REASON[r.reason] ?? null].filter(Boolean).join(" · ")}</div>
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      {teamOf(r) && <TeamTile team={teams.find((t) => t.id === teamOf(r)) ?? { name: "?" }} size={18} />}
                      <Select aria-label={`Team for ${r.title}`} value={teamOf(r)} className="min-w-0"
                        onChange={(e) => { const v = e.target.value; setPicked((p) => ({ ...p, [key(r)]: v })); setOn((o) => ({ ...o, [key(r)]: !!v })); }}
                        options={[{ value: "", label: "Keep company-wide" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="tz-bar">
            <span className="tz-muted">{moves.length ? `${moves.length} ${moves.length === 1 ? "item" : "items"} will move` : "Nothing selected"}</span>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={done}>Finish without moving</Button>
              <Button loading={busy} disabled={!moves.length} data-testid="review-apply" onClick={async () => {
                setBusy(true);
                try {
                  const r = await applyReview(ws, moves);
                  toast.success(`Moved ${r.applied} ${r.applied === 1 ? "item" : "items"}`);
                  setData(await getReview(ws)); setPicked({}); setOn({});
                } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't apply"); }
                finally { setBusy(false); }
              }}>Apply {moves.length || ""}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
