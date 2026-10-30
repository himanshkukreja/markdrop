"use client";

import { useEffect, useState } from "react";
import { Button, Card, Field, Input, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { PageHeader } from "@/components/shell/PageHeader";
import { UserAvatar } from "@/components/shell/AccountMenu";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import { useAuth } from "@/contexts/AuthContext";
import { updateMyName, updatePreferences } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { useShortcutsEnabled } from "@/lib/shortcuts";
import { useMounted } from "@/components/shell/useLocation";
import { SettingsLoader, SwitchRow, useRequireUser } from "../settings-shared";

const NAME_MAX = 80;

/** /settings/account (REVAMP_PLAN 7.11): profile, appearance, sign out. */
export default function AccountClient() {
  const { user, ready } = useRequireUser("/settings/account");
  const { updateUser, logout } = useAuth();
  const toast = useToast();
  const { lightEnabled, lightLaunched, lightBeta, setLightBeta } = useTheme();
  const mounted = useMounted();
  const [shortcuts, setShortcuts] = useShortcutsEnabled();

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [savingDigest, setSavingDigest] = useState(false);

  // Seed the field once the user is known (and again if another tab renames them).
  const current = user?.name ?? "";
  useEffect(() => setName(current), [current]);

  if (!ready || !user) return <SettingsLoader />;

  const trimmed = name.trim();
  const dirty = trimmed !== (user.name ?? "").trim();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    // The API strips whitespace and would store "" for a blank name, so block it here.
    if (!trimmed) { setNameError("Enter a name, or keep the one you have."); return; }
    if (trimmed.length > NAME_MAX) { setNameError(`Keep it under ${NAME_MAX} characters.`); return; }
    setNameError("");
    setSaving(true);
    try {
      const u = await updateMyName(trimmed);
      updateUser(u);
      toast.success("Name saved.");
    } catch {
      toast.error("Couldn't save your name. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function setDigest(on: boolean) {
    if (!user) return;
    const value = on ? "weekly" : "off";
    setSavingDigest(true);
    try {
      const res = await updatePreferences({ analytics_digest: value });
      updateUser({ ...user, analytics_digest: res.analytics_digest });
      toast.info(on ? "Weekly analytics email on." : "Weekly analytics email off.");
    } catch {
      toast.error("Couldn't save that. Check your connection and try again.");
    } finally {
      setSavingDigest(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      // useRequireUser sends a signed-out visitor to /login; go home instead, explicitly.
      window.location.assign("/");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title="Account" description="Your profile and how Markdrop looks on this device." />

      <Card title="Profile">
        <form onSubmit={save} className="flex min-w-0 flex-col gap-5" noValidate>
          <div className="flex min-w-0 items-center gap-4">
            <UserAvatar user={user} size="xl" />
            <div className="min-w-0">
              <p className="truncate text-body-strong text-text" dir="auto">{user.name || user.email}</p>
              <p className="truncate text-caption text-text-muted">
                {user.providers?.includes("google") ? "Signed in with Google" : "Signed in with an email code"}
              </p>
            </div>
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Field label="Display name" hint="Shown to people in your workspaces." error={nameError || undefined}>
              <Input
                value={name}
                maxLength={NAME_MAX}
                autoComplete="name"
                placeholder="Your name"
                onChange={(e) => { setName(e.target.value); if (nameError) setNameError(""); }}
              />
            </Field>
            <Field label="Email" hint="Your sign-in address. It can't be changed here.">
              <Input value={user.email} readOnly aria-readonly="true" className="text-text-secondary" />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty || saving}>
              Save
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Appearance" description="Stored in this browser only.">
        <div className="flex min-w-0 flex-col gap-5">
          {!lightLaunched && (
            <SwitchRow
              id="light-beta"
              label="Try the light theme (beta)"
              hint="Adds Light and System to the theme choice in this browser. Turn it off to go back to dark."
              checked={mounted ? lightBeta : undefined}
              onChange={(on) => {
                setLightBeta(on);
                toast.info(on ? "Light theme beta on." : "Light theme beta off.");
              }}
            />
          )}
          {lightEnabled && (
            <div className={`flex min-w-0 flex-wrap items-center justify-between gap-3 ${lightLaunched ? "" : "border-t border-border pt-5"}`}>
              <div className="min-w-0">
                <p className="text-body-strong text-text">Theme</p>
                <p className="mt-0.5 text-caption text-text-muted">System follows your device&apos;s light or dark setting.</p>
              </div>
              <ThemeSegmented label="Theme" />
            </div>
          )}
          <div className="border-t border-border pt-5">
            <SwitchRow
              id="shortcuts"
              label="Keyboard shortcuts"
              hint="Single-key shortcuts like F (full screen) and / (search)."
              checked={shortcuts}
              onChange={(on) => {
                setShortcuts(on);
                toast.info(on ? "Keyboard shortcuts on." : "Keyboard shortcuts off.");
              }}
            />
          </div>
        </div>
      </Card>

      <Card title="Email">
        <SwitchRow
          id="analytics-digest"
          label="Weekly analytics email"
          hint={<>On Mondays: last week&apos;s views, your top links and what&apos;s worth a look. Only sent when something was viewed. <ReadMore topic="weeklyEmail" /></>}
          checked={(user.analytics_digest ?? "weekly") !== "off"}
          disabled={savingDigest}
          onChange={setDigest}
        />
      </Card>

      <Card title="Sign out" description="Ends your session in this browser. Your documents stay as they are.">
        <Button variant="secondary" iconLeft="logOut" loading={signingOut} onClick={signOut}>
          Sign out on this device
        </Button>
      </Card>
    </div>
  );
}
