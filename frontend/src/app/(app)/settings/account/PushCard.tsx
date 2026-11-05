"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Icon, IconButton, Skeleton, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { usePwa } from "@/components/pwa/PwaProvider";
import { relativeTime } from "@/components/dashboard/format";
import {
  PushError, currentSubscription, disablePush, enablePush, getPushStatus, permission, pushSupport,
  removePushDevice, sendTestPush, setPushPrefs,
  type PushDevice, type PushKind, type PushStatus, type PushSupport,
} from "@/lib/push";
import { SwitchRow } from "../settings-shared";

/**
 * Settings › Account › Notifications (lib/push.ts): turn push notifications on for this device
 * (the permission prompt only after the click), which kinds ring, and every device that gets them
 * (Remove). Hidden while the server has no push keys. On iPhone / iPad in a browser tab it points
 * at installing the app first: iOS has Web Push only there.
 */
export function PushCard() {
  const toast = useToast();
  const { installPath, install } = usePwa();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  const [busy, setBusy] = useState<"" | "on" | "off" | "test" | `rm:${string}`>("");
  const [savingKind, setSavingKind] = useState<PushKind | "">("");

  const load = useCallback(async () => {
    const sup = pushSupport();
    setSupport(sup);
    setPerm(permission());
    const sub = await currentSubscription().catch(() => null);
    try {
      setStatus(await getPushStatus(sub?.endpoint));
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Arriving from the bell's "Notification settings" (or the docs): bring this card into view.
  useEffect(() => {
    if (status && window.location.hash === "#notifications") {
      document.getElementById("notifications")?.scrollIntoView({ block: "start" });
    }
  }, [status]);

  if (failed || (status && !status.enabled)) return null;

  const here = status?.devices.find((d) => d.this_device) ?? null;

  async function turnOn() {
    if (!status?.public_key) return;
    setBusy("on");
    try {
      await enablePush(status.public_key);
      toast.success("Notifications are on for this device.");
      await load();
    } catch (e) {
      setPerm(permission());
      toast.error(e instanceof PushError ? e.message : "Couldn't turn notifications on. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function turnOff() {
    setBusy("off");
    try {
      await disablePush();
      toast.info("Notifications are off for this device.");
      await load();
    } finally {
      setBusy("");
    }
  }

  async function test(device?: PushDevice) {
    setBusy("test");
    try {
      const r = await sendTestPush(device?.id);
      if (r.sent) toast.info("Sent. It should arrive in a few seconds.");
      else if (r.gone) { toast.error("That device no longer accepts notifications, so it was removed."); await load(); }
      else toast.error("The notification service didn't take it. Try again in a minute.");
    } catch (e) {
      toast.error(e instanceof PushError ? e.message : "Couldn't send a test. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function remove(d: PushDevice) {
    setBusy(`rm:${d.id}`);
    try {
      if (d.this_device) await disablePush();
      else await removePushDevice(d.id);
      toast.info(`${d.label} won't get notifications any more.`);
      await load();
    } catch {
      toast.error("Couldn't remove it. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function setKind(kind: PushKind, on: boolean) {
    if (!status) return;
    setSavingKind(kind);
    try {
      const r = await setPushPrefs({ [kind]: on });
      setStatus({ ...status, prefs: r.prefs });
    } catch {
      toast.error("Couldn't save that. Check your connection and try again.");
    } finally {
      setSavingKind("");
    }
  }

  return (
    <Card
      id="notifications"
      title="Notifications on your devices"
      description="Mentions, sign-off requests, shares and access requests as notifications on your phone or computer, even when Markdrop is closed."
    >
      {!status || support === null ? (
        <div className="flex flex-col gap-3" aria-busy="true"><Skeleton width="60%" /><Skeleton width="40%" height={10} /></div>
      ) : (
        <div className="flex min-w-0 flex-col gap-5" data-testid="push-card">
          <ThisDevice
            support={support}
            perm={perm}
            on={!!here}
            busy={busy}
            canInstall={installPath === "ios"}
            onInstall={install}
            onTurnOn={turnOn}
            onTurnOff={turnOff}
            onTest={() => test(here ?? undefined)}
          />

          {status.devices.length > 0 && (
            <div className="border-t border-border pt-5">
              <p className="text-body-strong text-text">Notify me when</p>
              <div className="mt-3 flex min-w-0 flex-col gap-4">
                {status.kinds.map((k) => (
                  <SwitchRow
                    key={k.key}
                    id={`push-${k.key}`}
                    label={k.label}
                    hint={k.hint}
                    checked={status.prefs[k.key]}
                    disabled={savingKind === k.key}
                    onChange={(on) => setKind(k.key, on)}
                  />
                ))}
              </div>
            </div>
          )}

          {status.devices.length > 0 && (
            <div className="border-t border-border pt-5">
              <p className="text-body-strong text-text">Devices</p>
              <ul className="m-0 mt-2 flex list-none flex-col p-0" data-testid="push-devices">
                {status.devices.map((d) => (
                  <li key={d.id} className="flex min-h-11 min-w-0 items-center gap-3 border-b border-border py-2 last:border-b-0">
                    <Icon name={/iPhone|Android/.test(d.label) ? "phone" : d.label.includes("iPad") ? "tablet" : "laptop"} size={18} className="shrink-0 text-text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="flex min-w-0 flex-wrap items-center gap-2 text-body text-text">
                        <span className="truncate">{d.label}</span>
                        {d.this_device && <Badge size="sm" tone="info">This device</Badge>}
                        {d.app && <Badge size="sm">App</Badge>}
                      </p>
                      <p className="text-caption text-text-muted">
                        {d.last_ok_at ? `Last notified ${relativeTime(d.last_ok_at)}` : d.created_at ? `Added ${relativeTime(d.created_at)}` : ""}
                      </p>
                    </div>
                    <IconButton
                      icon="trash"
                      label={`Stop notifications on ${d.label}`}
                      title="Remove"
                      disabled={busy === `rm:${d.id}`}
                      onClick={() => remove(d)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-caption text-text-muted">
            A notification says only what the bell says, and only about pages you can still open. <ReadMore topic="pushNotifications" />
          </p>
        </div>
      )}
    </Card>
  );
}

function ThisDevice({ support, perm, on, busy, canInstall, onInstall, onTurnOn, onTurnOff, onTest }: {
  support: PushSupport;
  perm: NotificationPermission | "unsupported";
  on: boolean;
  busy: string;
  canInstall: boolean;
  onInstall: () => void;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onTest: () => void;
}) {
  let hint: React.ReactNode;
  let action: React.ReactNode = null;
  if (support === "ios-install") {
    hint = "On iPhone and iPad, notifications work in the installed app. Add Markdrop to your Home Screen, open it from there, and turn them on.";
    if (canInstall) action = <Button variant="secondary" iconLeft="download" onClick={onInstall}>Install app</Button>;
  } else if (support === "unsupported") {
    hint = "This browser can't show notifications from websites. Chrome, Edge, Firefox and Safari can.";
  } else if (support === "off") {
    hint = "Notifications need the published app (this build has no service worker).";
  } else if (on) {
    hint = "On. Notifications arrive here even when Markdrop is closed.";
    action = (
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={busy === "test"} onClick={onTest}>Send a test</Button>
        <Button variant="ghost" loading={busy === "off"} onClick={onTurnOff}>Turn off</Button>
      </div>
    );
  } else if (perm === "denied") {
    hint = "Blocked in this browser. Allow notifications for this site in the browser's site settings, then come back here.";
  } else {
    hint = "Off. Your browser asks for permission when you turn them on.";
    action = <Button variant="primary" iconLeft="bell" loading={busy === "on"} onClick={onTurnOn}>Turn on</Button>;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3" data-testid="push-this-device">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-body-strong text-text">This device</p>
        <p className="mt-0.5 text-caption text-text-muted">{hint}</p>
      </div>
      {action}
    </div>
  );
}
