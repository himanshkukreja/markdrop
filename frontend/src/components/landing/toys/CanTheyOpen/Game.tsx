"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import View, { type Handlers } from "./View";
import { CLOCK_START, DEVICES, RESUME_AT, STEP_MS, THINGS, TICK_MS, initialState, reducer, tally, type DevId, type ThingId } from "./model";
import { useLoopReport, usePlayGrant } from "../../PlayCoordinator";
import { useToyEvents } from "../../useToyEvents";

type Drag = { id: ThingId; x0: number; y0: number; moved: boolean };

/**
 * The live half of "Can they open it?". First render = View(initialState), the server's static frame.
 *
 * Demo (attract) loop: one send every 3.6s, ticking only while the PlayCoordinator grants this toy the
 * page's one autoplay slot, the tab is visible and the visitor has not asked for reduced motion. Any pick, drag or Pause stops it; only
 * the Play button starts it again. Drag is mouse-only (touch taps, so the page still scrolls).
 */
export default function Game() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [pageVisible, setPageVisible] = useState(true);
  const [reduced, setReduced] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const attractRef = useRef(state.attract);
  const clock = useRef(CLOCK_START);
  const drag = useRef<Drag | null>(null);
  const noClickUntil = useRef(0);
  const frame = useRef(0);
  const pending = useRef<{ x: number; y: number; hot: boolean; first: boolean } | null>(null);

  useEffect(() => {
    attractRef.current = state.attract;
  }, [state.attract]);

  /* Reduced motion: the demo never runs. */
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const apply = () => {
      setReduced(mq.matches);
      if (mq.matches) dispatch({ type: "stopDemo" });
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  /* One autoplay per page (PlayCoordinator). */
  const [granted, claim] = usePlayGrant("can-they-open", () => rootRef.current, state.attract && !reduced);
  useToyEvents("can-they-open", !state.attract && DEVICES.some((d) => tally(state.tried, d.id).n === THINGS.length));

  /* Only while the tab is visible. */
  useEffect(() => {
    const on = () => setPageVisible(!document.hidden);
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  /* The board's 100ms tick. The clock lives in a ref, so the tree re-renders only on a send. */
  const dragging = state.ghost !== null;
  const running = state.attract && granted && pageVisible && !reduced && !dragging;
  useLoopReport("can-they-open", running);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      if (drag.current) return;
      clock.current += TICK_MS;
      if (clock.current < STEP_MS) return;
      clock.current = 0;
      dispatch({ type: "demoStep" });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  /* Escape drops a drag without sending. */
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      drag.current = null;
      pending.current = null;
      dispatch({ type: "dragCancel" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const flush = useCallback(() => {
    frame.current = 0;
    const p = pending.current;
    const d = drag.current;
    pending.current = null;
    if (!p || !d) return;
    dispatch({ type: "dragMove", ghost: { id: d.id, x: p.x, y: p.y }, hot: p.hot, first: p.first });
  }, []);

  const handlers = useMemo<Handlers>(
    () => ({
      root: rootRef,
      pickDev: (id: DevId) => dispatch({ type: "pickDev", id }),
      pickThing: (id: ThingId) => {
        if (Date.now() < noClickUntil.current) return; // the click that ends a drag
        dispatch({ type: "pickThing", id });
      },
      togglePause: () => {
        claim(); // an explicit Play takes the autoplay slot
        if (!attractRef.current) clock.current = RESUME_AT;
        dispatch({ type: "togglePause" });
      },
      thingDown: (id: ThingId, e: ReactPointerEvent<HTMLButtonElement>) => {
        if (e.pointerType !== "mouse" || e.button !== 0) return;
        drag.current = { id, x0: e.clientX, y0: e.clientY, moved: false };
      },
      pointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x0;
        const dy = e.clientY - d.y0;
        if (!d.moved && Math.hypot(dx, dy) < 6) return;
        const root = rootRef.current;
        if (!root) return;
        const r = root.getBoundingClientRect();
        const first = !d.moved;
        d.moved = true;
        let hot = false;
        try {
          const under = document.elementFromPoint(e.clientX, e.clientY);
          hot = !!under?.closest("[data-cto-lanes]");
        } catch {
          hot = false;
        }
        const prevFirst = pending.current?.first ?? false;
        pending.current = { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top), hot, first: first || prevFirst };
        if (!frame.current) frame.current = requestAnimationFrame(flush);
      },
      pointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        drag.current = null;
        if (!d || !d.moved) return;
        noClickUntil.current = Date.now() + 400;
        // Settle the last position first, so the drop sees whether it was over the lanes.
        if (frame.current) {
          cancelAnimationFrame(frame.current);
          frame.current = 0;
        }
        let hot = false;
        try {
          hot = !!document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-cto-lanes]");
        } catch {
          hot = false;
        }
        const p = pending.current;
        pending.current = null;
        dispatch({ type: "dragMove", ghost: { id: d.id, x: p?.x ?? 0, y: p?.y ?? 0 }, hot, first: p?.first ?? false });
        dispatch({ type: "drop", id: d.id });
      },
      pointerCancel: () => {
        if (!drag.current) return;
        drag.current = null;
        pending.current = null;
        dispatch({ type: "dragCancel" });
      },
    }),
    [flush, claim],
  );

  return <View state={state} on={handlers} />;
}
