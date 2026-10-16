"use client";

import "@posthog/rrweb/dist/style.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, IconButton, SegmentedControl, Switch, cx } from "@/components/ui";
import { LoadingBlock, isUnauthorized, useOnUnauthorized } from "../shared";
import { JourneysError, jget, nextDelay, type SnapshotsRes } from "./api";
import { PhErrorState, clock } from "./bits";

type RrEvent = { type: number; timestamp: number; data?: { width?: number; height?: number; href?: string } };
type ReplayerT = import("@posthog/rrweb").Replayer;

const SPEEDS = ["1", "2", "4", "8"] as const;
type Speed = (typeof SPEEDS)[number];

/** Live follow: poll for new blobs this often (PostHog's recordings API allows 1,200 calls an hour). */
const LIVE_POLL_MS = 12_000;
/** Start (and "Go live") this far before the newest event, so the next upload lands before the playhead does. */
const LIVE_LEAD_MS = 15_000;
/** No new blob for this long: the session is over (or idle in a background tab). */
const LIVE_IDLE_MS = 5 * 60_000;

const valid = (e: RrEvent) => e && typeof e.type === "number" && typeof e.timestamp === "number";
/** Blobs never overlap, but a retried poll could repeat one: events are deduped by time, type and size. */
const eventKey = (e: RrEvent) => `${e.timestamp}:${e.type}:${e.data ? JSON.stringify(e.data).length : 0}`;

/**
 * One PostHog session recording, played inside the admin with rrweb's Replayer (the recorder
 * family posthog-js uses). Snapshots come from our API, already decompressed; nothing is shared
 * publicly (no PostHog share link). The replay renders in rrweb's sandboxed iframe, so recorded
 * scripts never run. Scaled to fit; seek, speed and skip-idle.
 *
 * `live` (the recording is ongoing): follow it. Every ~12 s only the blobs after the last one we
 * have are fetched (`?after=`) and appended with Replayer.addEvent; the playhead stays near the
 * live edge ("LIVE · 40s behind") unless the admin pauses or scrubs back ("Go live" returns). When
 * the session ends, or nothing new arrives for 5 minutes, it plays on as a normal replay.
 *
 * Opens inline under its row or session, one at a time (the parent decides).
 */
