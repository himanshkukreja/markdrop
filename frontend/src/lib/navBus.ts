/**
 * The navigation's change events, in this tab and in the person's other tabs: a page made, moved,
 * renamed or deleted, a workspace's folders or items changed, the list of workspaces changed.
 *
 * `announce(type, detail)` fires the window event here (what the rail, the page tree and the item
 * lists already listen to) and posts it on a BroadcastChannel; `listenRemote()` (lib/navStore
 * calls it once) re-fires what other tabs post as the same window event with `remote: true`, so a
 * rename in one tab shows in the rail of another without a reload and without polling. Same
 * origin only, nothing leaves the browser.
 */
const CHANNEL = "md-nav";
const KNOWN = new Set(["md:pages-change", "md:workspace-change", "md:workspaces-change", "md:docs-change"]);

let ch: BroadcastChannel | null | undefined;
function channel(): BroadcastChannel | null {
  if (ch === undefined) {
    try {
      ch = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    } catch {
      ch = null;
    }
  }
  return ch;
}

/** Fire `type` here and in the other tabs. `detail` must be plain data (it is cloned across tabs). */
export function announce(type: string, detail: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
  try {
    channel()?.postMessage({ type, detail });
  } catch {
    /* a detail that can't be cloned stays in this tab */
  }
}

let listening = false;
/** Re-fire the other tabs' announcements here (once per tab). */
export function listenRemote(): void {
  if (listening || typeof window === "undefined") return;
  const c = channel();
  if (!c) return;
  listening = true;
  c.onmessage = (e: MessageEvent<{ type?: string; detail?: Record<string, unknown> }>) => {
    const type = e.data?.type;
    if (!type || !KNOWN.has(type)) return;
    window.dispatchEvent(new CustomEvent(type, { detail: { ...(e.data.detail ?? {}), remote: true } }));
  };
}
