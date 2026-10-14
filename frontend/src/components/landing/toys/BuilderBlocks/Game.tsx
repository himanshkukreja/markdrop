"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import View, { type Handlers } from "./View";
import { PITCH, ROOT_ID, TICK_MS, initialState, reducer, type BlockId } from "./model";
import { useLoopReport, usePlayGrant } from "../../PlayCoordinator";
import { useToyEvents } from "../../useToyEvents";

/**
 * Builder Blocks, interactive. First render is identical to the server frame (initialState).
 *
 * The demo (board "attract") ticks only while the PlayCoordinator grants this toy the page's one
 * autoplay slot, the tab is visible, the
 * demo isn't paused and keyboard focus isn't inside the stage. The first real interaction ends it
 * for good; under prefers-reduced-motion it never starts.
 */
export default function Game() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const rootRef = useRef<HTMLElement | null>(null);
  const [hidden, setHidden] = useState(false);
  const [held, setHeld] = useState(false);
  const dragRef = useRef<{ id: BlockId; from: number; y0: number; scale: number; on: boolean; n: number } | null>(null);
  const reduceRef = useRef(false);

  // Reduced motion: the demo is switched off before it ever ticks.
  useEffect(() => {
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduce = false;
    }
    reduceRef.current = reduce;
    if (reduce) dispatch({ type: "REDUCED_MOTION" });
  }, []);

  useEffect(() => {
    rootRef.current = document.getElementById(ROOT_ID);
  }, []);

  // One autoplay per page (PlayCoordinator).
  const [granted, claim] = usePlayGrant("builder-blocks", () => document.getElementById(ROOT_ID), state.attract && !state.paused);
  useToyEvents("builder-blocks", state.done && !state.attract);

  // Tab visibility.
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // The demo clock.
  const running = state.attract && !state.paused && granted && !hidden && !held;
  useLoopReport("builder-blocks", running);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => dispatch({ type: "TICK" }), TICK_MS);
    return () => window.clearInterval(t);
  }, [running]);

  // Side effects requested by the reducer: focus a control, scroll the preview to a block.
  const fx = state.fx;
  useEffect(() => {
    if (!fx.n) return;
    const root = rootRef.current;
    if (!root) return;
    if (fx.focus) document.getElementById(fx.focus)?.focus();
    const box = root.querySelector<HTMLElement>("#bb-body");
    if (!box) return;
    if (fx.top) {
      box.scrollTop = 0;
      return;
    }
    if (!fx.scroll) return;
    const el = box.querySelector<HTMLElement>(`[data-pv="${fx.scroll}"]`);
    if (!el) return;
    const br = box.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const top = er.top - br.top + box.scrollTop - 14;
    const view = box.clientHeight;
    if (top < box.scrollTop || top + er.height > box.scrollTop + view) {
      const target = Math.max(0, Math.min(top, box.scrollHeight - view));
      try {
        box.scrollTo({ top: target, behavior: reduceRef.current ? "auto" : "smooth" });
      } catch {
        box.scrollTop = target;
      }
    }
  }, [fx]);

  const stackRef = useRef(state.stack);
  stackRef.current = state.stack;

  const onGripMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = (e.clientY - d.y0) / d.scale;
    if (!d.on && Math.abs(dy) < 5) return;
    d.on = true;
    const n = d.n;
    const to = Math.max(0, Math.min(n - 1, Math.round(d.from + dy / PITCH)));
    const lo = -d.from * PITCH - 12;
    const hi = (n - 1 - d.from) * PITCH + 12;
    dispatch({ type: "DRAG_MOVE", drag: { id: d.id, from: d.from, to, dy: Math.max(lo, Math.min(hi, dy)) } });
  }, []);

  const on = useMemo<Handlers>(
    () => ({
      togglePause: () => {
        claim(); // an explicit Play takes the autoplay slot
        dispatch({ type: "TOGGLE_PAUSE" });
      },
      startOver: () => dispatch({ type: "START_OVER" }),
      toggleChip: (id) => dispatch({ type: "TOGGLE", id }),
      move: (id, dir, kind) => dispatch({ type: "MOVE", id, dir, kind }),
      remove: (id) => dispatch({ type: "REMOVE", id }),
      gripKey: (e, id) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        dispatch({ type: "MOVE", id, dir: e.key === "ArrowUp" ? -1 : 1, kind: "grip" });
      },
      gripDown: (e, id) => {
        if (e.button !== undefined && e.button !== 0) return;
        dispatch({ type: "INTERACT" });
        const list = e.currentTarget.closest<HTMLElement>("[role='group']");
        const r = list?.getBoundingClientRect();
        const scale = list && list.offsetHeight && r ? r.height / list.offsetHeight : 1;
        const st = stackRef.current;
        dragRef.current = { id, from: st.indexOf(id), y0: e.clientY, scale: scale || 1, on: false, n: st.length };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* no capture */
        }
      },
      gripMove: onGripMove,
      gripUp: () => {
        const d = dragRef.current;
        dragRef.current = null;
        dispatch({ type: "DRAG_END", active: !!d?.on });
      },
      gripCancel: () => {
        dragRef.current = null;
        dispatch({ type: "DRAG_CANCEL" });
      },
      setView: (view) => dispatch({ type: "SET_VIEW", view }),
      slug: (e) => dispatch({ type: "SLUG", raw: e.target.value }),
      publish: () => dispatch({ type: "PUBLISH" }),
      download: () => dispatch({ type: "DOWNLOAD" }),
      // Keyboard focus inside the stage holds the demo, so nothing moves under the reader.
      stageFocus: () => setHeld(true),
      stageBlur: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
      },
    }),
    [onGripMove, claim],
  );

  return <View state={state} on={on} />;
}
