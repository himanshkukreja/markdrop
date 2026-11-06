"use client";

/**
 * The header's notification bell (Senseloaf P2 item 9): someone mentioned you on a page, asked for
 * your sign-off, or shared a page with you. An unread badge (polled every minute while the tab is
 * visible, and on focus); the panel lists them newest first with the person, the sentence, the
 * page, the time and an unread dot, plus All / Unread and "Mark all read". Clicking one asks the
 * server again (`POST /notifications/{id}/open`: access is re-checked) and opens the page at the
 * block (`#b-…`), which the page scrolls to and flashes (components/pages/anchors.ts).
 *
 * A push notification arriving on this device (lib/push.ts) refreshes the badge at once. While this
 * device doesn't get them and the list has a mention or a sign-off request, a one-line row on top
 * offers to turn them on here (PushNudge: the same flow as Settings; "Not now" remembered per device).
 * When that one isn't showing and a workspace of yours has Slack connected while your Slack
 * notifications are off, the same row offers those instead (SlackNudge; one nudge at a time).
 *
 * Desktop: a popover under the bell. Phones (< 640px): a bottom sheet. Not on workspace domains
 * (their header is TenantHeader) and only when signed in.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Drawer, Icon, Popover, Skeleton, cx, useToast } from "@/components/ui";
import { relativeTime, fullDate } from "@/components/dashboard/format";
import {
  NotificationError, listNotifications, markRead, openNotification, unreadCount,
  type AppNotification,
} from "@/lib/notifications";
import { openInApp } from "@/lib/push";
import { wantsBellNudge } from "@/lib/pushPrompt";
import { usePushPrompt } from "@/components/push/usePushPrompt";
import { useSlackPrompt } from "@/components/integrations/useSlackPrompt";
import { SlackMark } from "@/components/integrations/SlackMark";
import s from "./NotificationBell.module.css";

const POLL_MS = 60_000;
const OPEN_EVENT = "md:notifications";

/** Open the bell's panel from elsewhere (the sidebar's Inbox, the home's "All notifications"). */
export function openNotifications() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_EVENT));
}

/* The unread count, shared with the sidebar's Inbox (the bell polls; others just read it). */
let unreadNow = 0;
const unreadSubs = new Set<() => void>();
function publishUnread(n: number) {
  if (n === unreadNow) return;
  unreadNow = n;
  unreadSubs.forEach((f) => f());
}
export function useUnreadCount(): number {
  return useSyncExternalStore((f) => (unreadSubs.add(f), () => unreadSubs.delete(f)), () => unreadNow, () => 0);
}
const PAGE = 20;

function subscribePhone(cb: () => void) {
  const m = window.matchMedia("(max-width: 639px)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
const usePhone = () => useSyncExternalStore(subscribePhone, () => window.matchMedia("(max-width: 639px)").matches, () => false);

/** The unread count: on mount, every minute while visible, and when the tab comes back. */
function useUnread() {
  const [count, setCount] = useState(0);
  const [supported, setSupported] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setCount(await unreadCount());
    } catch (e) {
      // An API without notifications (404) or a session it won't take: no bell rather than a broken one.
      if (e instanceof NotificationError && (e.status === 404 || e.status === 403)) setSupported(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const tick = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    const back = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    // A push notification just arrived on this device (the service worker tells open windows).
    const sw = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    const pushed = (e: MessageEvent) => { if (e.data?.type === "MD_PUSH") void refresh(); };
    sw?.addEventListener("message", pushed);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
      sw?.removeEventListener("message", pushed);
    };
  }, [refresh]);
  return { count, setCount, refresh, supported };
}

/** The sentence with the person and the quoted page / sign-off in bold. */
function Sentence({ n }: { n: AppNotification }) {
  const actor = n.actor.name;
  const lead = n.text.startsWith(actor);
  const rest = lead ? n.text.slice(actor.length) : n.text;
  return (
    <p className={s.text}>
      {lead && <strong className="ph-sensitive ph-mask">{actor}</strong>}
      {rest.split(/(“[^”]*”)/).map((part, i) =>
        part.startsWith("“") ? <strong key={i} className="ph-sensitive">{part}</strong> : <span key={i}>{part}</span>)}
    </p>
  );
}

function KindMark({ kind }: { kind: AppNotification["kind"] }) {
  const cls = kind === "signoff_requested" ? s.kindSignoff : kind === "shared" ? s.kindShared : undefined;
  return (
    <span className={cx(s.kind, cls)} aria-hidden>
      <span>
        {kind === "mention" ? <b style={{ fontSize: 10.5, lineHeight: 1, fontWeight: 800 }}>@</b>
          : <Icon name={kind === "shared" ? "userPlus" : "check"} size={10} />}
      </span>
    </span>
  );
}

