"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import View, { type Handlers } from "./View";
import {
  ACCENTS,
  COPIED_MS,
  LOGOS,
  TICK_MS,
  checkTarget,
  copyTarget,
  initialState,
  reducer,
  rowTarget,
  txtBlocked,
  type CopyKey,
} from "./model";
import { useLoopReport, usePlayGrant } from "../../PlayCoordinator";
import { useToyEvents } from "../../useToyEvents";

/** Focus a control inside this toy by its stable id (scoped, so other sections' ids never match). */
function focusIn(id: string, opts?: FocusOptions): boolean {
  const root = document.getElementById("ds-root");
  const el = root?.querySelector<HTMLElement>("#" + CSS.escape(id));
  if (!el) return false;
  el.focus(opts);
  return true;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The playable Domain Studio. First render = View(initialState), the same frame the server sent.
 *
 * Motion rules: the attract demo (accent every 2.4s, logo every 4.8s, chrome every 9.6s) only
 * advances while the PlayCoordinator grants this toy the page's one autoplay slot, the tab is visible
 * and focus is not inside the toy. It
 * never starts under prefers-reduced-motion, stops for good on the first real input, and the
 * Pause/Play button controls it (WCAG 2.2.2). The DNS "Verifying" step is a 1.8s simulated wait;
 * nothing here touches the network.
 */
export default function Game() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [tabVisible, setTabVisible] = useState(true);
  const [held, setHeld] = useState(false);
  const alive = useRef(true);
  const copyTimer = useRef<number | undefined>(undefined);
  /** After "I added the CNAME" the button leaves the DOM; focus parks on the DNS body, then returns. */
  const parkFocus = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(copyTimer.current);
    };
  }, []);

  /* Reduced motion: the demo never autoplays (base styles already show finished frames). */
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    } catch {
      return;
    }
    const apply = () => {
      setReduced(mq!.matches);
      if (mq!.matches) dispatch({ type: "STOP_DEMO" });
    };
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq!.removeEventListener?.("change", apply);
  }, []);

  /* One autoplay per page (PlayCoordinator), tab visible, focus not inside. */
  const [granted, claim] = usePlayGrant("domain-studio", () => document.getElementById("ds-root"), state.attract && !reduced);
  useToyEvents("domain-studio", Object.values(state.done).every(Boolean));
  useEffect(() => {
    const root = document.getElementById("ds-root");
    if (!root) return;
    const onVis = () => setTabVisible(!document.hidden);
    onVis();
    document.addEventListener("visibilitychange", onVis);
    /* Keyboard or screen-reader focus anywhere in the toy holds the demo, so nothing changes
       under the reader; the Pause button itself is exempt (it says what it will do). */
    const onIn = (e: FocusEvent) => setHeld((e.target as HTMLElement | null)?.id !== "ds-play");
    const onOut = (e: FocusEvent) => {
      if (!root.contains(e.relatedTarget as Node | null)) setHeld(false);
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    if (root.contains(document.activeElement)) setHeld(document.activeElement?.id !== "ds-play");
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
    };
  }, []);

  /* One 100ms clock: the attract demo when allowed, and the simulated DNS lookup while verifying. */
  const demo = state.attract && granted && tabVisible && !held && !reduced;
  useLoopReport("domain-studio", demo);
  const verifying = state.step === 2;
  useEffect(() => {
    if (!demo && !verifying) return;
    const id = window.setInterval(() => dispatch({ type: "TICK", dt: TICK_MS, demo }), TICK_MS);
    return () => window.clearInterval(id);
  }, [demo, verifying]);

  /* Keep keyboard focus in the DNS card while its buttons swap out. */
  useEffect(() => {
    if (state.step === 2 && parkFocus.current) focusIn("ds-dns-body", { preventScroll: true });
    if (state.step === 3 && parkFocus.current) {
      parkFocus.current = false;
      const active = document.activeElement;
      if (!active || active === document.body || active.id === "ds-dns-body") focusIn("ds-dns-go", { preventScroll: true });
    }
    if (state.step !== 2 && state.step !== 3) parkFocus.current = false;
  }, [state.step]);

  const copy = (key: CopyKey) => {
    const t = copyTarget(state, key);
    if (!t.ready) {
      /* No real host yet, so there is nothing worth copying. */
      dispatch({ type: "COPY_NO_HOST" });
      focusIn("ds-dom");
      return;
    }
    dispatch({ type: "ENGAGE" });
    const done = () => {
      if (!alive.current) return;
      dispatch({ type: "COPIED", key });
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => dispatch({ type: "COPY_CLEAR", key }), COPIED_MS);
    };
    const blocked = () => {
      if (alive.current) dispatch({ type: "COPY_BLOCKED", key });
    };
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(t.text).then(done, blocked);
        return;
      }
    } catch {
      /* clipboard blocked: fall through */
    }
    blocked();
  };

  const on: Handlers = {
    togglePlay: () => {
      claim(); // an explicit Play takes the autoplay slot
      dispatch({ type: "TOGGLE_PLAY" });
    },
    company: (value) => dispatch({ type: "COMPANY", value }),
    domain: (value) => dispatch({ type: "DOMAIN", value }),
    pickAcc: (i) => dispatch({ type: "PICK_ACC", i }),
    accKey: (e, i) => {
      const j = rowTarget(e.key, i, ACCENTS.length);
      if (j < 0) return;
      e.preventDefault();
      dispatch({ type: "PICK_ACC", i: j });
      focusIn("ds-sw-" + j);
    },
    pickLogo: (i) => dispatch({ type: "PICK_LOGO", i }),
    logoKey: (e, i) => {
      const j = rowTarget(e.key, i, LOGOS.length);
      if (j < 0) return;
      e.preventDefault();
      dispatch({ type: "PICK_LOGO", i: j });
      focusIn("ds-lg-" + j);
    },
    chrome: (value) => dispatch({ type: "CHROME", value }),
    toggleSignin: () => dispatch({ type: "TOGGLE_SIGNIN" }),
    viewAs: (value) => dispatch({ type: "VIEW_AS", value }),
    addedTxt: () => {
      const refuse = txtBlocked(state);
      dispatch({ type: "ADDED_TXT" });
      if (refuse) focusIn("ds-dom");
    },
    addedCname: () => {
      parkFocus.current = !reduced && document.activeElement?.id === "ds-dns-go";
      dispatch({ type: "ADDED_CNAME", reduce: reduced });
    },
    backDns: () => {
      const hadFocus = document.activeElement?.id === "ds-dns-back";
      dispatch({ type: "BACK_DNS" });
      if (hadFocus) window.requestAnimationFrame(() => focusIn("ds-dns-go"));
    },
    restartDns: () => dispatch({ type: "RESTART_DNS" }),
    copy,
    email: (value) => dispatch({ type: "EMAIL", value }),
    emailKey: (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      dispatch({ type: "INVITE" });
    },
    role: (value) => dispatch({ type: "ROLE", value }),
    invite: () => dispatch({ type: "INVITE" }),
    /* Checklist chips move focus to the control that does the job. */
    check: (k) => {
      if (!focusIn(checkTarget(state, k)) && k === "live") {
        dispatch({ type: "SAY", msg: "Checking both records for " + state.dnsHost + ". One moment." });
      }
    },
    reset: () => dispatch({ type: "RESET" }),
  };

  return <View state={state} on={on} />;
}
