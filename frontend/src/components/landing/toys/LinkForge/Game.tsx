"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import View, { type Handlers } from "./View";
import { PW_MAX, TRAITS, datesFrom, derive, initialState, reducer, type State } from "./model";
import { useLoopReport, usePlayGrant } from "../../PlayCoordinator";
import { useToyEvents } from "../../useToyEvents";

/** The board's 100ms tick. */
const TICK_MS = 100;
/** How long "Copied" stays on the button (board `copiedAt` + 2000). */
const COPIED_MS = 2000;
/** The demo plays itself only in the two-column layout; on phones it waits for Play. */
const WIDE = "(min-width: 900px)";
const REDUCE = "(prefers-reduced-motion: reduce)";

function useMedia(query: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setOn(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return on;
}

/**
 * Link Forge, interactive. First render = View(initialState), the same as the server poster.
 *
 * Motion rules: the demo ticks only while the PlayCoordinator grants this toy the page's one autoplay
 * slot (on screen and the most visible island) and the tab is visible. It starts by itself at most once, never under reduced motion and never on phones, and
 * stops for good on the visitor's first interaction (a press, a tap or keyboard focus in the stage)
 * until they press Play. Nothing typed is sent anywhere: no network, no storage, no clipboard; analytics
 * get only toy_play / toy_done with the toy's name.
 */
export default function Game() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef<State>(state);
  const [visible, setVisible] = useState(true);
  const wide = useMedia(WIDE);
  const reduce = useMedia(REDUCE);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Real dates replace the board's hard-coded MIN_DATE (the poster keeps the board's).
  useEffect(() => {
    const d = datesFrom(Date.now());
    dispatch({ type: "today", minDate: d.minDate, idleDate: d.idleDate });
  }, []);

  // One autoplay per page. Wants the slot while the demo plays, or while it may still start by itself.
  const wants = state.attract ? !state.paused : !state.touched && wide && !reduce;
  const [granted, claim] = usePlayGrant("link-forge", () => document.getElementById("lf-toy"), wants);
  useToyEvents("link-forge", Object.keys(state.found).length >= TRAITS.length);

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Attract mode: once, on wide screens, when seen, with motion allowed.
  useEffect(() => {
    if (granted && visible && wide && !reduce && !state.attract && !state.touched) dispatch({ type: "autostart" });
  }, [granted, visible, wide, reduce, state.attract, state.touched]);

  const ticking = state.attract && !state.paused && granted && visible;
  useLoopReport("link-forge", ticking);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => {
      // Keyboard focus inside the stage hands over: the demo never types under you.
      const stage = document.getElementById("lf-stage");
      const a = document.activeElement;
      if (stage && a && stage.contains(a)) dispatch({ type: "stop" });
      else dispatch({ type: "tick", dt: TICK_MS });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [ticking]);

  useEffect(() => {
    if (!state.copied) return;
    const t = window.setTimeout(() => dispatch({ type: "copyClear" }), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [state.copied, state.copyN]);

  const on = useMemo<Handlers>(
    () => ({
      togglePause: () => {
        // Safari keeps focus on the last stage input after a mouse click elsewhere; drop it so Play sticks.
        const stage = document.getElementById("lf-stage");
        const a = document.activeElement;
        if (stage && a instanceof HTMLElement && stage.contains(a)) a.blur();
        claim(); // an explicit Play takes the autoplay slot
        dispatch({ type: "togglePause" });
      },
      stagePointerDown: (pointerType) => {
        if (pointerType !== "touch") dispatch({ type: "stop" });
      },
      takeOver: () => dispatch({ type: "stop" }),
      pickDest: (id) => dispatch({ type: "user", patch: { dest: id } }),
      slugInput: (raw) => dispatch({ type: "slugInput", raw }),
      slugEnter: () => dispatch({ type: "slugEnter" }),
      useSuggestion: () => dispatch({ type: "useSuggestion" }),
      flipPw: () => dispatch({ type: "flip", key: "pwOn" }),
      pwInput: (v) => dispatch({ type: "user", patch: { pw: String(v || "").slice(0, PW_MAX) } }),
      togglePwShow: () => dispatch({ type: "flip", key: "pwShow" }),
      pickExp: (id) => dispatch({ type: "user", patch: { exp: id } }),
      dateChange: (v) => dispatch({ type: "user", patch: { date: String(v || "") } }),
      flipEnc: () => dispatch({ type: "flip", key: "enc" }),
      copy: () => {
        dispatch({ type: "copyStart" });
        if (derive(stateRef.current).valid) dispatch({ type: "copyDemo" });
      },
      pickTab: (id) => dispatch({ type: "user", patch: { tab: id } }),
    }),
    [claim],
  );

  return <View state={state} on={on} />;
}
