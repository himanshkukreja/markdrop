"use client";

import "@posthog/rrweb/dist/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, EmptyState, IconButton, MarkdropLoader, SegmentedControl, Switch } from "@/components/ui";
import { journeys } from "./api";

type RrEvent = { type: number; timestamp: number; data?: { width?: number; height?: number; href?: string } };
type ReplayerT = import("@posthog/rrweb").Replayer;

const SPEEDS = [1, 2, 4, 8] as const;

export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * Plays one PostHog session recording inside the admin, with rrweb's Replayer (the same recorder
 * family posthog-js uses). Snapshots come from our API, already decompressed. The replay renders
 * in rrweb's sandboxed iframe: recorded scripts never run. Scaled to fit the stage.
 */
export function ReplayPlayer({ token, recordingId }: { token: string; recordingId: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const replayer = useRef<ReplayerT | null>(null);
  const viewport = useRef({ width: 1280, height: 800 });
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [skip, setSkip] = useState(true);
  const [href, setHref] = useState<string | null>(null);

  const fit = useCallback(() => {
    const r = replayer.current;
    const stage = stageRef.current;
    if (!r || !stage) return;
    const { width, height } = viewport.current;
    const avail = stage.clientWidth;
    const maxH = Math.max(240, window.innerHeight * 0.62);
    const scale = Math.min(avail / width, maxH / height, 1);
    r.wrapper.style.transform = `scale(${scale})`;
    r.wrapper.style.transformOrigin = "top left";
    if (hostRef.current) {
      hostRef.current.style.width = `${width * scale}px`;
      hostRef.current.style.height = `${height * scale}px`;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    setState("loading");
    (async () => {
      try {
        const [{ events }, { Replayer }] = await Promise.all([journeys.snapshots(token, recordingId), import("@posthog/rrweb")]);
        if (cancelled) return;
        const list = (events as RrEvent[]).filter((e) => e && typeof e.type === "number" && typeof e.timestamp === "number");
        if (list.length < 2 || !list.some((e) => e.type === 2)) {
          setState("empty");
          return;
        }
        const meta = list.find((e) => e.type === 4);
        if (meta?.data?.width && meta.data.height) viewport.current = { width: meta.data.width, height: meta.data.height };
        setHref(meta?.data?.href ?? null);
        const r = new Replayer(list as never, {
          root: hostRef.current!,
          skipInactive: true,
          showWarning: false,
          showDebug: false,
          triggerFocus: false,
          mouseTail: { duration: 600, lineCap: "round", lineWidth: 3, strokeStyle: "#5B8DEF" },
          UNSAFE_replayCanvas: false,
          speed: 1,
        });
        replayer.current = r;
        r.on("resize", (d: unknown) => {
          const dim = d as { width: number; height: number };
          if (dim?.width && dim?.height) viewport.current = { width: dim.width, height: dim.height };
          fit();
        });
        r.on("finish", () => setPlaying(false));
        setTotal(r.getMetaData().totalTime);
        setState("ready");
        fit();
        r.play();
        setPlaying(true);
        const tick = () => {
          if (replayer.current) setCurrent(replayer.current.getCurrentTime());
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Couldn't load the recording");
        setState("error");
      }
    })();
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      try {
        replayer.current?.pause();
        replayer.current?.destroy();
      } catch {
        /* already torn down */
      }
      replayer.current = null;
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, [token, recordingId, fit]);

  const toggle = useCallback(() => {
    const r = replayer.current;
    if (!r) return;
    if (playing) {
      r.pause();
      setPlaying(false);
    } else {
      const at = r.getCurrentTime();
      r.play(at >= total - 50 ? 0 : at);
      setPlaying(true);
    }
  }, [playing, total]);

  const seek = (ms: number) => {
    const r = replayer.current;
    if (!r) return;
    if (playing) r.play(ms);
    else r.pause(ms);
    setCurrent(ms);
  };

  useEffect(() => {
    replayer.current?.setConfig({ speed, skipInactive: skip });
  }, [speed, skip]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {href && <p className="truncate font-mono text-caption text-text-muted" title={href}>{href}</p>}
      <div ref={stageRef} className="relative flex min-h-60 w-full min-w-0 items-start justify-center overflow-hidden rounded-lg border border-border bg-surface-inset">
        <div ref={hostRef} className="relative overflow-hidden" aria-label="Session recording" role="img" />
        {state === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center"><MarkdropLoader size="sm" label="Loading the recording" /></div>
        )}
        {state === "empty" && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <EmptyState icon="film" title="Nothing to play yet" description="This recording has no page snapshot. It may still be uploading; try again in a minute." />
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <Alert tone="danger" title="Couldn't load the recording">{error}</Alert>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} variant="secondary" onClick={toggle} disabled={state !== "ready"} />
        <span className="w-24 shrink-0 font-mono text-caption tabular-nums text-text-secondary">{clock(current)} / {clock(total)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(total, 1)}
          step={100}
          value={Math.min(current, total)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={state !== "ready"}
          aria-label="Position in the recording"
          aria-valuetext={`${clock(current)} of ${clock(total)}`}
          className="min-w-40 flex-1 accent-(--accent)"
        />
        <SegmentedControl
          size="sm"
          aria-label="Playback speed"
          value={String(speed)}
          onChange={(v) => setSpeed(Number(v) as (typeof SPEEDS)[number])}
          options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
        />
        <Switch label="Skip idle" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
        <Button size="sm" variant="ghost" iconLeft="rotate" onClick={() => seek(0)} disabled={state !== "ready"}>Restart</Button>
      </div>
    </div>
  );
}
