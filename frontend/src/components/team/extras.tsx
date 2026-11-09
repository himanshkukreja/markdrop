"use client";

/**
 * Team's groups dialog (admins: make, rename, change members, delete; suggestions from who attends which
 * meeting series) and the "This week so far" card (Mon–Sun in the workspace's timezone: highlights so far
 * — or, before there are any, as on a Monday morning, last week's, titled "Last week · Nov 2–8" — due this
 * week, overdue from the last two weeks — only from meetings and pages everyone in the workspace can
 * open). Desktop: three equal columns; tablets 2 + 1; phones stacked. A person with 3+ rows in a
 * section is one expandable row ("Gautam · 4 items"). Blockers live in the board's "at a glance".
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar, Button, Checkbox, Dialog, Field, Icon, IconButton, Input, Spinner, useToast } from "@/components/ui";
import {
  createGroup, deleteGroup, dueWhen, firstName, fmtDay, listGroups, sendWeekly, updateGroup, weekRange,
  type Card, type Group, type GroupSuggestion, type Status, type ThisWeek, type WeekItem, type WeekPerson,
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

type Src = NonNullable<Status["source"]>;
interface Row { key: string; person: WeekPerson | null; text: string; src: Src | null; when?: { text: string; late?: boolean } }

const SHOW = { highlights: 5, due: 5, overdue: 3 } as const;

/** "Daily Syncup · Oct 27": the meeting or page a line came from. */
function SrcLink({ src }: { src: Src | null }) {
  if (!src) return null;
  const day = src.date ? fmtDay(src.date) : "";
  const label = day && !src.title.includes(day) ? `${src.title} · ${day}` : src.title;
  return <Link href={src.href} className="tm-wk__src" title={label}><Icon name={src.kind === "meeting" ? "mic" : "doc"} /><span>{label}</span></Link>;
}

function WeekRow({ row, showWho = true }: { row: Row; showWho?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`tm-wk__row${open ? " is-open" : ""}`} data-testid="team-week-row">
      {showWho && (row.person ? <Avatar name={row.person.name} src={row.person.avatar_url ?? undefined} size="sm" className="tm-wk__av" />
        : <span className="tm-wk__av tm-wk__av--none" aria-hidden />)}
      <div className="tm-wk__body">
        <button type="button" className="tm-wk__text" title={row.text} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {showWho && row.person && <b className="tm-wk__who">{firstName(row.person.name)}</b>}
          <span className="tm-wk__line">{row.text}</span>
        </button>
        {(row.src || row.when) && (
          <div className="tm-wk__meta">
            {row.when && <span className={`tm-wk__when${row.when.late ? " tm-wk__when--late" : ""}`}>{row.when.late && <Icon name="clock" />}{row.when.text}</span>}
            <SrcLink src={row.src} />
          </div>
        )}
      </div>
    </li>
  );
}

