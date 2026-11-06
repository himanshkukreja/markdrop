"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Skeleton, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { SlackMark } from "@/components/integrations/SlackMark";
import { slackTurnedOnSummary } from "@/components/integrations/useSlackPrompt";
import {
  setSlackReturn, slackLinkStart, slackMe, slackPrefs, slackSetNotifications,
  type SlackMe, type SlackNotifyKind, type SlackTeam,
} from "@/lib/slack";
import { SwitchRow } from "../settings-shared";

const KIND_HINTS: Record<SlackNotifyKind, string> = {
  mention: "Someone @mentions you on a page.",
  signoff_requested: "Someone asks for your sign-off. Choose an option right in Slack.",
  shared: "Someone shares a document, page or file with you.",
  access_request: "Someone asks to open or edit something you own. Approve or decline in Slack.",
};

/**
 * Settings › Account › Slack notifications (routers/slack.py GET /me, PUT /me/notifications): off by
 * default. Turning it on finds you in each Slack workspace connected to a Markdrop workspace of yours
 * by your own sign-in email; where it can't, "Link my Slack account" (Sign in with Slack) is the
 * fallback. Then which kinds. Hidden while no workspace of yours has Slack connected (and it's off).
 * Each direct message's footer links here (#slack). "Action items after meetings" is separate: on by
 * default (owner, 2026-11-06), and a "Stop these" in Slack turns it off here too.
 */
