"use client";

/** Small pieces every Teams view shares: the team's tile, its visibility, the admins note, pickers. */
import { useEffect, useMemo, useState } from "react";
import { Avatar, Badge, Checkbox, Icon, Input, cx } from "@/components/ui";
import { listMembers, type Member } from "@/lib/workspaces";
import { TEAM_GLYPHS } from "@/components/ui/lucide";
import { TEAM_COLORS, teamTint, type TeamCard, type TeamColor, type Visibility } from "@/lib/teams";
import "./teams.css";

type Tileable = { name: string; icon?: string | null; color?: TeamColor | string | null };

/** The team's tile: its emoji on its colour's wash, else its initial in its colour. */
export function TeamTile({ team, size = 18, className }: { team: Tileable; size?: number; className?: string }) {
  const raw = team.icon?.trim() || "";
  // "glyph:<name>": a Lucide icon from the New team dialog's Icons tab (components/ui/lucide TEAM_GLYPHS).
  const Glyph = raw.startsWith("glyph:") ? TEAM_GLYPHS[raw.slice(6)] : undefined;
  const emoji = Glyph ? "" : raw.startsWith("glyph:") ? "" : raw;
  const style = { width: size, height: size, fontSize: emoji ? Math.round(size * 0.68) : Math.max(10, Math.round(size * 0.56)), borderRadius: Math.max(4, Math.round(size * 0.28)), ["--tz-c" as string]: teamTint(team.color as TeamColor) };
  return (
    <span className={cx("tz-tile", emoji && "tz-tile--emoji", Glyph && "tz-tile--glyph", className)} style={style} aria-hidden>
      {Glyph ? <Glyph size={Math.round(size * 0.58)} strokeWidth={2} aria-hidden /> : emoji || (team.name.trim().charAt(0).toUpperCase() || "?")}
    </span>
  );
}

/** "Open" / "Private" with its glyph (never colour alone). */
export function VisibilityBadge({ v, size = "sm" }: { v: Visibility; size?: "sm" | "md" }) {
  return v === "private"
    ? <Badge size={size} tone="neutral" icon="lock">Private</Badge>
    : <Badge size={size} tone="info" icon="globe">Open</Badge>;
}

/** A team name as a chip (search hits, meeting cards, the share dialog). */
export function TeamChip({ team, onRemove }: { team: Tileable & { id?: string }; onRemove?: () => void }) {
  return (
    <span className="tz-chip">
      <TeamTile team={team} size={14} />
      <span>{team.name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove from ${team.name}`} className="md-focus -mr-1 grid size-5 cursor-pointer place-items-center rounded-full bg-transparent text-text-muted hover:text-text">
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

/** Said plainly wherever a team is private (settings, create, docs): admins can still see it. */
export function AdminsNote() {
  return (
    <p className="tz-note" data-testid="admins-note">
      <Icon name="shield" size={16} />
      <span>Workspace admins can see this team&apos;s content. Everyone else sees only its name and weekly brief.</span>
    </p>
  );
}

/** What Open and Private mean, as radio descriptions. */
export const VISIBILITY_OPTIONS = [
  { value: "open", label: "Open", description: "Anyone in the workspace can browse and search it. It doesn't mix into other teams' views or answers." },
  { value: "private", label: "Private", description: "Only members see its pages, meetings and memory. Others see its name and weekly brief." },
];

export function ColorSwatches({ value, onChange }: { value: TeamColor; onChange: (c: TeamColor) => void }) {
  return (
    <div className="tz-swatches" role="radiogroup" aria-label="Colour">
      {TEAM_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} title={c}
          className="tz-swatch md-focus" style={{ ["--tz-c" as string]: teamTint(c) }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/** The workspace's members (cached per workspace for the session; pickers and the settings page). */
const membersCache = new Map<string, Promise<Member[]>>();
export function useWorkspaceMembers(ws: string): Member[] | null {
  const [m, setM] = useState<Member[] | null>(null);
  useEffect(() => {
    let live = true;
    let p = membersCache.get(ws);
    if (!p) { p = listMembers(ws).catch(() => [] as Member[]); membersCache.set(ws, p); }
    void p.then((r) => { if (live) setM(r); });
    return () => { live = false; };
  }, [ws]);
  return m;
}

/** A filterable checkbox list of people. */
export function PeoplePicker({ members, value, onChange, exclude = [], label = "People" }: {
  members: Member[]; value: string[]; onChange: (ids: string[]) => void; exclude?: string[]; label?: string;
}) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return members.filter((m) => !exclude.includes(m.user_id) && (!t || `${m.name ?? ""} ${m.email ?? ""}`.toLowerCase().includes(t)));
  }, [members, q, exclude]);
  const on = new Set(value);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Input iconPrefix="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find people" aria-label={`Find ${label.toLowerCase()}`} />
      <ul className="tz-picklist" aria-label={label}>
        {rows.length === 0 && <li className="tz-empty">No one matches.</li>}
        {rows.map((m) => (
          <li key={m.user_id}>
            <label>
              <Checkbox checked={on.has(m.user_id)} onChange={(e) => onChange(e.target.checked ? [...value, m.user_id] : value.filter((x) => x !== m.user_id))} aria-label={m.name || m.email || "Member"} />
              <Avatar name={m.name || m.email || "?"} size="sm" />
              <span>{m.name || m.email}{m.name && m.email ? <span className="text-text-muted"> · {m.email}</span> : null}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A checkbox list of teams (the share dialog, the meeting importer, the review). */
export function TeamChecklist({ teams, value, onChange, label = "Teams", disabled }: {
  teams: Pick<TeamCard, "id" | "name" | "icon" | "color" | "visibility">[]; value: string[]; onChange: (ids: string[]) => void; label?: string; disabled?: boolean;
}) {
  const on = new Set(value);
  return (
    <ul className="tz-picklist" aria-label={label}>
      {teams.map((t) => (
        <li key={t.id}>
          <label>
            <Checkbox disabled={disabled} checked={on.has(t.id)} onChange={(e) => onChange(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))} aria-label={t.name} />
            <TeamTile team={t} size={18} />
            <span>{t.name}</span>
            {t.visibility === "private" && <Icon name="lock" size={12} className="ml-auto shrink-0 text-text-muted" aria-label="Private" />}
          </label>
        </li>
      ))}
    </ul>
  );
}

export function fmtShortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