function Row({ n, busy, onOpen, index }: { n: AppNotification; busy: boolean; onOpen: (n: AppNotification) => void; index: number }) {
  return (
    <li>
      <button
        type="button"
        className={s.item}
        data-unread={!n.read}
        aria-busy={busy || undefined}
        onClick={() => onOpen(n)}
        style={{ animationDelay: `${Math.min(index, 8) * 18}ms` }}
      >
        <span className={s.avatar}>
          <Avatar name={n.actor.name} src={n.actor.picture ?? undefined} size="sm" className="ph-no-capture" />
          <KindMark kind={n.kind} />
        </span>
        <span className={s.body}>
          <Sentence n={n} />
          {n.excerpt && <span className={cx(s.excerpt, "ph-sensitive ph-mask")}>{n.excerpt}</span>}
          {n.message && <span className={cx(s.excerpt, "ph-sensitive ph-mask")}>“{n.message}”</span>}
          <span className={s.meta}>
            <time dateTime={n.created_at} title={fullDate(n.created_at)}>{relativeTime(n.created_at)}</time>
            {n.via_ai && <><span className={s.sep} aria-hidden>·</span><span>via an AI app</span></>}
            {!n.available && (
              <><span className={s.sep} aria-hidden>·</span><span className={s.locked}><Icon name="lock" size={12} aria-hidden />No access</span></>
            )}
          </span>
        </span>
        <span className={s.dot} data-on={!n.read} aria-label={n.read ? undefined : "Unread"} role={n.read ? undefined : "img"} />
      </button>
    </li>
  );
}

/** "Get these on this device → Turn on" (components/push/usePushPrompt), else "Get these in Slack →
 *  Turn on" (components/integrations/useSlackPrompt): one nudge at a time, push first. */
function Nudges({ active }: { active: boolean }) {
  const push = usePushPrompt("bell", active);
  const slack = useSlackPrompt(active, push);
  if (push.show) return <Nudge testid="push-prompt-bell" icon="bell" text="Get these on this device" {...push} />;
  if (slack.show) return <Nudge testid="slack-prompt-bell" icon="slack" text="Get these in Slack" {...slack} />;
  return null;
}