export function ReplayPlayer({ token, id, title, appUrl, onClose, live = false }: {
  token: string; id: string; title?: string | null; appUrl?: string | null; onClose: () => void; live?: boolean;
}) {
  const onUnauthorized = useOnUnauthorized();
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const replayer = useRef<ReplayerT | null>(null);
  const viewport = useRef({ width: 1280, height: 800 });
  const lastKey = useRef<number | null>(null);
  const liveEdge = useRef<number | null>(null);
  const seen = useRef<Set<string>>(new Set());
  // First and newest event times: addEvent lands a microtask later, so the length is tracked here.
  const span = useRef({ start: 0, end: 0 });
  const [state, setState] = useState<"loading" | "ready" | "missing" | "empty" | "error">("loading");
  const [error, setError] = useState<JourneysError | null>(null);
  const [link, setLink] = useState<string | null>(appUrl ?? null);
  const [nonce, setNonce] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const [speed, setSpeed] = useState<Speed>("1");
  const [skip, setSkip] = useState(true);
  // Live follow: the replay was opened live, it is still following the edge, and how far behind.
  const [liveMode, setLiveMode] = useState(false);
  const [following, setFollowing] = useState(false);
  const [ended, setEnded] = useState(false);
  const [behind, setBehind] = useState(0);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const followingRef = useRef(false);
  const endedRef = useRef(false);
  followingRef.current = following;
  endedRef.current = ended;

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
    setLiveNote(null);
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
        const list = (res.events as RrEvent[]).filter(valid);
        if (list.length < 2 || !list.some((e) => e.type === 2)) {
          setState("empty");
          return;
        }
        seen.current = new Set(list.map(eventKey));
        span.current = { start: list[0]!.timestamp, end: list[list.length - 1]!.timestamp };
        lastKey.current = res.last_key ?? null;
        liveEdge.current = res.live_edge ? Date.parse(res.live_edge) : null;
        const follow = live && lastKey.current !== null;
        const meta = list.find((e) => e.type === 4);
        if (meta?.data?.width && meta.data.height) viewport.current = { width: meta.data.width, height: meta.data.height };
        const r = new Replayer(list as never, {
          root: hostRef.current!,
          skipInactive: !follow,
          showWarning: false,
          showDebug: false,
          triggerFocus: false,
          mouseTail: { duration: 600, lineCap: "round", lineWidth: 3, strokeStyle: "#5B8DEF" },
          UNSAFE_replayCanvas: false,
          speed: 1,
          // Live: no "finish" at the end of what we have; new events keep playing as they arrive.
          liveMode: follow,
        });
        replayer.current = r;
        r.on("resize", (d: unknown) => {
          const dim = d as { width: number; height: number };
          if (dim?.width && dim?.height) viewport.current = { width: dim.width, height: dim.height };
          fit();
        });
        r.on("finish", () => setPlaying(false));
        const t = r.getMetaData().totalTime;
        setTotal(t);
        setLiveMode(follow);
        setFollowing(follow);
        setEnded(false);
        setState("ready");
        r.play(follow ? Math.max(0, t - LIVE_LEAD_MS) : 0);
        setPlaying(true);
        const tick = () => {
          const rr = replayer.current;
          if (rr) {
            const length = span.current.end - span.current.start;
            // A live replay's clock runs on past the newest event while it waits for the next upload.
            const cur = Math.min(rr.getCurrentTime(), length);
            setCurrent(cur);
            if (followingRef.current) setBehind(Math.max(0, (Date.now() - (span.current.start + cur)) / 1000));
            // A live replay never "finishes": stop it at the end once the session is over.
            if (follow && endedRef.current && !followingRef.current && cur >= length - 50) {
              rr.pause();
              setPlaying(false);
            }
          }
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
    // `live` is read once, when the replay opens; later changes only end the follow (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, id, fit, nonce, onUnauthorized]);

  // The session ended (the feed says the recording is no longer ongoing).
  useEffect(() => {
    if (liveMode && !live) setEnded(true);
  }, [live, liveMode]);

  // Live follow: fetch only the blobs after the newest we have, one request at a time.
  useEffect(() => {
    if (state !== "ready" || !liveMode || ended || liveNote) return;
    let off = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    let retryIn: number | null = null;
    let due = false;
    const schedule = () => {
      if (!off) timer = setTimeout(poll, nextDelay(LIVE_POLL_MS, fails, retryIn));
    };
    const poll = async () => {
      if (off) return;
      if (document.visibilityState !== "visible") {
        due = true;
        return;
      }
      try {
        const res = await jget<SnapshotsRes>(token, `/recordings/${encodeURIComponent(id)}/snapshots`, { after: lastKey.current ?? undefined });
        if (off) return;
        const r = replayer.current;
        if (res.last_key !== null && res.last_key !== undefined) lastKey.current = res.last_key;
        if (res.live_edge) liveEdge.current = Date.parse(res.live_edge);
        const fresh = (res.events as RrEvent[]).filter(valid).filter((e) => !seen.current.has(eventKey(e)));
        if (r && fresh.length) {
          for (const e of fresh) {
            seen.current.add(eventKey(e));
            span.current.end = Math.max(span.current.end, e.timestamp);
            r.addEvent(e as never);
          }
          setTotal(span.current.end - span.current.start);
        }
        fails = 0;
        retryIn = null;
        if (liveEdge.current && Date.now() - liveEdge.current > LIVE_IDLE_MS) {
          setEnded(true);
          return;
        }
      } catch (e) {
        if (off) return;
        if (isUnauthorized(e)) {
          onUnauthorized();
          return;
        }
        const err = e instanceof JourneysError ? e : null;
        if (err?.reason === "live_viewers") {
          setLiveNote(err.message);
          return;
        }
        fails += 1;
        retryIn = err?.retryIn ?? null;
      }
      schedule();
    };
    const onVis = () => {
      if (document.visibilityState === "visible" && due) {
        due = false;
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    schedule();
    return () => {
      off = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [state, liveMode, ended, liveNote, token, id, onUnauthorized]);

  const toggle = useCallback(() => {
    const r = replayer.current;
    if (!r) return;
    if (playing) {
      r.pause();
      setPlaying(false);
      setFollowing(false);
    } else {
      const at = r.getCurrentTime();
      r.play(at >= total - 50 && !liveMode ? 0 : at);
      setPlaying(true);
    }
  }, [playing, total, liveMode]);

  const seek = (ms: number) => {
    const r = replayer.current;
    if (!r) return;
    if (playing) r.play(ms);
    else r.pause(ms);
    setCurrent(ms);
    if (liveMode && ms < total - LIVE_LEAD_MS - 5_000) setFollowing(false);
  };

  const goLive = () => {
    const r = replayer.current;
    if (!r) return;
    r.play(Math.max(0, span.current.end - span.current.start - LIVE_LEAD_MS));
    setPlaying(true);
    setFollowing(true);
  };

  useEffect(() => {
    replayer.current?.setConfig({ speed: Number(speed), skipInactive: skip && !following });
  }, [speed, skip, following]);

  // Size the stage once it is laid out.
  useEffect(() => {
    if (state === "ready") fit();
  }, [state, fit]);

  const ready = state === "ready";
  const isLive = liveMode && !ended && !liveNote;
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border-strong bg-bg">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-1 pl-3 pr-1">
        <p className="min-w-0 flex-1 truncate font-mono text-caption text-text-secondary">
          <span aria-hidden className="text-accent-text">▶ </span>{isLive ? "live" : "replay"} · <span className="text-text">{title || "recording"}</span>{" "}
          <span className="text-text-muted">#{id.slice(-8)}</span>
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {ready && isLive && following && (
            <Badge size="sm" tone="success" live className="tabular-nums">
              LIVE · {Math.round(behind)}s behind
            </Badge>
          )}
          {ready && isLive && !following && (
            <Button size="sm" variant="secondary" iconLeft="wave" onClick={goLive}>Go live</Button>
          )}
          {ready && liveMode && ended && <Badge size="sm" tone="neutral">session ended</Badge>}
          {link && (
            <Button size="sm" variant="ghost" iconRight="external" href={link} target="_blank" rel="noopener noreferrer">
              <span className="max-sm:hidden">Open in&nbsp;</span>PostHog<span className="md-visually-hidden"> (opens in a new tab)</span>
            </Button>
          )}
          <IconButton icon="x" label="Close replay" onClick={onClose} className="size-10" />
        </div>
      </div>
      {liveNote && (
        <p role="status" className="border-b border-border bg-warning-soft px-3 py-1.5 font-mono text-micro text-text">
          Not following live: {liveNote} Playing what was recorded so far.
        </p>
      )}

      <div ref={stageRef} className={cx("flex w-full min-w-0 items-start justify-center overflow-hidden bg-surface-inset", ready && "min-h-55")}>
        <div ref={hostRef} className="relative overflow-hidden" role="img" aria-label={`Session recording ${id.slice(-8)}`} />
      </div>
      {state === "loading" && <LoadingBlock label={live ? "Loading the live recording" : "Loading the recording"} minHeight={280} />}

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
          <Button size="sm" variant="ghost" iconLeft="rotate" onClick={() => { setFollowing(false); seek(0); }}>Restart</Button>
        </div>
      )}
      <p className="border-t border-border px-3 py-2 font-mono text-micro text-text-muted">
        plays inside the admin; nothing is shared publicly · inputs are masked · document pages are never recorded
        {isLive ? " · new events arrive every ~12 s" : ""}
      </p>
    </div>
  );
}
