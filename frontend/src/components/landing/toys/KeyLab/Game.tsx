"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import View, { type Handlers } from "./View";
import { initialState, reducer, TICK_MS } from "./model";
import { useLoopReport, usePlayGrant } from "../../PlayCoordinator";
import { useToyEvents } from "../../useToyEvents";

type DragInfo = { x: number; y: number; id: number; k: number; moved: boolean; dy: number };

/**
 * Key Lab, interactive. First render = View(initialState), so the swap from the server poster is
 * invisible. The attract demo ticks only while the PlayCoordinator grants this toy the page's one
 * autoplay slot, the tab is visible and no pointer is down; any user input stops it for good (Play demo restarts it on purpose). Reduced motion turns it
 * off at mount.
 */
export default function Game() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [visible, setVisible] = useState(true);
  const drag = useRef<DragInfo | null>(null);
  /** A drag that ends is never also counted as a tap (the board's 400ms click guard). */
  const dragEnd = useRef(0);

  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      mq = null;
    }
    if (!mq) return;
    if (mq.matches) dispatch({ type: "REDUCED_MOTION" });
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) dispatch({ type: "REDUCED_MOTION" });
    };
    mq.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  const [granted, claim] = usePlayGrant("key-lab", () => document.getElementById("kl-stage"), state.attract);
  useToyEvents("key-lab", state.complete);

  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const running = state.attract && granted && visible;
  useLoopReport("key-lab", running);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      if (!drag.current) dispatch({ type: "TICK", dt: TICK_MS });
    }, TICK_MS);
    return () => window.clearInterval(t);
  }, [running]);

  const closeSignin = () => {
    dispatch({ type: "CLOSE_SIGNIN" });
    // The card that held focus is gone, so hand focus back to the button that opened it.
    window.setTimeout(() => document.getElementById("kl-signbtn")?.focus(), 0);
  };

  const on: Handlers = {
    toggleDemo: () => {
      claim(); // an explicit Play takes the autoplay slot
      dispatch({ type: "TOGGLE_DEMO" });
    },
    stageDown: () => dispatch({ type: "INTERACT" }),
    stageFocus: () => dispatch({ type: "INTERACT" }),
    note: (e) => dispatch({ type: "NOTE", value: e.target.value }),
    showServer: () => dispatch({ type: "SHOW_SERVER" }),
    showBrowser: () => dispatch({ type: "SHOW_BROWSER" }),
    toggleKey: () => dispatch({ type: "TOGGLE_KEY" }),
    rotate: () => dispatch({ type: "ROTATE" }),
    toggleSignin: () => dispatch({ type: "TOGGLE_SIGNIN" }),
    closeSignin,
    panelKeyDown: (e) => {
      if (e.key === "Escape" && state.signin) {
        e.preventDefault();
        closeSignin();
      }
    },
    chipClick: () => {
      if (Date.now() - dragEnd.current < 400) return;
      dispatch({ type: "TOGGLE_KEY" });
    },
    chipKeyDown: (e) => {
      if (e.key === "ArrowDown" && !state.keyOut) {
        e.preventDefault();
        dispatch({ type: "KEY_OUT" });
      } else if (e.key === "ArrowUp" && state.keyOut) {
        e.preventDefault();
        dispatch({ type: "KEY_IN" });
      }
    },
    chipPointerDown: (e) => {
      if (e.button !== 0) return;
      const el = e.currentTarget;
      let k = 1;
      const r = el.getBoundingClientRect();
      if (el.offsetWidth) k = r.width / el.offsetWidth || 1;
      drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, k, moved: false, dy: 0 };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture is optional */
      }
    },
    chipPointerMove: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      const dx = (e.clientX - d.x) / d.k;
      const dy = (e.clientY - d.y) / d.k;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      d.moved = true;
      d.dy = dy;
      dispatch({ type: "DRAG_MOVE", dx, dy });
    },
    chipPointerUp: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      if (!d.moved) {
        dispatch({ type: "DRAG_CANCEL" });
        return;
      }
      dragEnd.current = Date.now();
      dispatch({ type: "DRAG_END", dy: d.dy });
    },
    chipPointerCancel: () => {
      drag.current = null;
      dispatch({ type: "DRAG_CANCEL" });
    },
  };

  return <View state={state} on={on} />;
}
