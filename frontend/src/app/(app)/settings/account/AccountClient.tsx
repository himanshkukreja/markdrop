"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Input, Select, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { PageHeader } from "@/components/shell/PageHeader";
import { UserAvatar } from "@/components/shell/AccountMenu";
import { ThemeSegmented } from "@/components/theme/ThemeSegmented";
import { useAuth } from "@/contexts/AuthContext";
import { DEFAULT_EMAIL_NOTIFY, updateMyName, updatePreferences, type EmailMode, type EmailNotify } from "@/lib/api";
import { getCommentDigest, setCommentDigest } from "@/lib/commentsInsights";
import { useTheme } from "@/lib/theme";
import { useShortcutsEnabled } from "@/lib/shortcuts";
import { useMounted } from "@/components/shell/useLocation";
import { SettingsLoader, SwitchRow, useRequireUser } from "../settings-shared";
import { OLD_ACCOUNT_ANCHORS } from "@/lib/integrations";
import { PushCard } from "./PushCard";
import { ViewHistoryCard } from "./ViewHistoryCard";
import { AccountTrackCard } from "@/components/analytics/AnalyticsSettings";

const NAME_MAX = 80;

const EMAIL_MODES: Array<{ value: EmailMode; label: string }> = [
  { value: "instant", label: "Instant" },
  { value: "hourly", label: "Hourly bundle" },
  { value: "daily", label: "Daily digest" },
  { value: "off", label: "Off" },
];
const MODE_SAID: Record<EmailMode, string> = {
  instant: "as they happen", hourly: "in an hourly bundle", daily: "in a daily digest", off: "off",
};
// Replies and new comments: "Instant" gathers them for 15 minutes (services/comments/notify_email.py).
const ACTIVITY_MODES: Array<{ value: EmailMode; label: string }> = [
  { value: "instant", label: "Every 15 minutes" },
  { value: "hourly", label: "Hourly bundle" },
  { value: "daily", label: "Daily digest" },
  { value: "off", label: "Off" },
];
const KIND_SAID: Record<keyof EmailNotify, string> = {
  mention: "Mention emails", signoff_requested: "Sign-off request emails",
  comment_mention: "Comment mention emails", comment_activity: "Reply and new comment emails",
};

