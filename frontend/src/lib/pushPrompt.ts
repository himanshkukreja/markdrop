/**
 * One-tap "turn on notifications" prompts (feat/push-prompts): the Home card and the bell panel's
 * nudge. The rules, kept pure (no imports) so node --test runs them: src/lib/pushPrompt.test.mjs.
 * The flow itself is lib/push.ts (the same one as Settings › Account › Notifications on your devices),
 * the shared state components/push/usePushPrompt.ts.
 */

export type PushPromptWhere = "home" | "bell";

/** Per device (localStorage), one key per prompt: "Not now" on one doesn't silence the other. */
export const PUSH_PROMPT_KEYS: Record<PushPromptWhere, string> = {
  home: "md_push_prompt_home",
  bell: "md_push_prompt_bell",
};

export interface PushPromptFacts {
  /** lib/push.ts pushSupport(): only "ok" can subscribe from a click. */
  support: "ok" | "ios-install" | "unsupported" | "off";
  /** Notification.permission ("unsupported" without the API). */
  perm: NotificationPermission | "unsupported";
  /** The server has push keys (GET /push: enabled + public_key). */
  configured: boolean;
  /** This device is already one of the account's devices. */
  subscribed: boolean;
  /** "Not now" was chosen for this prompt on this device. */
  dismissed: boolean;
}

/** Why a prompt is hidden, or "show". */
export function pushPromptState(f: PushPromptFacts): "show" | "unsupported" | "unconfigured" | "denied" | "subscribed" | "dismissed" {
  if (f.dismissed) return "dismissed";
  if (f.support !== "ok" || f.perm === "unsupported") return "unsupported";
  if (f.perm === "denied") return "denied";
  if (!f.configured) return "unconfigured";
  if (f.subscribed) return "subscribed";
  return "show";
}

/** The bell's nudge is about what someone asked of you: a mention or a sign-off request in the list. */
export function wantsBellNudge(kinds: readonly string[]): boolean {
  return kinds.some((k) => k === "mention" || k === "signoff_requested" || k === "comment_mention");
}

type Store = Pick<Storage, "getItem" | "setItem"> | null | undefined;

/** Storage that throws (Safari private mode, blocked cookies) reads as "not dismissed". */
export function readPromptDismissed(store: Store, where: PushPromptWhere): boolean {
  try {
    return !!store?.getItem(PUSH_PROMPT_KEYS[where]);
  } catch {
    return false;
  }
}

/** Remember "Not now" for good on this device (when storage refuses, the prompt just comes back). */
export function writePromptDismissed(store: Store, where: PushPromptWhere, now = Date.now()): void {
  try {
    store?.setItem(PUSH_PROMPT_KEYS[where], String(now));
  } catch {
    /* ignore */
  }
}