function Nudge({ testid, icon, text, busy, turnOn, dismiss }: {
  testid: string; icon: "bell" | "slack"; text: string; busy: boolean; turnOn: () => Promise<void>; dismiss: () => void;
}) {
  return (
    <div className={s.nudge} data-testid={testid}>
      {icon === "slack" ? <SlackMark size={14} className={s.nudgeIcon} /> : <Icon name="bell" size={14} className={s.nudgeIcon} aria-hidden />}
      <span className={s.nudgeText}>{text}</span>
      <button type="button" className={s.nudgeOn} onClick={() => void turnOn()} disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Turning on…" : "Turn on"}
      </button>
      <button type="button" className={s.nudgeX} onClick={dismiss} disabled={busy} aria-label="Not now" title="Not now">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function Panel({ phone, unread, onUnread, onDone }: {
  phone: boolean; unread: number; onUnread: (n: number) => void; onDone: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  // Once the list has shown a mention or a sign-off request, the nudge may look at this device.
  const [personal, setPersonal] = useState(false);
  useEffect(() => {
    if (!personal && items && wantsBellNudge(items.map((n) => n.kind))) setPersonal(true);
  }, [items, personal]);

  const load = useCallback(async (which: "all" | "unread") => {
    setError("");
    try {
      const page = await listNotifications({ unreadOnly: which === "unread", limit: PAGE });
      setItems(page.items);
      setNext(page.next_before);
      onUnread(page.unread_count);
    } catch {
      setError("Couldn't load notifications. Try again in a moment.");
      setItems([]);
    }
  }, [onUnread]);

  useEffect(() => { void load(tab); }, [load, tab]);

  async function more() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await listNotifications({ unreadOnly: tab === "unread", limit: PAGE, before: next });
      setItems((cur) => [...(cur ?? []), ...page.items]);
      setNext(page.next_before);
    } catch { toast.error("Couldn't load more. Try again."); }
    finally { setLoadingMore(false); }
  }

  async function markAll() {
    const before = items;
    setItems((cur) => (cur ?? []).map((n) => ({ ...n, read: true })));
    onUnread(0);
    // On Unread the rows go once their dots have faded: the list is then caught up.
    if (tab === "unread") window.setTimeout(() => setItems([]), 220);
    try { const r = await markRead("all"); onUnread(r.unread_count); }
    catch { setItems(before); toast.error("Couldn't mark them read. Try again."); }
  }

  function go(href: string) {
    onDone();
    openInApp(href, (h) => router.push(h));
  }

  async function open(n: AppNotification) {
    const markLocal = (patch: Partial<AppNotification>) =>
      setItems((cur) => (cur ?? []).map((x) => (x.id === n.id ? { ...x, read: true, ...patch } : x)));
    if (!n.read) onUnread(Math.max(0, unread - 1));
    setBusy(n.id);
    try {
      const r = await openNotification(n.id);
      markLocal({});
      go(r.href);
    } catch (e) {
      markLocal({ available: false, href: null, page: null, excerpt: null });
      toast.error(e instanceof NotificationError && e.status === 403 ? "You can't open that page any more." : "Couldn't open that. Try again.");
    } finally { setBusy(""); }
  }

  const head = (
    <>
      {!phone && <h2 className={s.title}>Notifications</h2>}
      <div className={s.tabs} role="group" aria-label="Show">
        <button type="button" className={s.tab} aria-pressed={tab === "all"} onClick={() => setTab("all")}>All</button>
        <button type="button" className={s.tab} aria-pressed={tab === "unread"} onClick={() => setTab("unread")}>
          Unread{unread ? ` (${unread > 99 ? "99+" : unread})` : ""}
        </button>
      </div>
      <button type="button" className={s.markAll} onClick={markAll} disabled={!unread}>Mark all read</button>
    </>
  );

  return (
    <div className={cx(phone && s.sheet)}>
      <div className={phone ? s.sheetHead : s.head}>{head}</div>
      <Nudges active={personal} />
      {items === null ? (
        <ul className={s.list} aria-busy="true" aria-label="Loading notifications">
          {[0, 1, 2].map((i) => (
            <li key={i} className={s.item} style={{ cursor: "default" }}>
              <Skeleton variant="circle" height={32} />
              <span className="flex flex-col gap-2 pt-1"><Skeleton width="85%" /><Skeleton width="45%" height={10} /></span>
              <span />
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <div className={s.empty} role="status">
          <span className={s.emptyGlyph}><Icon name={error ? "alertCircle" : "bell"} size={20} /></span>
          <p className={s.emptyTitle}>{error ? "Something went wrong" : tab === "unread" ? "You're all caught up" : "No notifications yet"}</p>
          <p className={s.emptyText}>
            {error || (tab === "unread"
              ? "Nothing new. Earlier notifications are under All."
              : "When someone mentions you on a page, asks for your sign-off or shares a page with you, it shows up here.")}
          </p>
        </div>
      ) : (
        <ul className={cx(s.list, "ph-no-capture")}>
          {items.map((n, i) => <Row key={n.id} n={n} index={i} busy={busy === n.id} onOpen={open} />)}
          {next && (
            <li><button type="button" className={s.more} onClick={more} disabled={loadingMore}>{loadingMore ? "Loading…" : "Show older"}</button></li>
          )}
        </ul>
      )}
      <div className={s.foot}>
        <span>Kept for 90 days</span>
        <a href="/settings/account#notifications" onClick={onDone}>Notification settings</a>
      </div>
    </div>
  );
}

export function NotificationBell({ className }: { className?: string }) {
  const { count, setCount, refresh, supported } = useUnread();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);

  useEffect(() => publishUnread(count), [count]);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);

  useEffect(() => {
    if (wasOpen.current && !open) void refresh();
    wasOpen.current = open;
  }, [open, refresh]);

  if (!supported) return null;
  const label = count ? `Notifications, ${count} unread` : "Notifications";
  const bell = (
    <button type="button" className={cx(s.bell, "md-focus", className)} aria-label={label} title="Notifications"
      {...(phone ? { onClick: () => setOpen(true), "aria-haspopup": "dialog" as const, "aria-expanded": open } : {})}>
      <Icon name="bell" size={18} />
      {count > 0 && <span key={count} className={s.badge} aria-hidden>{count > 99 ? "99+" : count}</span>}
    </button>
  );
  const panel = (done: () => void) => (
    <Panel phone={phone} unread={count} onUnread={setCount} onDone={done} />
  );

  if (phone) {
    return (
      <>
        {bell}
        <Drawer open={open} onClose={() => setOpen(false)} side="bottom" title="Notifications" bodyClassName="!p-0">
          {open && panel(() => setOpen(false))}
        </Drawer>
      </>
    );
  }
  return (
    <Popover trigger={bell} open={open} onOpenChange={setOpen} placement="bottom-end" aria-label="Notifications" panelClassName={s.pop}>
      {({ close }) => panel(close)}
    </Popover>
  );
}

export default NotificationBell;
