"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import View, { type Handlers } from "./View";
import { TICK_MS, initialState, needsTick, reducer } from "./model";
import { useLoopReport, usePlayGrant } from "../../PlayCoordinator";
import { useToyEvents } from "../../useToyEvents";

/**
 * Sync Desk, interactive. First render = View(initialState), identical to the server poster.
 * The clock (100 ms TICK) runs only while the tab is visible and either the demo is playing while the
 * PlayCoordinator grants this toy the page's one autoplay slot, or something time-based is pending (a sync in flight, an autosave countdown,
 * a highlight fading). The demo starts once, when the stage first comes into view; it never starts
 * under prefers-reduced-motion, and the first real input stops it for good (Play demo restarts it).
 */
export default function Game() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [visible, setVisible] = useState(true);
  const demoOk = useRef(false);

  /* Reduced motion (and changes to it). */
  useEffect(() => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (!mq) return;
    const apply = () => dispatch({ type: "REDUCE", on: mq.matches });
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  /* Hidden tab: freeze everything, as the board does. */
  useEffect(() => {
    const apply = () => setVisible(!document.hidden);
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, []);

  /* One autoplay per page: the demo only advances while the coordinator grants the slot (the stage
     at least half on screen and the most visible island). Wants it while playing, or before the
     one-time autoplay has happened. */
  const wants = state.attract || (!state.touched && !state.autoDone && !state.reduce);
  const [granted, claim] = usePlayGrant("sync-desk", () => document.getElementById("sd-stage"), wants);
  useEffect(() => {
    dispatch({ type: "SEEN", on: granted });
  }, [granted]);
  const g = state.goals;
  useToyEvents("sync-desk", g.save && g.web && g.fix);

  // Keyed on the grant directly (state.onScreen, from SEEN, lands a render later and only drives the
  // "live" dot), so the demo stops in the same commit that hands the slot to another island.
  demoOk.current = granted && visible;
  useEffect(() => {
    if (granted && visible && !state.reduce) dispatch({ type: "AUTOPLAY" });
  }, [granted, visible, state.reduce]);

  const ticking = visible && ((state.attract && granted) || needsTick(state));
  useLoopReport("sync-desk", visible && state.attract && granted);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => dispatch({ type: "TICK", demo: demoOk.current }), TICK_MS);
    return () => window.clearInterval(id);
  }, [ticking]);

  /* Focus requests from the reducer (after a conflict opens, or a choice is made). */
  const focus = state.focus;
  useEffect(() => {
    if (!focus) return;
    const raf = window.requestAnimationFrame(() => document.getElementById(focus.id)?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [focus]);

  /* When the diff opens, bring the first differing line into view (small windows hide it below). */
  const diffOpen = state.mode === "conflict" && !!state.conflict;
  const conflict = state.conflict;
  useEffect(() => {
    if (!diffOpen) return;
    const box = document.getElementById("sd-diff");
    const first = box?.querySelector<HTMLElement>("[data-changed]");
    if (box && first) box.scrollTop = Math.max(0, first.offsetTop - 26);
  }, [diffOpen, conflict]);

  /* The demo's reset scrolls the file back to the top. */
  const scrollReset = state.scrollReset;
  useEffect(() => {
    if (!scrollReset) return;
    const el = document.getElementById("sd-editor");
    if (el) el.scrollTop = 0;
  }, [scrollReset]);

  const on = useMemo<Handlers>(
    () => ({
      type: (value) => dispatch({ type: "TYPE", value }),
      edKey: (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
          e.preventDefault();
          dispatch({ type: "SAVE_KEY" });
        }
      },
      edFocus: () => dispatch({ type: "ED_FOCUS" }),
      edScroll: (top) => dispatch({ type: "ED_SCROLL", top }),
      keepMine: () => dispatch({ type: "KEEP_MINE" }),
      useWeb: () => dispatch({ type: "USE_WEB" }),
      mergeManual: () => dispatch({ type: "MERGE_MANUAL" }),
      backToDiff: () => dispatch({ type: "BACK_TO_DIFF" }),
      saveMerge: () => dispatch({ type: "SAVE_MERGE" }),
      toggleDemo: () => {
        claim(); // an explicit Play takes the autoplay slot
        dispatch({ type: "TOGGLE_DEMO" });
      },
      webEdit: () => dispatch({ type: "WEB_EDIT" }),
      editBoth: () => dispatch({ type: "EDIT_BOTH" }),
    }),
    [claim],
  );

  return <View state={state} on={on} />;
}