function browserTz(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/** One kind of notification email: a label, a hint and Instant / Hourly bundle / Daily digest / Off. */
function EmailModeRow({ id, label, hint, value, disabled, onChange, modes = EMAIL_MODES }: {
  id: string; label: string; hint: React.ReactNode; value: EmailMode; disabled?: boolean;
  onChange: (mode: EmailMode) => void; modes?: Array<{ value: EmailMode; label: string }>;
}) {
  return (
    <div className="flex min-h-11 min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-56">
        <label htmlFor={id} id={`${id}-label`} className="text-body-strong text-text">{label}</label>
        <p id={`${id}-hint`} className="mt-0.5 text-caption text-text-muted">{hint}</p>
      </div>
      <div className="w-full shrink-0 sm:w-44">
        <Select
          id={id}
          value={value}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          options={modes}
          onChange={(e) => onChange(e.target.value as EmailMode)}
        />
      </div>
    </div>
  );
}

/** /settings/account (REVAMP_PLAN 7.11): profile, appearance, notifications on devices, a link to Integrations, email, sign out.
 *  #slack and #jira (old links) go to Settings › Integrations › Slack / Jira. */
export default function AccountClient() {
  const { user, ready } = useRequireUser("/settings/account");
  const { updateUser, signOut: authSignOut } = useAuth();
  const toast = useToast();
  const { lightEnabled, lightLaunched, lightBeta, setLightBeta } = useTheme();
  const mounted = useMounted();
  const [shortcuts, setShortcuts] = useShortcutsEnabled();
  const router = useRouter();

  // #slack / #jira (Slack messages' footers, older links): those settings live on their integration's page now.
  useEffect(() => {
    const [anchor, query] = window.location.hash.slice(1).split("?");
    const to = OLD_ACCOUNT_ANCHORS[anchor];
    if (!to) return;
    const q = new URLSearchParams(window.location.search);
    new URLSearchParams(query ?? "").forEach((v, k) => q.set(k, v));
    const rest = q.toString();
    router.replace(`/settings/integrations/${to}${rest ? `?${rest}` : ""}`);
  }, [router]);

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [savingDigest, setSavingDigest] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  // The daily comments digest (its own switch, lib/commentsInsights).
  const [commentDigest, setCommentDigestOn] = useState<boolean | undefined>(undefined);
  const [savingCommentDigest, setSavingCommentDigest] = useState(false);
  const signedIn = !!user;
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    getCommentDigest().then((on) => { if (live) setCommentDigestOn(on); }).catch(() => {});
    return () => { live = false; };
  }, [signedIn]);

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

  const notify: EmailNotify = user.email_notify ?? (user.mention_emails === false
    ? { mention: "off", signoff_requested: "off" } : DEFAULT_EMAIL_NOTIFY);

  async function setEmailMode(kind: keyof EmailNotify, mode: EmailMode) {
    if (!user) return;
    setSavingEmail(true);
    try {
      const res = await updatePreferences({ email_notify: { [kind]: mode }, tz: browserTz() });
      const next = res.email_notify ?? { ...notify, [kind]: mode };
      updateUser({ ...user, email_notify: next, mention_emails: res.mention_emails ?? true });
      const what = KIND_SAID[kind];
      toast.info(mode === "off" ? `${what} off. You'll still see them under the bell.` : `${what} ${MODE_SAID[mode]}.`);
    } catch {
      toast.error("Couldn't save that. Check your connection and try again.");
    } finally {
      setSavingEmail(false);
    }
  }

  async function toggleCommentDigest(on: boolean) {
    setSavingCommentDigest(true);
    try {
      setCommentDigestOn(await setCommentDigest(on));
      toast.info(on ? "Daily comments digest on." : "Daily comments digest off.");
    } catch {
      toast.error("Couldn't save that. Check your connection and try again.");
    } finally {
      setSavingCommentDigest(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    let done = true;
    try {
      done = await authSignOut();
    } finally {
      // useRequireUser sends a signed-out visitor to /login; go home instead, explicitly.
      if (done) window.location.assign("/");
      else setSigningOut(false);
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
              <p className="ph-sensitive ph-mask truncate text-body-strong text-text" dir="auto">{user.name || user.email}</p>
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
              hint="Single keys that act without Ctrl or ⌘: F for full screen on a document, E to edit a page, / to search My files."
              checked={shortcuts}
              onChange={(on) => {
                setShortcuts(on);
                toast.info(on ? "Keyboard shortcuts on." : "Keyboard shortcuts off.");
              }}
            />
          </div>
        </div>
      </Card>

      <PushCard />

      <Card title="Integrations" description="Slack notifications, Jira, Claude, ChatGPT, Google Docs, VS Code and more each have their own page now.">
        <Button variant="secondary" size="sm" href="/settings/integrations" iconRight="arrowRight" data-testid="account-integrations-link">Open Integrations</Button>
      </Card>

      <Card title="Email" id="email">
        <div className="flex min-w-0 flex-col gap-4">
          <EmailModeRow
            id="email-mentions"
            label="Mentions"
            hint="When someone mentions you on a page, including a meeting's action item for you."
            value={notify.mention}
            disabled={savingEmail}
            onChange={(m) => setEmailMode("mention", m)}
          />
          <EmailModeRow
            id="email-signoffs"
            label="Sign-off requests"
            hint="When someone asks for your sign-off."
            value={notify.signoff_requested}
            disabled={savingEmail}
            onChange={(m) => setEmailMode("signoff_requested", m)}
          />
          <EmailModeRow
            id="email-comment-mentions"
            label="Comment mentions and assignments"
            hint="When someone @mentions you in a comment or assigns a comment thread to you."
            value={notify.comment_mention ?? "instant"}
            disabled={savingEmail}
            onChange={(m) => setEmailMode("comment_mention", m)}
          />
          <EmailModeRow
            id="email-comment-activity"
            label="Replies and new comments"
            hint="Replies in threads you're part of, new comments on your pages, and your threads being resolved. Gathered into one email."
            value={notify.comment_activity ?? "instant"}
            modes={ACTIVITY_MODES}
            disabled={savingEmail}
            onChange={(m) => setEmailMode("comment_activity", m)}
          />
          <p className="text-caption text-text-muted">
            The app comes first: nothing is emailed that you already saw in Markdrop or got as a push
            notification or a Slack message. At most 3 of these emails a day; the daily digest comes at 8:00 your time. Every one
            has an <span className="text-text-secondary">Email me less</span> link. <ReadMore topic="notificationEmail" />
          </p>
        </div>
        <div className="my-4 border-t border-border" />
        <SwitchRow
          id="comment-digest"
          label="Daily comments digest"
          hint={<>At 8:00 your time: threads waiting on you and open threads on your pages. Only on days with something new. <ReadMore topic="commentEmails" /></>}
          checked={commentDigest}
          disabled={savingCommentDigest || commentDigest === undefined}
          onChange={(on) => void toggleCommentDigest(on)}
        />
        <div className="my-4 border-t border-border" />
        <SwitchRow
          id="analytics-digest"
          label="Weekly analytics email"
          hint={<>On Mondays: last week&apos;s views, your top links and what&apos;s worth a look. Only sent when something was viewed. <ReadMore topic="weeklyEmail" /></>}
          checked={(user.analytics_digest ?? "weekly") !== "off"}
          disabled={savingDigest}
          onChange={setDigest}
        />
      </Card>

      <AccountTrackCard />

      <ViewHistoryCard />

      <Card title="Sign out" description="Ends your session in this browser. Your documents stay as they are.">
        <Button variant="secondary" iconLeft="logOut" loading={signingOut} onClick={signOut}>
          Sign out on this device
        </Button>
      </Card>
    </div>
  );
}
