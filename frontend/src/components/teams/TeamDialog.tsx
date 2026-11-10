"use client";

/**
 * New team / Team settings (nav redesign 2026-11-10, prototype "dialog-new-team" / "dialog-team-settings"): the
 * icon and name on one row (Emoji / Icons picker with colours; "Remove icon" falls back to the first letter), a
 * description, Open / Private as two cards (with the plain note that workspace admins see every team), leads and
 * members as chips (Lead / Member toggle, add by name or email), and Slack / Jira "optional, later". Esc closes,
 * Enter in the name or ⌘↵ anywhere saves. On phones it is a bottom sheet. General (the default team) can only be
 * renamed (icon, colour, description, leads): it is always open and everyone is in it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Button, ConfirmDialog, Dialog, Icon, cx, useToast } from "@/components/ui";
import { TEAM_GLYPHS } from "@/components/ui/teamGlyphs";
import { useAuth } from "@/contexts/AuthContext";
import type { Member } from "@/lib/workspaces";
import {
  TEAM_COLORS, addTeamMembers, createTeam, deleteTeam, generalHref, removeTeamMember, setTeamLeads, teamTint, updateTeam,
  type TeamCard, type TeamColor, type TeamFull, type Visibility,
} from "@/lib/teams";
import { TeamTile, useWorkspaceMembers } from "./parts";
import { Integrations } from "./TeamSettings";
import "./teams.css";

const EMOJI = ["🚀", "💼", "📈", "🤝", "🛠️", "🎨", "📣", "💡", "🧪", "🧭", "🏛️", "🌍", "⚙️", "📦", "🧑‍💻", "🎯", "🔒", "💬", "📚", "🏆",
  "🧲", "🌱", "🔥", "⭐", "🎧", "📊", "🧾", "🛡️", "✈️", "🏥", "🎓", "🧱", "🦄", "🐙", "🍀", "☕"];

interface PersonRow { id: string; lead: boolean }

export function TeamDialog({ ws, wsName, open, team, onClose, onSaved }: {
  ws: string; wsName?: string; open: boolean;
  /** Team settings (edit) when given; New team otherwise. */
  team?: TeamFull | null;
  onClose: () => void; onSaved: (t: TeamCard | TeamFull) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const { user } = useAuth();
  const members = useWorkspaceMembers(ws);
  const edit = !!team;
  const general = !!team?.general;
  const canAdmin = edit ? !!team!.can_admin : true;
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [color, setColor] = useState<TeamColor>("violet");
  const [desc, setDesc] = useState("");
  const [vis, setVis] = useState<Visibility>("open");
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [picker, setPicker] = useState(false);
  const [tab, setTab] = useState<"emoji" | "icons">("emoji");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const iconBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setPicker(false); setQ(""); setSel(0);
    if (team) {
      setName(team.name); setIcon(team.icon); setColor(team.color); setDesc(team.description || ""); setVis(team.visibility);
      setPeople(general ? team.members.filter((m) => m.role === "lead").map((m) => ({ id: m.id, lead: true }))
        : team.members.map((m) => ({ id: m.id, lead: m.role === "lead" })));
      setTab(team.icon?.startsWith("glyph:") ? "icons" : "emoji");
    } else {
      setName(""); setIcon(null); setColor("violet"); setDesc(""); setVis("open"); setTab("emoji");
      setPeople(user ? [{ id: user.id, lead: true }] : []);
    }
  }, [open, team, general, user]);

  const byId = useMemo(() => new Map((members ?? []).map((m) => [m.user_id, m])), [members]);
  const nameOf = (id: string) => { const m = byId.get(id); return m?.name || m?.email || (team?.members.find((x) => x.id === id)?.name ?? "Someone"); };
  const suggestions = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || !members) return [];
    const have = new Set(people.map((p) => p.id));
    return members.filter((m) => !have.has(m.user_id) && `${m.name ?? ""} ${m.email ?? ""}`.toLowerCase().includes(t)).slice(0, 6);
  }, [q, members, people]);
  useEffect(() => setSel(0), [q]);

  const add = (m: Member) => { setPeople((p) => [...p, { id: m.user_id, lead: false }]); setQ(""); };
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const leads = people.filter((p) => p.lead).map((p) => p.id);
      if (!team) {
        const t = await createTeam(ws, { name: name.trim(), icon, color, description: desc.trim(), visibility: vis,
          lead_ids: leads.length ? leads : user ? [user.id] : [], member_ids: people.map((p) => p.id) });
        toast.success(`${t.name} is ready`);
        onSaved(t);
        return;
      }
      let t: TeamFull = await updateTeam(ws, team.id, {
        name: name.trim(), icon, color, description: desc.trim(),
        ...(canAdmin && !general && vis !== team.visibility ? { visibility: vis } : {}),
      });
      if (!general && team.can_manage) {
        const before = new Set(team.members.map((m) => m.id));
        const after = new Set(people.map((p) => p.id));
        const added = [...after].filter((id) => !before.has(id));
        if (added.length) t = await addTeamMembers(ws, team.id, added);
        for (const id of [...before].filter((x) => !after.has(x))) t = await removeTeamMember(ws, team.id, id);
      }
      const beforeLeads = team.members.filter((m) => m.role === "lead").map((m) => m.id).sort().join(",");
      if (canAdmin && leads.length && leads.slice().sort().join(",") !== beforeLeads) t = await setTeamLeads(ws, team.id, leads);
      toast.success("Saved");
      onSaved(t);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : team ? "Couldn't save" : "Couldn't create the team");
    } finally {
      setBusy(false);
    }
  };

  // ⌘↵ / Ctrl+Enter saves from anywhere in the dialog (captured first, so a focused button isn't pressed too).
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void submitRef.current(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const preview = { name: name.trim() || "New team", icon, color };
  const glyphs = Object.keys(TEAM_GLYPHS);
  const memberCount = members?.length ?? team?.member_count ?? 0;

  return (
    <Dialog open={open} onClose={() => { if (picker) { setPicker(false); iconBtn.current?.focus(); return; } onClose(); }} size="lg"
      dismissible={!busy} className="tz-dlg" initialFocus={nameRef}
      title={edit ? "Team settings" : "New team"}
      description={edit ? (general ? `${team!.name} is your workspace’s default team — everyone is in it.` : "Changes apply for everyone in the team.")
        : "A space for a group’s pages, files, meetings and memory."}
      footer={
        <>
          <span className="tz-dlg__kbd max-sm:hidden"><kbd>Esc</kbd> to close · <kbd>⌘</kbd><kbd>↵</kbd> to {edit ? "save" : "create"}</span>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!name.trim()} data-testid={edit ? "save-team" : "create-team"}>{edit ? "Save changes" : "Create team"}</Button>
        </>
      }>
      <div className="tz-dlg__body">
        <div className="tz-fld">
          <label htmlFor="tz-name" className="tz-lb">Icon &amp; name</label>
          <div className="tz-namerow">
            <button ref={iconBtn} type="button" className="tz-iconbtn md-focus" aria-label="Choose icon" aria-expanded={picker} aria-controls="tz-picker"
              onClick={() => setPicker((v) => !v)} data-testid="team-icon">
              <TeamTile team={preview} size={30} />
              <span className="tz-iconbtn__edit" aria-hidden><Icon name="edit" size={10} /></span>
            </button>
            <input ref={nameRef} id="tz-name" className="tz-inp" value={name} maxLength={60} autoComplete="off" placeholder="e.g. Sales, Engineering, Design"
              onChange={(e) => setName(e.target.value)} data-testid="team-name"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }} />
          </div>
        </div>

        {picker && (
          <div className="tz-picker" id="tz-picker" role="group" aria-label="Choose an icon" data-testid="icon-picker"
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setPicker(false); iconBtn.current?.focus(); } }}>
            <div className="tz-pk-tabs" role="tablist" aria-label="Icon kind">
              <button type="button" role="tab" aria-selected={tab === "emoji"} onClick={() => setTab("emoji")}><Icon name="smile" size={13} /> Emoji</button>
              <button type="button" role="tab" aria-selected={tab === "icons"} onClick={() => setTab("icons")}><Icon name="grid" size={13} /> Icons</button>
            </div>
            <div className="tz-pk-grid" role="tabpanel">
              {tab === "emoji" ? EMOJI.map((e) => (
                <button key={e} type="button" aria-label={e} aria-pressed={icon === e} onClick={() => setIcon(e)}>{e}</button>
              )) : glyphs.map((g) => {
                const G = TEAM_GLYPHS[g]!;
                return <button key={g} type="button" aria-label={g} aria-pressed={icon === `glyph:${g}`} onClick={() => setIcon(`glyph:${g}`)}><G size={18} strokeWidth={1.75} aria-hidden /></button>;
              })}
            </div>
            <div className="tz-lb tz-lb--sm">Colour</div>
            <div className="tz-pk-sw" role="radiogroup" aria-label="Colour">
              {TEAM_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Colour ${c}`} title={c}
                  style={{ ["--c" as string]: teamTint(c) }} onClick={() => setColor(c)} />
              ))}
            </div>
            <div className="tz-pk-f">
              <Button size="sm" variant="ghost" iconLeft="x" disabled={!icon} onClick={() => { setIcon(null); setPicker(false); iconBtn.current?.focus(); }}>Remove icon</Button>
              <span className="tz-muted flex-1 text-caption">Uses the first letter</span>
              <Button size="sm" variant="secondary" onClick={() => { setPicker(false); iconBtn.current?.focus(); }}>Done</Button>
            </div>
          </div>
        )}

        <div className="tz-fld">
          <label htmlFor="tz-desc" className="tz-lb">Description <span>· optional, shown in Browse teams</span></label>
          <textarea id="tz-desc" className="tz-inp" rows={2} maxLength={280} placeholder="What this team works on" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>

        <div className="tz-fld">
          <span className="tz-lb" id="tz-vis">Who can see it</span>
          <div className="tz-vis" role="radiogroup" aria-labelledby="tz-vis">
            {(["open", "private"] as const).map((v) => {
              const off = (general && v === "private") || (edit && !canAdmin && v !== vis);
              return (
                <button key={v} type="button" role="radio" aria-checked={vis === v} aria-disabled={off || undefined} className="tz-vopt md-focus"
                  onClick={() => { if (!off) setVis(v); }} data-testid={`vis-${v}`}>
                  <span className="tz-radio" aria-hidden />
                  <span className="min-w-0">
                    <b><Icon name={v === "open" ? "globe" : "lock"} size={14} /> {v === "open" ? "Open" : "Private"}</b>
                    <span>{v === "open" ? `Anyone in ${wsName || "the workspace"} can find, read and join it.` : "Only members see its content. Others see its name and brief."}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="tz-note" data-testid="admins-note">
            <Icon name="shield" size={16} />
            <span>{general ? "The default team is always open and can be renamed, not deleted. " : ""}Workspace admins can see every team’s content, including private teams.</span>
          </p>
        </div>

        <div className="tz-fld">
          <span className="tz-lb" id="tz-people">Leads &amp; members <span>· leads add and remove people</span></span>
          <div className="tz-mbox" aria-labelledby="tz-people">
            <div className="tz-mchips">
              {people.map((p) => (
                <span key={p.id} className="tz-mchip">
                  <Avatar name={nameOf(p.id)} size="sm" />
                  <span className="tz-mchip__name">{nameOf(p.id).split(" ")[0]}{p.id === user?.id ? " (you)" : ""}</span>
                  <button type="button" className={cx("tz-role", p.lead && "tz-role--lead")} disabled={!canAdmin} title="Switch between lead and member"
                    aria-label={`${nameOf(p.id)}: ${p.lead ? "lead" : "member"}. Switch.`}
                    onClick={() => setPeople((all) => all.map((x) => (x.id === p.id ? { ...x, lead: !x.lead } : x)))}>{p.lead ? "Lead" : "Member"}</button>
                  {!general && (
                    <button type="button" className="tz-x" aria-label={`Remove ${nameOf(p.id)}`} disabled={edit && !team!.can_manage}
                      onClick={() => setPeople((all) => all.filter((x) => x.id !== p.id))}><Icon name="x" size={12} /></button>
                  )}
                </span>
              ))}
              {general ? (
                <span className="tz-muted text-caption">+ everyone in {wsName || "the workspace"} ({memberCount})</span>
              ) : (!edit || team!.can_manage) ? (
                <input className="tz-mq" placeholder="Add people by name or email" autoComplete="off" aria-label="Add people" value={q}
                  role="combobox" aria-expanded={suggestions.length > 0} aria-controls="tz-sugg" data-testid="team-add-people"
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, suggestions.length - 1)); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
                    else if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); const m = suggestions[sel]; if (m) add(m); }
                    else if (e.key === "Backspace" && !q && people.length) setPeople((all) => all.slice(0, -1));
                  }} />
              ) : null}
            </div>
            {q.trim() && (
              <ul className="tz-sugg" id="tz-sugg" role="listbox" aria-label="People">
                {suggestions.length ? suggestions.map((m, i) => (
                  <li key={m.user_id} role="option" aria-selected={i === sel}>
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(m)}>
                      <Avatar name={m.name || m.email || "?"} size="sm" />
                      <span className="min-w-0"><span className="tz-sugg__t">{m.name || m.email}</span>{m.name && <span className="tz-sugg__s">{m.email}</span>}</span>
                    </button>
                  </li>
                )) : <li className="tz-sugg__none">No one in the workspace matches. Invite them in Workspace settings first.</li>}
              </ul>
            )}
          </div>
        </div>

        <details className="tz-later">
          <summary><Icon name="chevronRight" size={13} /> Connect Slack and Jira <span className="tz-muted">· optional, you can do this later</span></summary>
          {edit && team!.can_manage ? (
            <div className="pt-3"><Integrations ws={ws} team={team!} onSaved={(t) => onSaved(t)} bare /></div>
          ) : (
            <>
              <div className="tz-lrow"><Icon name="hash" size={16} /><span className="flex-1">Post meeting summaries and the weekly brief to a Slack channel</span><span className="tz-muted text-caption">After creating</span></div>
              <div className="tz-lrow"><Icon name="checkSquare" size={16} /><span className="flex-1">Default Jira project for issues from this team’s meetings</span><span className="tz-muted text-caption">After creating</span></div>
            </>
          )}
        </details>

        {edit && !general && team!.can_admin && (
          <div className="tz-danger">
            <span className="min-w-0 flex-1"><b>Delete team</b><br /><span className="tz-muted">Its pages, files and meetings move to General (or stay in their other teams).</span></span>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
          </div>
        )}
      </div>
      {edit && (
        <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} tone="danger" title={`Delete ${team!.name}?`} confirmLabel="Delete team"
          description="Nothing inside is deleted: its content moves to General (or stays in its other teams). This can't be undone."
          onConfirm={async () => {
            try { await deleteTeam(ws, team!.id); toast.success("Team deleted"); onClose(); router.push(generalHref(ws)); }
            catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't delete"); }
          }} />
      )}
    </Dialog>
  );
}

