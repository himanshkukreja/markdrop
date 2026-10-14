"use client";

/**
 * Orbit hero, interactive half. Loaded by <LazyIsland name="hero" when="idle"> after first paint; it
 * mounts with the same state the server poster drew, so the swap is invisible.
 *
 * - One 100 ms clock (TICK) drives attract beats and the finale timer. It runs only while the hero is in
 *   view and the tab is visible, and only while something is pending (a finale due, or attract playing
 *   while the PlayCoordinator grants the hero the page's one autoplay slot).
 * - The view re-renders only when the picture changes (sameView ignores the clocks).
 * - Pointer bookkeeping that the boards keep as Date.now() guards (click-after-drag, tap-after-swipe)
 *   stays here in refs; everything else is the pure reducer in model.ts.
 */
import { memo, useEffect, useMemo, useReducer, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { track } from "@/lib/track";
import View, { type On } from "./View";
import { initialState, keyMoonTarget, reducer, sameView, type State } from "./model";
import { FILES, MOONS, TICK, mod, type FeatId, type FileId, type Form, type MoonId } from "./data";
import { IDLE_RETURN } from "./flags";
import { useLoopReport, usePlayGrant } from "../PlayCoordinator";

const MOBILE_MQ = "(max-width: 767px)";
const REDUCED_MQ = "(prefers-reduced-motion: reduce)";

const mq = (q: string) => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(q).matches;

const MemoView = memo(View, (a, b) => a.form === b.form && a.on === b.on && sameView(a.state, b.state));

/** Keyboard focus (not a mouse press): only then does focus hold the demo or swing a moon round. */
function isKb(e: { target: EventTarget | null }) {
  try { return !!(e.target as Element | null)?.matches?.(":focus-visible"); } catch { return false; }
}

export default function Game() {
  const [form, setForm] = useState<Form>(() => (mq(MOBILE_MQ) ? "mobile" : "desktop"));
  useEffect(() => {
    const m = window.matchMedia(MOBILE_MQ);
    const fn = () => setForm(m.matches ? "mobile" : "desktop");
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return <Orbit key={form} form={form} />;
}

function Orbit({ form }: { form: Form }) {
  const [state, dispatch] = useReducer(reducer, form, (f: Form) => initialState(f, { paused: mq(REDUCED_MQ) }));
  const sref = useRef<State>(state);
  sref.current = state;

  const [inView, setInView] = useState(true);
  const [visible, setVisible] = useState(true);
  const section = useRef<HTMLElement | null>(null);

  /* One autoplaying sequence per page (PlayCoordinator): the attract demo runs only while granted. */
  const wantsAttract = state.mode === "attract" && !state.paused;
  const [granted, claim] = usePlayGrant("hero", () => section.current, wantsAttract);
  const grantRef = useRef(granted);
  grantRef.current = granted;
  const claimRef = useRef(claim);
  claimRef.current = claim;
  useLoopReport("hero", granted && wantsAttract && inView && visible);

  /* Where we live: the hero <section> around the island (the island and the view are display:contents). */
  useEffect(() => {
    section.current = document.querySelector<HTMLElement>('[data-island="hero"]')?.closest("section") ?? null;
    const el = section.current;
    setVisible(document.visibilityState !== "hidden");
    const onVis = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    let io: IntersectionObserver | undefined;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((es) => setInView(es.some((x) => x.isIntersecting)), { threshold: 0.05 });
      io.observe(el);
    }
    /* CTA clicks (landing_cta) are tracked page-wide by CtaTracker, before this chunk even loads. */
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, []);

  /* The clock. Ticks only while the hero is in view, the tab is visible and something is pending. */
  useEffect(() => {
    if (!inView || !visible) return;
    const id = window.setInterval(() => {
      const s = sref.current;
      const live = !s.paused && !s.drag && !s.t.hold && ((s.mode === "attract" && grantRef.current) || (IDLE_RETURN && !s.finale));
      if (s.t.finAt > 0 || live) dispatch({ type: "TICK" });
    }, TICK);
    return () => window.clearInterval(id);
  }, [inView, visible]);

  /* Analytics: first discoveries and the finale (ids only). */
  const prevFound = useRef(state.found);
  useEffect(() => {
    const before = prevFound.current;
    prevFound.current = state.found;
    if (before === state.found) return;
    const n = Object.keys(state.found).length;
    (Object.keys(state.found) as FeatId[]).forEach((id) => { if (!before[id]) track("hero_found", { id, n }); });
  }, [state.found]);
  const finaleSeen = useRef(false);
  useEffect(() => {
    if (state.finale && !finaleSeen.current) { finaleSeen.current = true; track("hero_finale"); }
  }, [state.finale]);

  /* Mobile: entering play scrolls the stage under the sticky header and the passport. Leaving the hero
     in play returns it to the above-the-fold layout, so the fixed sheet never covers other sections. */
  const prevLayout = useRef(state.layout);
  useEffect(() => {
    if (form !== "mobile") return;
    const was = prevLayout.current;
    prevLayout.current = state.layout;
    const root = section.current;
    if (!root) return;
    const header = document.querySelector<HTMLElement>("header");
    const pos = header ? getComputedStyle(header).position : "";
    const hh = header && (pos === "sticky" || pos === "fixed") ? Math.round(header.getBoundingClientRect().height) : 0;
    root.style.setProperty("--hdr-h", hh + "px");
    if (was === "hero" && state.layout === "play") {
      const box = root.querySelector<HTMLElement>("[data-stage]");
      if (box) {
        const top = box.getBoundingClientRect().top + window.scrollY - hh - 76 - 6;
        window.scrollTo({ top: Math.max(0, top), behavior: mq(REDUCED_MQ) ? "auto" : "smooth" });
      }
    }
  }, [form, state.layout]);
  useEffect(() => {
    if (form !== "mobile" || state.layout !== "play") return;
    const box = section.current?.querySelector<HTMLElement>("[data-stage]");
    if (!box || typeof IntersectionObserver === "undefined") return;
    let armed = false;
    const io = new IntersectionObserver((es) => {
      const vis = es.some((x) => x.isIntersecting);
      if (vis) armed = true;
      else if (armed) dispatch({ type: "LEAVE_PLAY" });
    }, { threshold: 0 });
    io.observe(box);
    return () => io.disconnect();
  }, [form, state.layout]);

  const on = useMemo<On>(() => {
    const drag = { cur: null as null | { sx: number; sy: number; r: DOMRect; k: number; moved: boolean } };
    let dragEndAt = 0;
    const sw = { cur: null as null | { x: number; y: number; k: number; file: boolean; cap: boolean } };
    let swEnd = 0;
    let played = false;
    const swiped = () => Date.now() - swEnd < 350;
    const play = (how: "click" | "drag" | "key" | "tap") => {
      if (played) return;
      played = true;
      track("hero_play", { how });
    };
    const howOf = (e: MouseEvent): "click" | "key" | "tap" => {
      if (e.detail === 0) return "key";
      const pt = (e.nativeEvent as globalThis.PointerEvent).pointerType;
      return pt === "touch" || pt === "pen" ? "tap" : "click";
    };
    const pre = form === "mobile" ? "pm" : "po";
    const focusEl = (id: string) => { try { document.getElementById(id)?.focus(); } catch { /* focus is a nicety */ } };
    const framePoint = (e: PointerEvent, d: { r: DOMRect; k: number }) => ({ x: (e.clientX - d.r.left) / d.k, y: (e.clientY - d.r.top) / d.k });

    return {
      padClick(e) {
        const kb = e.detail === 0;
        if (!kb && Date.now() - dragEndAt < 450) return;
        play(howOf(e));
        dispatch({ type: "PAD" });
      },
      padDown(e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const el = e.currentTarget;
        const swEl = el.closest<HTMLElement>("[data-sw]");
        if (!swEl) return;
        const r = swEl.getBoundingClientRect();
        if (!r.width) return;
        drag.cur = { sx: e.clientX, sy: e.clientY, r, k: r.width / 1440, moved: false };
        try { el.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
      },
      padMove(e) {
        const d = drag.cur;
        if (!d) return;
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
        d.moved = true;
        dispatch({ type: "DRAG_MOVE", p: framePoint(e, d) });
      },
      padUp(e) {
        const d = drag.cur;
        drag.cur = null;
        if (!d || !d.moved) { dispatch({ type: "DRAG_END" }); return; }
        dragEndAt = Date.now();
        const p = framePoint(e, d);
        let el: Element | null = null;
        try { el = document.elementFromPoint(e.clientX, e.clientY); } catch { el = null; }
        const tg = el?.closest("[data-target]")?.getAttribute("data-target") ?? "";
        dispatch({ type: "DRAG_END" });
        if (tg.startsWith("moon:")) { play("drag"); dispatch({ type: "PICK_MOON", id: tg.slice(5) as MoonId, from: p }); }
        else if (tg.startsWith("file:")) { play("drag"); dispatch({ type: "PICK_FILE", id: tg.slice(5) as FileId, how: "rack" }); }
        else if (tg === "station") { play("drag"); dispatch({ type: "PICK_STATION" }); }
        else dispatch({ type: "DRAG_MISS" });
      },
      padCancel() {
        drag.cur = null;
        dispatch({ type: "DRAG_END" });
      },
      padAim(onAim, e) {
        if (onAim && e && e.type === "focus" && !isKb(e as FocusEvent)) return;
        dispatch({ type: "PAD_AIM", on: onAim });
      },
      stageFocus(e) { if (isKb(e)) dispatch({ type: "HOLD", on: true }); },
      stageBlur(e) {
        const rt = e.relatedTarget as Node | null;
        if (rt && (e.currentTarget as Node).contains(rt)) return;
        dispatch({ type: "HOLD", on: false });
      },
      station(e) {
        if (form === "mobile" && swiped()) return;
        play(howOf(e));
        dispatch({ type: "PICK_STATION" });
      },
      aim(at, e) {
        if (at && e && e.pointerType !== "mouse") return;
        dispatch({ type: "AIM", at });
      },
      tile(id, e) {
        if (form === "mobile" && swiped()) return;
        play(howOf(e));
        dispatch({ type: "PICK_FILE", id, how: "rack" });
      },
      tileKey(i, e: KeyboardEvent) {
        let d = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") d = 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") d = -1;
        if (!d) return;
        e.preventDefault();
        dispatch({ type: "HOLD", on: true });
        focusEl(pre + "-file-" + FILES[mod(i + d, FILES.length)].id);
      },
      moon(id, e) {
        if (form === "mobile" && swiped()) return;
        play(howOf(e));
        dispatch({ type: "PICK_MOON", id });
      },
      moonFocus(id, e) { if (isKb(e)) dispatch({ type: "FOCUS_MOON", id }); },
      moonKey(i, e: KeyboardEvent) {
        const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
        const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
        if (!fwd && !back) return;
        e.preventDefault();
        const dir = fwd ? 1 : -1;
        dispatch({ type: "KEY_MOON", i, dir });
        focusEl(pre + "-moon-" + MOONS[keyMoonTarget(form, i, dir)].id);
      },
      pip(id, e) {
        play(howOf(e));
        dispatch({ type: "PICK_PIP", id });
      },
      pause() {
        claimRef.current(); // an explicit Play takes the autoplay slot
        dispatch({ type: "TOGGLE_PAUSE" });
      },
      relay() { dispatch({ type: "TOGGLE_RELAY" }); },
      reset() { dispatch({ type: "RESET" }); },
      encrypt() { dispatch({ type: "PICK_MOON", id: "encrypt" }); },
      /* Swipe: horizontal travel of 36 stage px. Pointer capture starts only once the finger is clearly
         moving sideways, so a plain tap still lands on the button under it. */
      stageDown(e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const el = e.currentTarget;
        let scale = 1;
        try { const rect = el.getBoundingClientRect(); scale = el.offsetWidth ? rect.width / el.offsetWidth : 1; } catch { scale = 1; }
        const onFile = !!(e.target as Element | null)?.closest?.('[data-swipe="file"]');
        sw.cur = { x: e.clientX, y: e.clientY, k: scale || 1, file: onFile, cap: false };
      },
      stageMove(e) {
        const w = sw.cur;
        if (!w || w.cap) return;
        const dx = (e.clientX - w.x) / w.k;
        const dy = (e.clientY - w.y) / w.k;
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
          w.cap = true;
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture is optional */ }
        }
      },
      stageUp(e) {
        const w = sw.cur;
        sw.cur = null;
        if (!w) return;
        const dx = (e.clientX - w.x) / w.k;
        const dy = (e.clientY - w.y) / w.k;
        if (Math.abs(dx) < 36 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
        swEnd = Date.now();
        play("tap");
        dispatch(w.file ? { type: "STEP_FILE", dir: dx < 0 ? 1 : -1 } : { type: "STEP_MOON", dir: dx < 0 ? 1 : -1 });
      },
      stageCancel() { sw.cur = null; },
      courier(e) {
        if (swiped()) return;
        play(howOf(e));
        dispatch({ type: "PAD" });
      },
      spin(dir, e) {
        if (swiped()) return;
        play(howOf(e));
        dispatch({ type: "STEP_MOON", dir });
      },
      sheet(open) { dispatch({ type: "SHEET", open }); },
    };
  }, [form]);

  return <MemoView state={state} form={form} on={on} />;
}
