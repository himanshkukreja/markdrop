"use client";

import { useId, useState } from "react";
import { Alert, Badge, Button, Field, Icon, Input, Switch, cx } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import type { AccessLevel } from "@/lib/docsSites";
import { useSite } from "../SiteContext";
import { LockedNote, SectionHeader, SettingsCard, SwitchRow, useWorkspaceName } from "./SettingsShell";
import { SECTIONS } from "./sections";
import usePatch from "./usePatch";

/** A choice drawn as a card (Settings.dc.html's access options): a native radio, so arrows and forms work. */
export function OptionCard({ name, value, checked, disabled, icon, label, note, badge, onChange }: {
  name: string; value: string; checked: boolean; disabled?: boolean; icon?: string; label: React.ReactNode; note?: React.ReactNode;
  /** A mark after the label ("Coming soon"). */
  badge?: React.ReactNode;
  onChange: (v: string) => void;
}) {
  return (
    <label className={cx(
      "flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg border-[1.5px] p-3.5 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-border-focus",
      checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-border-strong",
      disabled && "cursor-not-allowed opacity-70",
    )}>
      <span className="flex min-w-0 items-center gap-2">
        <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange(value)} className="m-0 accent-[var(--accent)]" />
        {icon && <Icon name={icon} size={15} className="shrink-0 text-text-secondary" />}
        <strong className="min-w-0 text-body-strong text-text">{label}</strong>
        {badge}
      </span>
      {note && <span className="text-caption text-text-muted">{note}</span>}
    </label>
  );
}

/**
 * Settings › Readers and access: who can read the guide (anyone, anyone with the password,
 * workspace members), the password, and whether search engines index it.
 */
export default function AccessSection() {
  const { site, isAdmin } = useSite();
  const { patch, saving, error, setError, locked } = usePatch();
  const ws = useWorkspaceName();
  const uid = useId();
  const s = site.settings;
  const [password, setPassword] = useState("");
  const [pendingLevel, setPendingLevel] = useState<AccessLevel | null>(null);
  const level = pendingLevel ?? s.access.level;
  // Password and members-only guides, while this server doesn't take them yet (the API refuses them).
  const privateSoon = site.private_access === false;

  const options: Array<{ value: AccessLevel; label: string; note: string; icon: string }> = [
    { value: "public", label: "Anyone", note: "A public guide.", icon: "globe" },
    { value: "password", label: "Anyone with the password", note: "For a beta or a partner preview.", icon: "lock" },
    { value: "members", label: `${ws ?? "Workspace"} members`, note: "Readers sign in with Markdrop. Good for internal handbooks.", icon: "users" },
  ];

  function choose(v: string) {
    const next = v as AccessLevel;
    if (next === "password" && !s.access.has_password) { setPendingLevel("password"); return; }
    setPendingLevel(null);
    void patch("access", { settings: { access: { level: next } } }, next === "public" ? "Anyone can read the guide now." : next === "members" ? "Only members can read the guide now." : "Readers need the password now.");
  }

  async function savePassword() {
    if (password.length < 8) { setError("Use at least 8 characters for the password."); return; }
    if (await patch("access", { settings: { access: { level: "password", password } } }, "Password set. Readers need it from now on.")) {
      setPassword("");
      setPendingLevel(null);
    }
  }

  return (
    <>
      <SectionHeader title="Readers and access" description={SECTIONS[2].blurb} />
      <LockedNote />
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

      <SettingsCard id="access" title="Who can read it" description={<>Changes reach readers at the next publish. <ReadMore topic="studioAccess" /></>}>
        <div role="radiogroup" aria-label="Who can read it" className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {options.map((o) => {
            const soon = privateSoon && o.value !== "public" && s.access.level !== o.value;
            return (
              <OptionCard
                key={o.value}
                name={`${uid}-access`}
                value={o.value}
                checked={level === o.value}
                disabled={locked || saving === "access" || soon}
                icon={o.icon}
                label={o.label}
                note={o.note}
                badge={soon ? <Badge tone="info" size="sm" className="ml-auto shrink-0">Coming soon</Badge> : undefined}
                onChange={choose}
              />
            );
          })}
        </div>
        {site.access_enforced === false && s.access.level !== "public" && (
          <p className="text-[13px] text-text-muted" role="status">Not enforced yet — retrying. Readers may still see the previous setting for a few minutes.</p>
        )}
        {level === "password" && isAdmin && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={s.access.has_password ? "Change the password" : "Password"} htmlFor={`${uid}-pw`} className="min-w-0 flex-[1_1_240px]" hint={s.access.has_password ? "Readers who already opened the guide stay signed in." : "Share it with the people who should read the guide."}>
              <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button variant={s.access.has_password ? "secondary" : "primary"} size="md" loading={saving === "access"} disabled={!password} onClick={() => void savePassword()}>
              {s.access.has_password ? "Change" : "Set password"}
            </Button>
            {pendingLevel && <Button variant="ghost" onClick={() => setPendingLevel(null)}>Cancel</Button>}
          </div>
        )}
        {level === "members" && <p className="text-[13px] text-text-muted">Who&apos;s a member is managed in the workspace. <ReadMore topic="members" /></p>}

        <SwitchRow
          divided
          title="Show in search engines"
          hint={s.access.level !== "public" ? "Private guides are never indexed." : "Google and others can list your pages. Off: every page asks not to be indexed."}
        >
          <Switch
            aria-label="Show in search engines"
            checked={s.seo.index && s.access.level === "public"}
            disabled={locked || s.access.level !== "public" || saving === "seo"}
            onChange={(e) => void patch("seo", { settings: { seo: { index: e.target.checked } } }, e.target.checked ? "Search engines can index the guide." : "Search engines are asked not to index the guide.")}
          />
        </SwitchRow>
      </SettingsCard>
    </>
  );
}
