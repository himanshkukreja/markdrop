"use client";

/**
 * A page's left rail (the page tree and the contents): collapsed or not, and, while collapsed, a
 * peek on hovering the left edge (desktop); a drawer below 1280 px, where the rail has no room.
 *
 * The state lives on <html> as attributes (`data-pb-rail="collapsed"`, `data-pb-drawer`,
 * `data-pb-peek`), so the CSS in pages.css lays the rail out wherever it is rendered and the
 * reader's frame and the editor's frame (both can be mounted for a moment) share one state.
 * Collapsed is remembered per browser (localStorage, best effort); the drawer and the peek never.
 *
 * ⌘\ / Ctrl+\ toggles it (Notion's shortcut).
 */
import { useEffect, useSyncExternalStore } from "react";

const KEY = "md_page_rail";
export const RAIL_WIDE = "(min-width: 1280px)";

interface RailState {
  collapsed: boolean;
  drawer: boolean;
  peek: boolean;
}

let state: RailState = { collapsed: false, drawer: false, peek: false };
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    state = { ...state, collapsed: window.localStorage.getItem(KEY) === "collapsed" };
  } catch {
    /* storage blocked: start expanded */
  }
}

function apply() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (state.collapsed) root.setAttribute("data-pb-rail", "collapsed");
  else root.removeAttribute("data-pb-rail");
  root.toggleAttribute("data-pb-drawer", state.drawer);
  root.toggleAttribute("data-pb-peek", state.peek);
}

function set(patch: Partial<RailState>) {
  const next = { ...state, ...patch };
  if (next.collapsed === state.collapsed && next.drawer === state.drawer && next.peek === state.peek) return;
  if (next.collapsed !== state.collapsed) {
    try {
      window.localStorage.setItem(KEY, next.collapsed ? "collapsed" : "open");
    } catch {
      /* not remembered: fine */
    }
  }
  state = next;
  apply();
  for (const l of listeners) l();
}

const wide = () => typeof window !== "undefined" && !!window.matchMedia?.(RAIL_WIDE).matches;

/** The bar's toggle and ⌘\: collapse / expand on a wide screen, open / close the drawer below. */
export function toggleRail() {
  load();
  if (wide()) set({ collapsed: !state.collapsed, peek: false, drawer: false });
  // Below 1280 px only a page's rail opens as a drawer (a classic document's sidebars have none).
  else if (state.drawer || document.querySelector(".pb-shell--rail .pb-rail")) set({ drawer: !state.drawer, peek: false });
}
export const closeRailDrawer = () => set({ drawer: false });
export const setRailPeek = (peek: boolean) => set({ peek });

const SERVER: RailState = { collapsed: false, drawer: false, peek: false };
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The rail's state (expanded and closed on the server and the first render). */
export function useRail(): RailState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER);
}

let mounts = 0;
let mq: MediaQueryList | null = null;
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "\\" || e.code === "Backslash")) {
    e.preventDefault();
    toggleRail();
  } else if (e.key === "Escape" && state.drawer) {
    set({ drawer: false });
  }
}
function onWide() {
  // Crossing 1280 px: a drawer or a peek doesn't carry over.
  if (state.drawer || state.peek) set({ drawer: false, peek: false });
}

/**
 * Mount the rail's behaviour (one listener however many bars are mounted): reads the remembered
 * state, binds ⌘\ and Escape, and clears the attributes when the last page bar goes.
 */
export function useRailControls() {
  useEffect(() => {
    load();
    apply();
    mounts += 1;
    if (mounts === 1) {
      window.addEventListener("keydown", onKey, true);
      mq = window.matchMedia?.(RAIL_WIDE) ?? null;
      mq?.addEventListener?.("change", onWide);
    }
    return () => {
      mounts -= 1;
      if (mounts === 0) {
        window.removeEventListener("keydown", onKey, true);
        mq?.removeEventListener?.("change", onWide);
        mq = null;
        state = { ...state, drawer: false, peek: false };
        const root = document.documentElement;
        root.removeAttribute("data-pb-rail");
        root.removeAttribute("data-pb-drawer");
        root.removeAttribute("data-pb-peek");
      }
    };
  }, []);
}

/**
 * Before first paint (the server-rendered bar carries it): a collapsed rail stays collapsed, so a
 * returning reader never sees it open and shut.
 */
export const RAIL_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(KEY)})==="collapsed")document.documentElement.setAttribute("data-pb-rail","collapsed")}catch(e){}`;
