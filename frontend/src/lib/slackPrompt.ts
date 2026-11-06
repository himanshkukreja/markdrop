/**
 * The bell's "Get these in Slack → Turn on" nudge (feat/slack-dm-optin). Slack notifications are off
 * by default; this offers them once a workspace of yours has Slack connected. The rules, kept pure
 * (no imports) so node --test runs them: src/lib/slackPrompt.test.mjs. The hook is
 * components/integrations/useSlackPrompt.ts; the full setting is Settings › Account › Slack notifications.
 */

/** Per device (localStorage): "Not now" hides it for good here. */
export const SLACK_PROMPT_KEY = "md_slack_prompt_bell";

export interface SlackPromptFacts {
  /** The server has Markdrop for Slack set up (GET /slack/me: configured). */
  configured: boolean;
  /** Slack workspaces connected to Markdrop workspaces you're in. */
  teams: number;
  /** You already turned Slack notifications on. */
  on: boolean;
  /** "Not now" was chosen on this device. */
  dismissed: boolean;
  /** The push nudge has decided whether it shows (one nudge at a time: push goes first). */
  pushSettled: boolean;
  /** The push nudge is showing. */
  pushShowing: boolean;
}

/** Why the nudge is hidden, or "show". */
export function slackPromptState(f: SlackPromptFacts): "show" | "dismissed" | "unconfigured" | "no-slack" | "on" | "wait" | "push-first" {
  if (f.dismissed) return "dismissed";
  if (!f.configured) return "unconfigured";
  if (f.teams < 1) return "no-slack";
  if (f.on) return "on";
  if (!f.pushSettled) return "wait";
  if (f.pushShowing) return "push-first";
  return "show";
}

type Store = Pick<Storage, "getItem" | "setItem"> | null | undefined;

/** Storage that throws (Safari private mode, blocked cookies) reads as "not dismissed". */
export function readSlackPromptDismissed(store: Store): boolean {
  try {
    return !!store?.getItem(SLACK_PROMPT_KEY);
  } catch {
    return false;
  }
}

export function writeSlackPromptDismissed(store: Store, now = Date.now()): void {
  try {
    store?.setItem(SLACK_PROMPT_KEY, String(now));
  } catch {
    /* ignore */
  }
}
