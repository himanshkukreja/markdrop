"use client";

import { useState } from "react";
import { Avatar, Badge, Button, Icon, Select, Tooltip, cx, type Tone } from "@/components/ui";
import {
  STUDIO_ROLES, roleLabel, type DocsRole, type RoleEvent, type StudioRole,
} from "@/lib/docsSites";
import { firstName, timeAgo } from "../format";

const TONE: Record<string, { tone: Tone; icon: string }> = {
  admin: { tone: "info", icon: "shield" },
  owner: { tone: "info", icon: "shield" },
  reviewer: { tone: "success", icon: "checkCircle" },
  editor: { tone: "neutral", icon: "edit" },
  viewer: { tone: "neutral", icon: "eye" },
  none: { tone: "neutral", icon: "eyeOff" },
};

/** "an admin", "a reviewer", "an editor", "a viewer" (for sentences). */
export function aRole(r: DocsRole | StudioRole | null | undefined): string {
  const word = roleLabel(r).toLowerCase();
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** A Guides role as a badge: Admin (violet), Reviewer, Editor, Viewer, No access. */
export function RoleBadge({ role, size = "sm", className, title }: {
  role: DocsRole | StudioRole | "none" | null | undefined;
  size?: "sm" | "md";
  className?: string;
  title?: string;
}) {
  const r = role ?? "none";
  const t = TONE[r] ?? TONE.none!;
  return (
    <Badge tone={t.tone} size={size} icon={t.icon} variant={r === "none" ? "outline" : "soft"} className={cx("shrink-0", className)} title={title}>
      {roleLabel(r)}
    </Badge>
  );
}

/** Pick a role (optionally without "No access", or with a "Same as workspace" first option). */
export function RoleSelect({ value, onChange, disabled, label, className, withNone = true, id, "aria-describedby": describedBy }: {
  value: StudioRole;
  onChange: (r: StudioRole) => void;
  disabled?: boolean;
  /** The accessible name when no <Field> labels it. */
  label?: string;
  className?: string;
  withNone?: boolean;
  /** Set by a wrapping <Field>. */
  id?: string;
  "aria-describedby"?: string;
}) {
  return (
    <Select
      id={id}
      aria-describedby={describedBy}
      aria-label={id ? undefined : label}
      className={cx("min-w-[132px]", className)}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as StudioRole)}
      options={STUDIO_ROLES.filter((r) => withNone || r.id !== "none").map((r) => ({ value: r.id, label: r.label }))}
    />
  );
}

/** The workspace owner and admins: always Guides admins. A badge with the reason on hover/focus. */
export function LockedAdmin({ workspaceRole }: { workspaceRole: string | null }) {
  const why = workspaceRole === "owner"
    ? "The workspace owner is always a Guides admin."
    : "Workspace admins are always Guides admins. Change their workspace role to change this.";
  return (
    <Tooltip content={why} focusable>
      <span className="inline-flex items-center gap-1.5">
        <RoleBadge role="admin" size="md" />
        <Icon name="lock" size={13} className="text-text-muted" aria-label="Can't be changed" />
      </span>
    </Tooltip>
  );
}

const MATRIX: Array<{ what: string; roles: StudioRole[] }> = [
  { what: "Read drafts, preview, history", roles: ["admin", "reviewer", "editor", "viewer"] },
  { what: "Edit pages, upload files", roles: ["admin", "reviewer", "editor"] },
  { what: "Publish, or submit for review", roles: ["admin", "reviewer", "editor"] },
  { what: "Approve others' changes", roles: ["admin", "reviewer"] },
  { what: "Settings, design, domains", roles: ["admin"] },
  { what: "Give people roles", roles: ["admin"] },
  { what: "Restore, unpublish, delete", roles: ["admin"] },
];
const COLS: StudioRole[] = ["admin", "reviewer", "editor", "viewer"];

/** "Who can do what": a capability × role grid, and what "No access" means. */
export function RolesExplainer({ className }: { className?: string }) {
  return (
    <section aria-labelledby="roles-explainer-h" className={cx("flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:p-5", className)}>
      <h2 id="roles-explainer-h" className="text-[15px] font-semibold text-text">Who can do what</h2>
      <table className="w-full border-collapse text-[12.5px] leading-[18px]">
        <caption className="md-visually-hidden">What each Guides role can do</caption>
        <thead>
          <tr>
            <th scope="col" className="pb-2 text-left font-normal text-text-muted"><span className="md-visually-hidden">Can</span></th>
            {COLS.map((r) => (
              <th key={r} scope="col" className="w-[54px] pb-2 text-center text-[11px] font-semibold text-text-secondary">{roleLabel(r)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MATRIX.map((row) => (
            <tr key={row.what} className="border-t border-border">
              <th scope="row" className="py-2 pr-2 text-left font-normal text-text-secondary">{row.what}</th>
              {COLS.map((r) => (
                <td key={r} className="py-2 text-center">
                  {row.roles.includes(r)
                    ? <Icon name="check" size={15} className="inline text-accent-text" aria-label="Yes" />
                    : <span className="text-text-subtle" aria-label="No">–</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[12.5px] leading-[18px] text-text-muted">
        <strong className="font-semibold text-text-secondary">No access</strong>: the workspace&apos;s guides don&apos;t show up for them at all.
        Workspace owners and admins are always admins. A guide can give someone a different role, higher or lower, in its Settings › People.
      </p>
    </section>
  );
}

function eventText(e: RoleEvent): React.ReactNode {
  const who = <strong className="font-semibold text-text">{e.target_name ?? "Someone"}</strong>;
  const where = e.scope === "site" ? <> on <span className="text-text">{e.site_name ?? "a deleted guide"}</span></> : null;
  if (e.kind === "docs_role_removed") {
    if (e.reason === "left_workspace") return <>{who} left the workspace; their {roleLabel(e.previous)} role{where} went with it</>;
    return e.scope === "site"
      ? <>{who} is back to their workspace role{where} (was {roleLabel(e.previous)})</>
      : <>{who} no longer has a Guides role (was {roleLabel(e.previous)})</>;
  }
  if (e.kind === "docs_role_changed") return <>{who}: {roleLabel(e.previous)} → {roleLabel(e.role)}{where}</>;
  return <>{who} is now {roleLabel(e.role)}{where}</>;
}

/** The audit trail: who gave whom which role, and when. */
export function RoleHistory({ events, empty = "No role changes yet.", initial = 6 }: { events: RoleEvent[] | null; empty?: string; initial?: number }) {
  const [all, setAll] = useState(false);
  if (events === null) return <p className="text-[13px] text-text-muted">Loading…</p>;
  if (!events.length) return <p className="text-[13px] text-text-muted">{empty}</p>;
  const shown = all ? events : events.slice(0, initial);
  return (
    <>
    <ol className="m-0 flex list-none flex-col p-0">
      {shown.map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex min-w-0 items-start gap-2.5 border-t border-border py-2.5 first:border-t-0">
          <Avatar name={e.actor_name || "Markdrop"} size="sm" />
          <div className="min-w-0 flex-1 text-[13px] leading-5 text-text-secondary">
            <div className="[overflow-wrap:anywhere]">{eventText(e)}</div>
            <div className="text-[12px] text-text-muted">
              {e.actor_id ? `by ${firstName(e.actor_name)}` : "automatically"} · <time dateTime={e.at}>{timeAgo(e.at)}</time>
            </div>
          </div>
        </li>
      ))}
    </ol>
    {events.length > shown.length && (
      <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll(true)}>Show {events.length - shown.length} more</Button>
    )}
    </>
  );
}