export function SlackCard() {
  const toast = useToast();
  const [me, setMe] = useState<SlackMe | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<"" | "on" | "again" | "ai" | `link:${string}` | SlackNotifyKind>("");
  // What the last "turn on" said per team (not found, needs an update…), until the next look.
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setMe(await slackMe());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Arriving from a Slack message's "Turn off" (or the docs): bring this card into view.
  useEffect(() => {
    if (me && window.location.hash === "#slack") {
      document.getElementById("slack")?.scrollIntoView({ block: "start" });
    }
  }, [me]);

  if (failed || (me && (!me.configured || (me.teams.length === 0 && !me.on)))) return null;

  async function turn(on: boolean, key: "on" | "again" = "on") {
    setBusy(key);
    try {
      const out = await slackSetNotifications(on);
      setMe(out);
      const n: Record<string, string> = {};
      for (const r of out.results ?? []) if (r.message && r.result !== "matched" && r.result !== "linked") n[r.team_id] = r.message;
      setNotes(n);
      if (!on) toast.info("Slack notifications are off.");
      else {
        const sum = slackTurnedOnSummary(out);
        if (sum.ok && !Object.keys(n).length) toast.success(sum.text);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function link(t: SlackTeam) {
    setBusy(`link:${t.team_id}`);
    try {
      const { url } = await slackLinkStart({ workspace_id: t.workspace_id });
      setSlackReturn("/settings/account?slack=linked#slack");
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
      setBusy("");
    }
  }

  async function setKind(kind: SlackNotifyKind, on: boolean) {
    if (!me) return;
    setBusy(kind);
    try {
      const r = await slackPrefs({ [kind]: on });
      setMe({ ...me, prefs: r.prefs });
    } catch {
      toast.error("Couldn't save that. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  async function setActionItems(on: boolean) {
    if (!me) return;
    setBusy("ai");
    try {
      const r = await slackPrefs({ action_items: on });
      setMe({ ...me, action_items: r.action_items });
    } catch {
      toast.error("Couldn't save that. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }

  const missing = me?.on ? me.teams.filter((t) => !t.linked) : [];

  return (
    <Card
      id="slack"
      title="Slack notifications"
      description="Mentions, sign-off requests, shares and access requests as direct messages from the Markdrop app in Slack."
    >
      {!me ? (
        <div className="flex flex-col gap-3" aria-busy="true"><Skeleton width="60%" /><Skeleton width="40%" height={10} /></div>
      ) : (
        <div className="flex min-w-0 flex-col gap-5" data-testid="slack-notify-card">
          <SwitchRow
            id="slack-on"
            label="Get notifications in Slack"
            hint={me.on
              ? "On. Each message says why it came, with a link to turn them off."
              : <>Off. When you turn them on, Markdrop finds you in Slack by your email, <span className="ph-sensitive ph-mask text-text-secondary">{me.email}</span>.</>}
            checked={me.on}
            disabled={busy === "on"}
            onChange={(on) => void turn(on)}
          />

          {me.on && me.teams.length > 0 && (
            <ul className="m-0 flex list-none flex-col p-0" data-testid="slack-teams">
              {me.teams.map((t) => (
                <li key={t.team_id} className="flex min-w-0 flex-col gap-2 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <SlackMark size={18} />
                    <div className="min-w-0 flex-[1_1_200px]">
                      <p className="flex min-w-0 flex-wrap items-center gap-2 text-body text-text">
                        <span className="truncate">{t.team_name || "Slack"}</span>
                        {t.linked ? <Badge size="sm" tone="success" dot>Found</Badge> : <Badge size="sm" tone="warning" dot>Not found</Badge>}
                      </p>
                      <p className="text-caption text-text-muted">
                        {t.linked
                          ? <>As <span className="ph-sensitive ph-mask">{t.slack_name || "your Slack account"}</span>{t.match === "email" ? " (by your email)" : ""} · for {t.workspace_name}</>
                          : <>Connected to {t.workspace_name}</>}
                      </p>
                    </div>
                    {!t.linked && (
                      <Button size="sm" variant="secondary" iconLeft="link" loading={busy === `link:${t.team_id}`} onClick={() => void link(t)}>
                        Link my Slack account
                      </Button>
                    )}
                  </div>
                  {!t.linked && notes[t.team_id] && <p className="text-caption text-text-secondary" data-testid="slack-team-note">{notes[t.team_id]}</p>}
                  {!t.linked && !notes[t.team_id] && !t.can_find_by_email && (
                    <p className="text-caption text-text-secondary">
                      Markdrop for Slack there needs an update before Markdrop can find you by email: a workspace admin updates it in Workspace settings › Integrations › Slack. Or link your Slack account.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {missing.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" iconLeft="refresh" loading={busy === "again"} onClick={() => void turn(true, "again")}>Look again</Button>
              <span className="text-caption text-text-muted">After you change your email in Slack, or an admin updates the app.</span>
            </div>
          )}

          {me.on && me.teams.length === 0 && (
            <Alert tone="info">None of your workspaces has Slack connected right now. Messages start once one does.</Alert>
          )}

          {me.on && (
            <div className="border-t border-border pt-5">
              <p className="text-body-strong text-text">Message me when</p>
              <div className="mt-3 flex min-w-0 flex-col gap-4">
                {me.kinds.map((k) => (
                  <SwitchRow
                    key={k.key}
                    id={`slack-pref-${k.key}`}
                    label={k.label}
                    hint={KIND_HINTS[k.key]}
                    checked={me.prefs[k.key]}
                    disabled={busy === k.key}
                    onChange={(on) => void setKind(k.key, on)}
                  />
                ))}
              </div>
            </div>
          )}
          {me.teams.length > 0 && (
            <div className="border-t border-border pt-5" data-testid="slack-action-items-pref">
              <SwitchRow
                id="slack-pref-action-items"
                label="Action items after meetings"
                hint="Your own to-dos from each meeting you were in, as one message right after it. On unless you turn it off, even when the notifications above are off."
                checked={me.action_items}
                disabled={busy === "ai"}
                onChange={(on) => void setActionItems(on)}
              />
            </div>
          )}
          <p className="text-caption text-text-muted">
            Only you can turn these on, and Markdrop looks up only your own email. A message says what the bell says, about pages you can still open. <ReadMore topic="slackNotifications" />
          </p>
        </div>
      )}
    </Card>
  );
}
