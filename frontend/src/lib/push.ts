/**
 * Push notifications on this device (backend routers/push.py, services/push.py): mentions, sign-off
 * requests, shares and access requests as real notifications, through the service worker
 * (lib/pwaWorker.ts: `push` shows them, `notificationclick` opens the page).
 *
 * The permission prompt only ever follows a click on "Turn on" (iOS refuses it otherwise, and so
 * should everyone). On iPhone and iPad, Web Push exists only in the installed app (iOS 16.4+), so
 * there the card offers to install first.
 */
import { API_BASE } from "@/lib/api";
import { PWA_ENABLED } from "@/lib/pwa";

const TOKEN_KEY = "markdrop_token";

function authHeaders(): Record<string, string> {
  const t = typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export class PushError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new PushError(typeof body?.detail === "string" ? body.detail : `Request failed (${res.status})`, res.status);
  }
  return res.json();
}

export type PushKind = "mention" | "signoff_requested" | "shared" | "access_request";

export interface PushDevice {
  id: string;
  /** "Chrome on Android", "Safari on iPhone"… */
  label: string;
  /** Subscribed from the installed app. */
  app: boolean;
  /** The push service: Google, Apple, Mozilla, Microsoft. */
  service: string;
  created_at: string | null;
  last_ok_at: string | null;
  seen_at: string | null;
  this_device: boolean;
}

export interface PushStatus {
  /** The server has its keys (push can be sent at all). */
  enabled: boolean;
  public_key: string | null;
  devices: PushDevice[];
  prefs: Record<PushKind, boolean>;
  kinds: { key: PushKind; label: string; hint: string }[];
}

export const getPushStatus = (endpoint?: string | null) =>
  request<PushStatus>(`/api/v1/push${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""}`);

export const setPushPrefs = (changes: Partial<Record<PushKind, boolean>>) =>
  request<{ prefs: Record<PushKind, boolean> }>("/api/v1/push/prefs", { method: "PATCH", body: JSON.stringify(changes) });

export const removePushDevice = (id: string) =>
  request<{ removed: boolean }>(`/api/v1/push/devices/${encodeURIComponent(id)}`, { method: "DELETE" });

export const sendTestPush = (deviceId?: string) =>
  request<{ sent: number; gone: number; failed: number; retry: number }>("/api/v1/push/test", {
    method: "POST",
    body: JSON.stringify(deviceId ? { device_id: deviceId } : {}),
  });

/* ── This browser ─────────────────────────────────────────────────────────── */

/**
 * What this browser can do:
 *   "ok"            Web Push works here
 *   "ios-install"   iPhone / iPad in a browser tab: install the app first (push exists only there)
 *   "unsupported"   no Web Push (an old browser, Firefox private windows, an in-app browser…)
 *   "off"           this build has no service worker (development, or the PWA kill switch)
 */
export type PushSupport = "ok" | "ios-install" | "unsupported" | "off";

export function isIos(ua: string, touch: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
}

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const has = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!has) {
    // iOS exposes PushManager only to the installed app.
    if (isIos(navigator.userAgent, navigator.maxTouchPoints || 0) && "serviceWorker" in navigator) return "ios-install";
    return "unsupported";
  }
  if (!PWA_ENABLED) return "off";
  return "ok";
}

export function permission(): NotificationPermission | "unsupported" {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
}

/** base64url → the bytes PushManager.subscribe wants for applicationServerKey. */
export function keyBytes(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options?.applicationServerKey;
  if (!k) return true; // unknown: assume it's ours
  const a = new Uint8Array(k);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** The worker's registration, registering it if this page hasn't yet (it's the same /sw.js). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  let reg = (await navigator.serviceWorker.getRegistration("/")) ?? null;
  if (!reg) reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => null);
  if (!reg) return null;
  return (await withTimeout(navigator.serviceWorker.ready, 10_000)) ?? reg;
}

