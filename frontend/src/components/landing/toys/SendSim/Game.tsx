"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import View, { type Handlers } from "./View";
import { initialState, needsTick, reducer, TABS, TICK_MS } from "./model";
import { useLoopReport, usePlayGrant } from "../../PlayCoordinator";
import { useToyEvents } from "../../useToyEvents";

/** Demo controls never hold the demo: focusing "Play demo" must not stop it from playing. */
const DEMO_IDS = new Set(["ss-pp", "ss-pp-m"]);

/**
 * Send Sim, interactive. First render = View(initialState) (the server poster), frozen until the
 * toy is in view. The attract demo runs only while the PlayCoordinator grants this toy the page's one
 * autoplay slot (in view and the most visible island), the tab is visible, the
 * viewer hasn't asked for reduced motion and no keyboard focus is inside it; the first input
 * takes over for good (only "Play demo" brings it back). No network calls, no storage.
 */
export default function Game() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const root = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  // prefers-reduced-motion: the demo never plays; the first frame stays still.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) dispatch({ type: "REDUCED" });
    const change = (e: MediaQueryListEvent) => { if (e.matches) dispatch({ type: "REDUCED" }); };
    mq.addEventListener?.("change", change);
    return () => mq.removeEventListener?.("change", change);
  }, []);

  // Awake = in view and the tab visible, and, while the demo runs by itself, holding the page's one
  // autoplay slot (PlayCoordinator). Asleep, the clock stops and the CSS loops pause.
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);
  const [granted, claim] = usePlayGrant("send-sim", () => root.current, state.attract && !state.paused && !state.reduced);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const vis = () => setVisible(document.visibilityState === "visible");
    vis();
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "undefined") setInView(true);
    else {
      io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), { rootMargin: "-15% 0px -15% 0px" });
      io.observe(el);
    }
    document.addEventListener("visibilitychange", vis);
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  const awake = inView && visible && (!state.attract || granted);
  useEffect(() => {
    dispatch({ type: "AWAKE", on: awake });
  }, [awake]);
  useToyEvents("send-sim", !state.attract && state.goalDone); // "You delivered over every network."

  // The clock: one interval, only while there is something to animate.
  // Keyed on the grant directly (not only via AWAKE, which lands a render later), so the demo clock
  // stops in the same commit that hands the slot to another island.
  const running = needsTick(state) && (!state.attract || granted);
  useLoopReport("send-sim", running && state.attract);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => dispatch({ type: "TICK" }), TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  // Focus requests from the reducer (the board's focusId).
  const focus = state.focus;
  useEffect(() => {
    if (focus) document.getElementById(focus.id)?.focus();
  }, [focus]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const on = useMemo<Handlers>(() => ({
    addFile: () => dispatch({ type: "ADD_FILE" }),
    removeFile: (id) => dispatch({ type: "REMOVE_FILE", id }),
    pickNet: (id) => dispatch({ type: "PICK_NET", id }),
    send: () => dispatch({ type: "SEND" }),
    keep: () => dispatch({ type: "KEEP" }),
    end: () => dispatch({ type: "END" }),
    confirmKey: (e) => {
      if (e.key === "Escape") { e.preventDefault(); dispatch({ type: "KEEP" }); return; }
      if (e.key !== "Tab") return;
      const id = e.currentTarget.id;
      if (id === "ss-end" && !e.shiftKey) { e.preventDefault(); document.getElementById("ss-keep")?.focus(); }
      if (id === "ss-keep" && e.shiftKey) { e.preventDefault(); document.getElementById("ss-end")?.focus(); }
    },
    addPerson: () => dispatch({ type: "ADD_PERSON" }),
    removePerson: () => dispatch({ type: "REMOVE_PERSON" }),
    tab: (tab) => dispatch({ type: "TAB", tab }),
    tabKey: (e) => {
      const i = TABS.findIndex((t) => "ss-tab-" + t.value === e.currentTarget.id);
      let n = -1;
      if (e.key === "ArrowRight") n = (i + 1) % TABS.length;
      else if (e.key === "ArrowLeft") n = (i - 1 + TABS.length) % TABS.length;
      else if (e.key === "Home") n = 0;
      else if (e.key === "End") n = TABS.length - 1;
      if (n < 0) return;
      e.preventDefault();
      dispatch({ type: "TAB", tab: TABS[n].value, focus: true });
    },
    copy: (which, text) => {
      try { navigator.clipboard?.writeText(text).catch(() => {}); } catch { /* no clipboard */ }
      dispatch({ type: "COPIED", which });
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => dispatch({ type: "COPIED", which: null }), 2000);
    },
    toggleDemo: () => {
      claim(); // an explicit Play takes the autoplay slot
      dispatch({ type: "TOGGLE_DEMO" });
    },
    focusIn: (e) => {
      const t = e.target as HTMLElement;
      let keyboard = false;
      try { keyboard = t.matches(":focus-visible"); } catch { keyboard = false; }
      dispatch({ type: "HOLD", on: keyboard && !DEMO_IDS.has(t.id) });
    },
    focusOut: (e) => {
      const next = e.relatedTarget as Node | null;
      if (!next || !e.currentTarget.contains(next)) dispatch({ type: "HOLD", on: false });
    },
  }), [claim]);

  return <View state={state} on={on} rootRef={root} />;
}
