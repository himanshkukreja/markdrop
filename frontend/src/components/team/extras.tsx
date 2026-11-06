"use client";

/**
 * Team's groups dialog (admins: make, rename, change members, delete; suggestions from who attends which
 * meeting series) and the "This week" card (the weekly summary: highlights, blockers, due this week —
 * only from meetings and pages everyone in the workspace can open).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button, Checkbox, Dialog, Field, Icon, IconButton, Input, Spinner, useToast } from "@/components/ui";
import {
  createGroup, deleteGroup, fmtDay, listGroups, sendWeekly, updateGroup,
  type Card, type Group, type GroupSuggestion, type ThisWeek,
} from "@/lib/team";

export function GroupsDialog({ ws, open, people, onClose, onChanged }: {
  ws: string; open: boolean; people: Card[]; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [sugs, setSugs] = useState<GroupSuggestion[]>([]);
  const [edit, setEdit] = useState<{ id: string | null; name: string; members: Set<string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => listGroups(ws).then((r) => { setGroups(r.groups); setSugs(r.suggestions); }).catch(() => setGroups([]));
  useEffect(() => { if (open) void load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const body = { name: edit.name.trim(), member_ids: [...edit.members] };
      if (edit.id) await updateGroup(ws, edit.id, body); else await createGroup(ws, body);
      setEdit(null); await load(); onChanged();
    } catch (e) { toast.error(e instanceof Error ? e.message : "That didn't save."); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={edit ? (edit.id ? "Edit group" : "New group") : "Groups"} size="md"
      description={edit ? undefined : "Groups let everyone filter Team by team. Only admins make and change them."}
      footer={edit ? (
        <><Button variant="secondary" onClick={() => setEdit(null)}>Back</Button>
          <Button loading={busy} onClick={save} disabled={!edit.name.trim()} data-testid="team-group-save">Save</Button></>
      ) : <Button variant="secondary" onClick={onClose}>Done</Button>}>
      {edit ? (
        <div className="tm-groupedit">
          <Field label="Name" htmlFor="tm-group-name">
            <Input id="tm-group-name" value={edit.name} maxLength={60} onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              placeholder="Sourcing team" data-testid="team-group-name" />
          </Field>
          <fieldset className="tm-groupedit__people">
            <legend>Members</legend>
            {people.map((p) => (
              <Checkbox key={p.id} label={p.name} checked={edit.members.has(p.id)} onChange={(e) => {
                const m = new Set(edit.members); if (e.target.checked) m.add(p.id); else m.delete(p.id);
                setEdit({ ...edit, members: m });
              }} />
            ))}
          </fieldset>
        </div>
      ) : groups === null ? <Spinner /> : (
        <div className="tm-groups">
          {groups.length === 0 && <p className="tm-muted">No groups yet.</p>}
          <ul className="tm-groups__list">
            {groups.map((g) => (
              <li key={g.id}>
                <div className="tm-groups__main"><b>{g.name}</b><span className="tm-muted">{g.member_ids.map((i) => names[i]).filter(Boolean).join(", ") || "No members"}</span></div>
                <IconButton icon="edit" label={`Edit ${g.name}`} onClick={() => setEdit({ id: g.id, name: g.name, members: new Set(g.member_ids) })} />
                <IconButton icon="trash" label={`Delete ${g.name}`} onClick={async () => { await deleteGroup(ws, g.id); await load(); onChanged(); }} />
              </li>
            ))}
          </ul>
          <Button variant="secondary" iconLeft="plus" onClick={() => setEdit({ id: null, name: "", members: new Set() })} data-testid="team-group-new">New group</Button>
          {sugs.length > 0 && (
            <div className="tm-groups__sugs">
              <p className="tm-card__label">Suggested from meeting series</p>
              <ul className="tm-groups__list">
                {sugs.map((s) => (
                  <li key={s.name}>
                    <div className="tm-groups__main"><b>{s.name}</b><span className="tm-muted">{s.member_ids.map((i) => names[i]).filter(Boolean).join(", ")} · {s.meetings} meetings</span></div>
                    <Button size="sm" variant="secondary" onClick={() => setEdit({ id: null, name: s.name, members: new Set(s.member_ids) })} data-testid="team-group-use">Use</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function ThisWeekCard({ week, ws, canSend, onSent }: { week: ThisWeek | null; ws: string; canSend: boolean; onSent: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!week && !canSend) return null;
  const send = async () => {
    setBusy(true);
    try {
      const r = await sendWeekly(ws);
      toast.success(`Sent: ${r.delivery.emails} email${r.delivery.emails === 1 ? "" : "s"}${r.delivery.slack === "posted" ? " and the Slack meetings channel" : ""}.`);
      onSent();
    } catch (e) { toast.error(e instanceof Error ? e.message : "That didn't send."); } finally { setBusy(false); }
  };
  return (
    <section className="tm-week" aria-labelledby="tm-week-h" data-testid="team-this-week">
      <div className="tm-week__head">
        <h2 id="tm-week-h" className="tm-h2"><Icon name="calendar" />This week</h2>
        <span className="tm-muted">{week ? (week.live ? "So far, from what everyone can open" : `Sent ${fmtDay(week.at)}`) : "Goes out Mondays at 9 am"}</span>
        {canSend && <Button size="sm" variant="ghost" iconLeft="send" loading={busy} onClick={send} data-testid="team-week-send" className="tm-week__send">Send now</Button>}
      </div>
      {week ? (
        <div className="tm-week__grid">
          <div>
            <p className="tm-card__label">Highlights</p>
            {week.highlights.length ? <ul className="tm-week__list">{week.highlights.map((h, i) => (
              <li key={i}>{h.text}{h.sources?.[0] && <> <Link href={h.sources[0].href} className="tm-week__src">{h.sources[0].title}</Link></>}</li>))}</ul>
              : <p className="tm-muted">Nothing yet.</p>}
          </div>
          <div>
            <p className="tm-card__label">Due this week</p>
            {week.due.length || week.overdue.length ? <ul className="tm-week__list">
              {week.overdue.map((x, i) => <li key={`o${i}`}><b>{x.person}</b>: {x.text} <span className="tm-due tm-due--overdue"><Icon name="alert" />Overdue · {fmtDay(x.due)}</span></li>)}
              {week.due.map((x, i) => <li key={`d${i}`}><b>{x.person}</b>: {x.text} <span className="tm-due"><Icon name="calendar" />{fmtDay(x.due)}</span></li>)}
            </ul> : <p className="tm-muted">Nothing due.</p>}
            {week.blockers.length > 0 && (<>
              <p className="tm-card__label" style={{ marginTop: 10 }}>Blockers</p>
              <ul className="tm-week__list">{week.blockers.map((b, i) => <li key={i}><b>{b.person}</b>: {b.text}{b.waiting_on ? ` (waiting on ${b.waiting_on})` : ""}</li>)}</ul>
            </>)}
          </div>
        </div>
      ) : <p className="tm-muted">A summary of the week goes to the admins by email, and to the Slack meetings channel when Slack is connected.</p>}
    </section>
  );
}
