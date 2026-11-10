"use client";

/**
 * The bell's "Get these in Slack → Turn on" nudge (lib/slackPrompt.ts has the rules). Slack
 * notifications are off by default; once a workspace of yours has Slack connected, the bell offers
 * them, but only when the push nudge isn't showing (one nudge at a time) and not after "Not now" on
 * this device. Turning on is the same call as Settings › Account › Slack notifications (PUT
 * /slack/me/notifications): Markdrop finds you in Slack by your own email.
 */
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui";
import { slackMe, slackSetNotifications, type SlackMe } from "@/lib/slack";
import { readSlackPromptDismissed, slackPromptState, writeSlackPromptDismissed } from "@/lib/slackPrompt";
import { track } from "@/lib/track";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** What turning it on found, in one sentence for a toast. */
export function slackTurnedOnSummary(me: SlackMe): { ok: boolean; text: string } {
  const res = me.results ?? [];
  const found = res.filter((r) => r.result === "matched" || r.result === "linked");
  const missed = res.find((r) => r.result !== "matched" && r.result !== "linked");
  if (missed?.message) return { ok: found.length > 0, text: found.length ? `On for ${found.map((r) => r.team_name).join(", ")}. ${missed.message}` : missed.message };
  if (found.length) return { ok: true, text: `Slack notifications are on. They come from the Markdrop app in ${found.map((r) => r.team_name).join(", ")}.` };
  return { ok: true, text: "Slack notifications are on." };
}

export interface SlackPrompt {
  show: boolean;
  busy: boolean;
  turnOn: () => Promise<void>;
  dismiss: () => void;
}

export function useSlackPrompt(active: boolean, push: { settled: boolean; show: boolean }): SlackPrompt {
  const toast = useToast();
  const [me, setMe] = useState<SlackMe | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!active) return;
    const d = readSlackPromptDismissed(storage());
    setDismissed(d);
    if (d) return;
    let live = true;
    slackMe().then((m) => { if (live) setMe(m); }, () => {});
    return () => { live = false; };
  }, [active]);

  const state = active && me
    ? slackPromptState({ configured: me.configured, teams: me.teams.length, on: me.on, dismissed, pushSettled: push.settled, pushShowing: push.show })
    : "loading";

  useEffect(() => {
    if (state === "show") track("slack_prompt", { where: "bell", action: "shown" });
  }, [state]);

  const turnOn = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    track("slack_prompt", { where: "bell", action: "turn_on" });
    try {
      const out = await slackSetNotifications(true);
      setMe(out);
      const sum = slackTurnedOnSummary(out);
      if (sum.ok) toast.success(sum.text);
      else toast.info(sum.text, { duration: 9000, action: { label: "Settings", onClick: () => window.location.assign("/settings/integrations/slack") } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't turn Slack notifications on. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, toast]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    writeSlackPromptDismissed(storage());
    track("slack_prompt", { where: "bell", action: "not_now" });
  }, []);

  return { show: state === "show", busy, turnOn, dismiss };
}
