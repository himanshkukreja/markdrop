"use client";

import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import View, { ADD_ID, FRAME_ID, GATE_BTN_ID, PP_ID, RELOCK_ID, ROOT_ID, VID_TOGGLE_ID, type Handlers } from "./View";
import { FILES, TICK_MS, initialState, isBusy, reducer, type Action, type FileId } from "./model";
import { useLoopReport, usePlayGrant } from "../../PlayCoordinator";
import { useToyEvents } from "../../useToyEvents";

/** Board: a click within 350ms of a drop is the tail of the drag, not a pick. */
const CLICK_AFTER_DRAG_MS = 350;
/** Board: a press becomes a drag after 8px of travel. */
const DRAG_SLOP = 8;

type Drag = { id: FileId; x0: number; y0: number; on: boolean };

function focusId(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/**
 * Render Bench, interactive half. First render is `View(initialState)`, identical to the server poster.
 * The demo (attract mode) runs only while the PlayCoordinator grants this toy the page's one autoplay
 * slot (the browser frame at least half on screen and the most visible), the tab is visible, keyboard
 * focus is not inside the bench and reduced motion is off. Any interaction other
 * than Pause/Play ends it for good (the reducer's `interact`).
 */
export default function Game() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [visible, setVisible] = useState(true);
  const [held, setHeld] = useState(false);
  const drag = useRef<Drag | null>(null);
  const dragAt = useRef(0);

  // Reduced motion: the demo never runs, and uploads land without the in-between frames.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const apply = () => dispatch({ type: "SET_REDUCE", reduce: mq.matches });
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // One autoplay per page: the frame (not the whole tall section) is what must be on screen.
  const [granted, claim] = usePlayGrant("render-bench", () => document.getElementById(FRAME_ID), state.attract && !state.paused && !state.reduce);

  // Hidden tabs freeze everything (the board's tick returns while document.hidden).
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  const attractOn = granted && visible && !held && !state.reduce;
  const demoRunning = state.attract && !state.paused && attractOn;
  const running = visible && (isBusy(state) || demoRunning);
  useLoopReport("render-bench", demoRunning);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => dispatch({ type: "TICK", dt: TICK_MS, attractOn: attractOn && !drag.current }), TICK_MS);
    return () => window.clearInterval(t);
  }, [running, attractOn]);

  // All seven rendered: the section's CTA glows (the board's `.cta.win`). The CTA is server HTML
  // outside the island, so the flag goes on the section.
  const all = FILES.every((f) => state.done[f.id]);
  useToyEvents("render-bench", all);
  useEffect(() => {
    const sec = document.getElementById(ROOT_ID)?.closest("section#render-bench");
    if (!sec) return;
    if (all) sec.setAttribute("data-rb-all", "");
    else sec.removeAttribute("data-rb-all");
  }, [all]);

  const on = useMemo<Handlers>(() => {
    const overFrame = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return !!el?.closest("#" + FRAME_ID);
    };
    const rootPoint = (x: number, y: number) => {
      const r = document.getElementById(ROOT_ID)?.getBoundingClientRect();
      return r ? { x: x - r.left, y: y - r.top } : null;
    };
    const endDrag = () => {
      drag.current = null;
    };

    return {
      dispatch(a: Action) {
        if (a.type === "TOGGLE_PAUSE") claim(); // an explicit Play takes the autoplay slot
        dispatch(a);
      },
      pick(id) {
        if (Date.now() - dragAt.current < CLICK_AFTER_DRAG_MS) return;
        dispatch({ type: "PICK", id });
      },
      cardKey(e: KeyboardEvent<HTMLElement>, i: number) {
        const plank = e.currentTarget.parentElement;
        const tpl = plank ? getComputedStyle(plank).gridTemplateColumns : "none";
        const cols = plank && getComputedStyle(plank).display === "grid" && tpl !== "none" ? tpl.split(" ").filter(Boolean).length : 1;
        const map: Record<string, number> = cols > 1
          ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }
          : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
        const d = map[e.key];
        if (d === undefined) return;
        e.preventDefault();
        const j = Math.max(0, Math.min(FILES.length, i + d));
        document.getElementById(j === FILES.length ? ADD_ID : "rb-f-" + FILES[j].id)?.focus();
      },
      cardDown(e: PointerEvent<HTMLButtonElement>, id: FileId) {
        // Drag is a mouse/pen nicety; on touch screens a tap renders the file and a swipe scrolls.
        if (e.pointerType === "touch" || e.button !== 0) return;
        drag.current = { id, x0: e.clientX, y0: e.clientY, on: false };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* capture is optional */
        }
      },
      pointerMove(e: PointerEvent<HTMLButtonElement>) {
        const d = drag.current;
        if (!d) return;
        if (!d.on && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_SLOP) return;
        d.on = true;
        const p = rootPoint(e.clientX, e.clientY);
        if (p) dispatch({ type: "DRAG_MOVE", id: d.id, x: p.x, y: p.y, hot: overFrame(e.clientX, e.clientY) });
      },
      pointerUp(e: PointerEvent<HTMLButtonElement>) {
        const d = drag.current;
        endDrag();
        if (!d || !d.on) return;
        dragAt.current = Date.now();
        dispatch({ type: "DRAG_END", id: d.id, hot: overFrame(e.clientX, e.clientY) });
      },
      pointerCancel() {
        endDrag();
        dispatch({ type: "DRAG_CANCEL" });
      },
      unlock() {
        dispatch({ type: "UNLOCK" });
        focusId(RELOCK_ID);
      },
      relock() {
        dispatch({ type: "RELOCK" });
        focusId(GATE_BTN_ID);
      },
      vidBig() {
        dispatch({ type: "VID_TOGGLE" });
        focusId(VID_TOGGLE_ID);
      },
      // Keyboard focus inside the bench holds the demo, so nothing swaps under a keyboard user.
      // Pause/Play itself is exempt, or pressing Play would hold the demo it just started.
      focusIn(e) {
        const t = e.target as HTMLElement;
        let kb = false;
        try {
          kb = t.matches(":focus-visible");
        } catch {
          kb = false;
        }
        setHeld(kb && t.id !== PP_ID);
      },
      focusOut(e) {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setHeld(false);
      },
    };
  }, [claim]);

  return <View state={state} on={on} />;
}