/**
 * This browser's current subscription, if any (no prompt). None without permission: browsers drop
 * a site's subscriptions when its permission is revoked or reset, and asking anyway can stall the
 * page in some WebKit builds (Playwright's WebKit blocks the page on getSubscription()).
 */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok" || permission() !== "granted") return null;
  const reg = (await navigator.serviceWorker.getRegistration("/").catch(() => null)) ?? null;
  return reg ? reg.pushManager.getSubscription().catch(() => null) : null;
}

function standalone(): boolean {
  try {
    return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

async function save(sub: PushSubscription, refresh = false): Promise<PushDevice | null> {
  const json = sub.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string }; expirationTime?: number | null };
  const res = await request<{ device: PushDevice | null }>("/api/v1/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh || "", auth: json.keys?.auth || "" },
      expirationTime: json.expirationTime ?? null,
      standalone: standalone(),
      refresh,
    }),
  });
  return res.device;
}

/**
 * Turn notifications on for this device. Call it from a click: it may show the browser's
 * permission prompt. Throws PushError with a sentence to show when it can't.
 */
export async function enablePush(publicKey: string): Promise<PushDevice> {
  if (pushSupport() !== "ok") throw new PushError("This browser can't show Markdrop notifications.", 0);
  // Asked first, straight from the click (Safari requires the gesture for the prompt).
  const perm = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (perm !== "granted") {
    throw new PushError(perm === "denied"
      ? "Notifications are blocked for Markdrop in this browser. Allow them in the site settings, then try again."
      : "Notifications weren't allowed.", 0);
  }
  const reg = await registration();
  if (!reg) throw new PushError("Markdrop's app service couldn't start in this browser. Reload and try again.", 0);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
    } catch {
      throw new PushError("This browser couldn't sign up for notifications. Check your connection and try again.", 0);
    }
  }
  const device = await save(sub);
  if (!device) throw new PushError("Couldn't save this device. Try again.", 0);
  return device;
}

/** Turn them off here: the server forgets this device and the browser drops the subscription. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await request("/api/v1/push/subscriptions/remove", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** Signing out: this browser stops getting the account's notifications (bounded, never blocks sign-out). */
export async function forgetThisDevice(): Promise<void> {
  if (typeof window === "undefined" || pushSupport() !== "ok") return;
  await withTimeout(disablePush().catch(() => {}), 2000);
}

/**
 * On app start, signed in, with permission already granted: tell the server this device is still
 * here (it prunes devices unseen for 90 days; the browser may have renewed the subscription). It
 * never adds a device: only one this account already turned on is kept (the server drops another
 * account's claim on this browser). Silent, never prompts, at most every 12 hours.
 */
const SEEN_KEY = "md_push_seen";
const SEEN_EVERY_MS = 12 * 3600_000;

export async function refreshPush(userId: string): Promise<void> {
  if (pushSupport() !== "ok" || permission() !== "granted") return;
  const mark = `${userId}:`;
  try {
    const last = localStorage.getItem(SEEN_KEY) || "";
    if (last.startsWith(mark) && Date.now() - Number(last.slice(mark.length)) < SEEN_EVERY_MS) return;
  } catch { /* storage blocked: refresh anyway */ }
  const sub = await currentSubscription();
  if (!sub) return;
  await save(sub, true).catch(() => null);
  try { localStorage.setItem(SEEN_KEY, mark + Date.now()); } catch { /* ignore */ }
}

/**
 * Go to an in-app href (`/slug#b-…`) the way the bell does: on the same page only the hash moves
 * (re-set when it's the same one, so the block flashes again); otherwise a client-side push.
 */
export function openInApp(href: string, push: (href: string) => void): void {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin) return;
  if (url.pathname === window.location.pathname && url.search === window.location.search) {
    if (!url.hash) return;
    if (window.location.hash === url.hash) history.replaceState(history.state, "", url.pathname + url.search);
    window.location.hash = url.hash;
    return;
  }
  push(url.pathname + url.search + url.hash);
}
