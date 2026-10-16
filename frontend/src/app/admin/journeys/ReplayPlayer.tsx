"use client";

import "@posthog/rrweb/dist/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, IconButton, SegmentedControl, Skeleton, Switch, cx } from "@/components/ui";
import { isUnauthorized, useOnUnauthorized } from "../shared";
import { JourneysError, jget, type SnapshotsRes } from "./api";
import { PhErrorState, clock } from "./bits";

type RrEvent = { type: number; timestamp: number; data?: { width?: number; height?: number; href?: string } };
type ReplayerT = import("@posthog/rrweb").Replayer;

const SPEEDS = ["1", "2", "4", "8"] as const;
type Speed = (typeof SPEEDS)[number];

/**
 * One PostHog session recording, played inside the admin with rrweb's Replayer (the recorder
 * family posthog-js uses). Snapshots come from our API, already decompressed; nothing is shared
 * publicly (no PostHog share link). The replay renders in rrweb's sandboxed iframe, so recorded
 * scripts never run. Scaled to fit; seek, speed and skip-idle.
 *
 * Opens inline under its row or session, one at a time (the parent decides).
 */
export function ReplayPlayer({ token, id, title, appUrl, onClose }: {
  token: string; id: string; title?: string | null; appUrl?: string | null; onClose: () => void;
}) {
  const onUnauthorized = useOnUnauthorized();
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const replayer = useRef<ReplayerT | null>(null);
  const viewport = useRef({ width: 1280, height: 800 });
  const [state, setState] = useState<"loading" | "ready" | "missing" | "empty" | "error">("loading");
  const [error, setError] = useState<JourneysError | null>(null);
  const [link, setLink] = useState<string | null>(appUrl ?? null);
  const [nonce, setNonce] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeed] = useState<Speed>("1");
  const [skip, setSkip] = useState(true);

  const fit = useCallback(() => {
    const r = replayer.current;
    const stage = stageRef.current;
    if (!r || !stage) return;
    const { width, height } = viewport.current;
    const avail = stage.clientWidth;
    const maxH = Math.max(220, Math.min(window.innerHeight * 0.62, 640));
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
    setError(null);
    (async () => {
      try {
        const [res, { Replayer }] = await Promise.all([
          jget<SnapshotsRes>(token, `/recordings/${encodeURIComponent(id)}/snapshots`),
          import("@posthog/rrweb"),
        ]);
        if (cancelled) return;
        if (res.app_url) setLink(res.app_url);
        if (!res.found) {
          setState("missing");
          return;
        }
        const list = (res.events as RrEvent[]).filter((e) => e && typeof e.type === "number" && typeof e.timestamp === "number");
        if (list.length < 2 || !list.some((e) => e.type === 2)) {
          setState("empty");
          return;
        }
        const meta = list.find((e) => e.type === 4);
        if (meta?.data?.width && meta.data.height) viewport.current = { width: meta.data.width, height: meta.data.height };
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
        r.play();
        setPlaying(true);
        const tick = () => {
          if (replayer.current) setCurrent(replayer.current.getCurrentTime());
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (cancelled) return;
        if (isUnauthorized(e)) {
          onUnauthorized();
          return;
        }
        setError(e instanceof JourneysError ? e : new JourneysError(0, e instanceof Error ? e.message : "Couldn't load the recording"));
        setState("error");
      }
    })();
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    const host = hostRef.current;
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
      if (host) host.innerHTML = "";
    };
  }, [token, id, fit, nonce, onUnauthorized]);

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
    replayer.current?.setConfig({ speed: Number(speed), skipInactive: skip });
  }, [speed, skip]);

  // Size the stage once it is laid out.
  useEffect(() => {
    if (state === "ready") fit();
  }, [state, fit]);

  const ready = state === "ready";
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border-strong bg-bg">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-1 pl-3 pr-1">
        <p className="min-w-0 flex-1 truncate font-mono text-caption text-text-secondary">
          <span aria-hidden className="text-accent-text">▶ </span>replay · <span className="text-text">{title || "recording"}</span>{" "}
          <span className="text-text-muted">#{id.slice(-8)}</span>
        </p>
        <div className="flex items-center gap-1">
          {link && (
            <Button size="sm" variant="ghost" iconRight="external" href={link} target="_blank" rel="noopener noreferrer">
              <span className="max-sm:hidden">Open in&nbsp;</span>PostHog<span className="md-visually-hidden"> (opens in a new tab)</span>
            </Button>
          )}
          <IconButton icon="x" label="Close replay" onClick={onClose} className="size-10" />
        </div>
      </div>

      <div ref={stageRef} className={cx("flex w-full min-w-0 items-start justify-center overflow-hidden bg-surface-inset", ready && "min-h-55")}>
        <div ref={hostRef} className="relative overflow-hidden" role="img" aria-label={`Session recording ${id.slice(-8)}`} />
      </div>
      {state === "loading" && (
        <div className="p-3" aria-busy="true">
          <span className="md-visually-hidden">Loading the recording</span>
          <Skeleton variant="rect" height="auto" className="aspect-16/10 max-h-[62vh] w-full" />
        </div>
      )}

      {state === "missing" && (
        <div className="px-4 py-8 text-center">
          <p className="font-mono text-caption text-text-muted">replay → 404</p>
          <p className="mt-1 text-body-strong text-text">No recording for this session</p>
          <p className="mx-auto mt-1 max-w-prose text-body text-text-secondary">
            PostHog skips very short sessions, browsers that sent Do Not Track or declined cookies, and anything past the replay
            retention (30 days on the free plan).
          </p>
        </div>
      )}
      {state === "empty" && (
        <div className="px-4 py-8 text-center">
          <p className="text-body-strong text-text">Nothing to play yet</p>
          <p className="mx-auto mt-1 max-w-prose text-body text-text-secondary">This recording has no page snapshot. It may still be uploading; try again in a minute.</p>
          <Button size="sm" variant="secondary" iconLeft="refresh" className="mt-3" onClick={() => setNonce((n) => n + 1)}>Try again</Button>
        </div>
      )}
      {state === "error" && (
        <div className="p-3">
          <PhErrorState error={error} title="Couldn't open this replay" onRetry={() => setNonce((n) => n + 1)} />
        </div>
      )}

      {ready && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2">
          <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} variant="secondary" onClick={toggle} />
          <span className="w-24 shrink-0 font-mono text-caption tabular-nums text-text-secondary">{clock(current / 1000)} / {clock(total / 1000)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(total, 1)}
            step={100}
            value={Math.min(current, total)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Position in the recording"
            aria-valuetext={`${clock(current / 1000)} of ${clock(total / 1000)}`}
            className="h-6 min-w-32 flex-1 accent-(--accent)"
          />
          <SegmentedControl<Speed>
            size="sm"
            aria-label="Playback speed"
            value={speed}
            onChange={setSpeed}
            options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))}
          />
          <Switch label="Skip idle" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          <Button size="sm" variant="ghost" iconLeft="rotate" onClick={() => seek(0)}>Restart</Button>
        </div>
      )}
      <p className="border-t border-border px-3 py-2 font-mono text-micro text-text-muted">
        plays inside the admin; nothing is shared publicly · inputs are masked · document pages are never recorded
      </p>
    </div>
  );
}
