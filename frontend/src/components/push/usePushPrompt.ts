"use client";

/**
 * The one-tap "turn on notifications" prompts (feat/push-prompts): the Home card (PushPromptCard) and
 * the bell panel's nudge (NotificationBell). Both run the same flow as Settings › Account ›
 * Notifications on your devices (lib/push.ts enablePush: the browser's permission prompt straight from
 * the click), and share one look at this device (GET /push with this browser's endpoint) so turning
 * them on in one place hides the other at once. Each mount looks again (a change in Settings, or in
 * the browser's site settings, shows on the next visit).
 *
 * Hidden when: push isn't supported here or the server has no keys, notifications are blocked for the
 * site, this device already gets them, or "Not now" was chosen for that prompt on this device
 * (lib/pushPrompt.ts).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui";
import { PushError, currentSubscription, enablePush, getPushStatus, permission, pushSupport, type PushSupport } from "@/lib/push";
import { pushPromptState, readPromptDismissed, writePromptDismissed, type PushPromptWhere } from "@/lib/pushPrompt";
import { track } from "@/lib/track";

interface Snapshot {
  support: PushSupport;
  perm: NotificationPermission | "unsupported";
  configured: boolean;
  publicKey: string | null;
  subscribed: boolean;
}

let snap: Snapshot | null = null;
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const set = (s: Snapshot) => { snap = s; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

async function look(): Promise<Snapshot> {
  const support = pushSupport();
  const perm = permission();
  const none = { support, perm, configured: false, publicKey: null, subscribed: false };
  // Nothing a click could do here: don't ask the server.
  if (support !== "ok" || perm === "denied" || perm === "unsupported") return none;
  const sub = await currentSubscription().catch(() => null);
  const st = await getPushStatus(sub?.endpoint);
  return { support, perm, configured: st.enabled && !!st.public_key, publicKey: st.public_key, subscribed: st.devices.some((d) => d.this_device) };
}

/** Look at this device again (one request at a time; a failure hides the prompts). */
function refresh(): Promise<void> {
  if (!inflight) {
    inflight = look()
      .then(set, () => set({ support: pushSupport(), perm: permission(), configured: false, publicKey: null, subscribed: false }))
      .finally(() => { inflight = null; });
  }
  return inflight;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface PushPrompt {
  show: boolean;
  /** Decided whether to show (the bell's Slack nudge waits for this: one nudge at a time). */
  settled: boolean;
  busy: boolean;
  /** Call from the click: the browser's permission prompt needs the gesture. */
  turnOn: () => Promise<void>;
  /** "Not now": hidden for good on this device (this prompt only). */
  dismiss: () => void;
}

/** `active` false: don't look yet (the bell's nudge waits for a mention or sign-off in the list). */
export function usePushPrompt(where: PushPromptWhere, active = true): PushPrompt {
  const toast = useToast();
  const s = useSyncExternalStore(subscribe, () => snap, () => null);
  const [looked, setLooked] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!active) return;
    setDismissed(readPromptDismissed(storage(), where));
    let live = true;
    void refresh().then(() => { if (live) setLooked(true); });
    return () => { live = false; };
  }, [active, where]);

  const state = active && looked && s ? pushPromptState({ ...s, dismissed }) : "loading";

  useEffect(() => {
    if (state === "show") track("push_prompt", { where, action: "shown" });
  }, [state, where]);

  const turnOn = useCallback(async () => {
    const key = snap?.publicKey;
    if (!key || busy) return;
    setBusy(true);
    track("push_prompt", { where, action: "turn_on" });
    try {
      await enablePush(key); // first thing after the click: it may show the permission prompt
      if (snap) set({ ...snap, perm: permission(), subscribed: true });
      toast.success("Notifications are on for this device.");
      track("push_prompt", { where, action: "on" });
    } catch (e) {
      // Refused at the prompt: "denied" hides the prompts (Settings explains how to allow them).
      if (snap) set({ ...snap, perm: permission() });
      toast.error(e instanceof PushError ? e.message : "Couldn't turn notifications on. Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, toast, where]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    writePromptDismissed(storage(), where);
    track("push_prompt", { where, action: "not_now" });
  }, [where]);

  return { show: state === "show", settled: !active || state !== "loading", busy, turnOn, dismiss };
}