/** One person with 3+ rows in a section: "Gautam · 4 items", expandable. */
function PersonGroup({ person, rows }: { person: WeekPerson; rows: Row[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="tm-wk__group" data-testid="team-week-group">
      <button type="button" className="tm-wk__ghead" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Avatar name={person.name} src={person.avatar_url ?? undefined} size="sm" className="tm-wk__av" />
        <span className="tm-wk__gname"><b>{firstName(person.name)}</b> · {rows.length} items</span>
        <Icon name={open ? "chevronUp" : "chevronDown"} className="tm-wk__chev" />
      </button>
      {open ? <ul className="tm-wk__sub">{rows.map((r) => <WeekRow key={r.key} row={r} showWho={false} />)}</ul>
        : <p className="tm-wk__peek">{rows[0]!.text}</p>}
    </li>
  );
}

function WeekSection({ id, title, icon, tone, rows, show, empty }: {
  id: string; title: string; icon: string; tone?: "late"; rows: Row[]; show: number; empty: string;
}) {
  const [all, setAll] = useState(false);
  // Group a person's rows when they have 3 or more here (kept where their first row was).
  const counts = new Map<string, number>();
  for (const r of rows) if (r.person) counts.set(r.person.id, (counts.get(r.person.id) ?? 0) + 1);
  const items: Array<{ key: string; person?: WeekPerson; rows: Row[] }> = [];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.person && (counts.get(r.person.id) ?? 0) >= 3) {
      let g = groups.get(r.person.id);
      if (!g) { g = []; groups.set(r.person.id, g); items.push({ key: `g${r.person.id}`, person: r.person, rows: g }); }
      g.push(r);
    } else items.push({ key: r.key, rows: [r] });
  }
  const shown = all ? items : items.slice(0, show);
  return (
    <section className={`tm-wk__col${tone ? ` tm-wk__col--${tone}` : ""}`} aria-labelledby={`tm-wk-${id}`} data-testid={`team-week-${id}`}>
      <h3 id={`tm-wk-${id}`} className="tm-wk__h"><Icon name={icon} />{title}<span className="tm-wk__count">{rows.length}</span></h3>
      {rows.length === 0 ? <p className="tm-wk__empty">{empty}</p> : (
        <>
          <ul className={`tm-wk__list${all ? " is-all" : ""}`}>
            {shown.map((it) => it.person ? <PersonGroup key={it.key} person={it.person} rows={it.rows} /> : <WeekRow key={it.key} row={it.rows[0]!} />)}
          </ul>
          {items.length > show && (
            <button type="button" className="tm-wk__more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? "Show less" : tone === "late" ? `Show ${items.length - show} more` : `Show all (${items.length})`}
            </button>
          )}
        </>
      )}
    </section>
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
  const highlights: Row[] = (week?.highlights ?? []).map((h, i) => ({ key: `h${i}`, person: h.person, text: h.text, src: h.sources?.[0] ?? null }));
  const commit = (x: WeekItem, late: boolean): Row => ({ key: x.id, person: x.person, text: x.text, src: x.source ?? null,
    when: { text: dueWhen(x), late: late || x.days < 0 } });
  const due = (week?.due ?? []).map((x) => commit(x, false));
  const overdue = (week?.overdue ?? []).map((x) => commit(x, true));
  // Before anything happened this week (a Monday morning) the highlights are last week's: say so.
  const lastWeek = week?.window === "last_week" && !!week.highlights_from && !!week.highlights_to;
  return (
    <section className="tm-week" aria-labelledby="tm-week-h" data-testid="team-this-week">
      <div className="tm-week__head">
        <h2 id="tm-week-h" className="tm-week__title"><Icon name="calendar" />This week so far{week && <span className="tm-week__range"> · {weekRange(week.from, week.to)}</span>}</h2>
        <span className="tm-week__note">{week ? (week.live ? "From what everyone can open" : `Summary sent ${fmtDay(week.at)}`) : "Summary goes out Mondays at 9 am"}</span>
        {canSend && <Button size="sm" variant="secondary" iconLeft="send" loading={busy} onClick={send} data-testid="team-week-send" className="tm-week__send">Send now</Button>}
      </div>
      {week ? (
        <div className="tm-wk">
          <WeekSection id="highlights" title={lastWeek ? `Last week · ${weekRange(week.highlights_from!, week.highlights_to!)}` : "Highlights so far"}
            icon="sparkle" rows={highlights} show={SHOW.highlights} empty={lastWeek ? "No highlights last week." : "No highlights yet this week."} />
          <WeekSection id="due" title="Due this week" icon="calendar" rows={due} show={SHOW.due} empty="Nothing due this week." />
          <WeekSection id="overdue" title="Overdue" icon="clock" tone="late" rows={overdue} show={SHOW.overdue} empty="Nothing overdue." />
        </div>
      ) : <p className="tm-muted">Every Monday, a summary of last week's highlights and this week's due items goes to the admins by email, and to the Slack meetings channel when Slack is connected.</p>}
    </section>
  );
}
