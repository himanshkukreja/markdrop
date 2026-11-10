"use client";

/**
 * The docs video player: what a filled `::video` slot plays (docs.markdrop.in and every Markdrop
 * Guides site), and the landing page's trailer dialog. A plain <video> with no native controls and
 * our own around it, drawn from the engine's tokens (accent for progress, surface and text for the
 * bar and menus), so it follows every theme, custom ones included, in light and dark.
 *
 * - Poster: a large Play button, the title and the length; "Resume from 1:12" when this browser
 *   watched part of it before (localStorage, best effort).
 * - Bar (hides while playing, back on pointer move, focus, a key or pause): play/pause, volume,
 *   time, the current chapter, the scrubber (buffered range, chapter notches, a hover preview with
 *   the chapter's title), captions, speed, chapters, picture-in-picture, fullscreen.
 * - Keys (anywhere in the player): Space/K play, ←/→ 5 s, J/L 10 s, 0–9 seek to that tenth,
 *   ↑/↓ volume, M mute, C captions, F fullscreen (Esc leaves it).
 * - Nothing loads until it is near the screen (preload none, then metadata), and the poster image
 *   is lazy. Never autoplays under prefers-reduced-motion.
 *
 * The pure parts (time labels, cues, chapters, resume, keys) are player.mjs, tested in
 * player.test.mjs. Captions are a WebVTT file fetched when first turned on and drawn by us (not
 * the browser), so they look the same everywhere and sit above the bar.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Captions, Check, ListOrdered, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, Volume1, Volume2, VolumeX, X, type LucideIcon } from "lucide-react";
import { cx } from "../cx";
import {
  SPEEDS,
  bufferedEnd,
  chapterAt,
  chapterSpans,
  clamp,
  formatTime,
  keyAction,
  parseClock,
  parseVtt,
  positionToSave,
  resumeFrom,
  resumeKey,
  seekValueText,
  type PlayerCue,
} from "../player.mjs";
import "../player.css";

export interface Chapter {
  start: number;
  text: string;
}

export interface VideoPlayerProps {
  src: string;
  poster?: string;
  w?: number;
  h?: number;
  title: string;
  /** "2:15": shown on the poster before the file's own length is known. */
  duration?: string;
  /** Chapters parsed on the server; without them, `chaptersSrc` is fetched on first play. */
  chapters?: Chapter[];
  chaptersSrc?: string;
  captionsSrc?: string;
  /** The `::video` slot's id: on the <video> as data-video-id, for a guide's reader signals (client/Signals.tsx). */
  videoId?: string;
  /** Start playing as soon as it mounts (a dialog opened by a click), unless reduced motion. */
  autoPlay?: boolean;
  /** The chapter list under the player (the docs page). Off in the dialog. */
  chapterList?: boolean;
  /** Under the player: the title and length (the docs page). Off in the dialog. */
  caption?: boolean;
  className?: string;
  /**
   * Receives the <video> element once mounted (null when unmounted): a Markdrop file embedded in a
   * guide (MarkdropEmbed) reads its events for the file's creator analytics and the guide's Insights.
   */
  onVideo?: (video: HTMLVideoElement | null) => void;
}

const REDUCE = "(prefers-reduced-motion: reduce)";
const HIDE_MS = 2600;
const CC_KEY = "dx-video-cc";
const VOL_KEY = "dx-video-vol";

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
function readStore(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null) {
  try {
    const s = store();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* private mode, quota: the player works without it */
  }
}

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean };

function fullscreenElement(): Element | null {
  const d = document as FsDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/* ── icons (filled glyphs read better on video than the UI's stroked set) ── */
// Lucide (ISC) glyphs, the same set as the app's Icon. Play / pause are drawn filled.
const FILLED: Record<string, LucideIcon> = { play: Play, pause: Pause };
const STROKED: Record<string, LucideIcon> = {
  replay: RotateCcw, volume: Volume2, volumeLow: Volume1, muted: VolumeX, captions: Captions, chapters: ListOrdered,
  pip: PictureInPicture2, fullscreen: Maximize, exitFullscreen: Minimize, check: Check, close: X,
};
function Glyph({ name }: { name: string }) {
  const F = FILLED[name];
  if (F) return <F aria-hidden size="1em" strokeWidth={0} fill="currentColor" className="dx-vp__icon dx-vp__icon--fill" />;
  const S = STROKED[name];
  return S ? <S aria-hidden size="1em" strokeWidth={1.75} className="dx-vp__icon" /> : null;
}

type Menu = null | "speed" | "chapters";

export function VideoPlayer({ src, poster, w, h, title, duration, chapters: chaptersProp, chaptersSrc, captionsSrc, autoPlay = false, chapterList = true, caption = false, className, onVideo, videoId }: VideoPlayerProps) {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<Record<string, HTMLButtonElement | null>>({});

  const labelDur = useMemo(() => parseClock(duration), [duration]);
  const [near, setNear] = useState(false);
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The poster stays until the video has a frame to show (no black flash while it loads). */
  const [hasFrame, setHasFrame] = useState(false);
  const [current, setCurrent] = useState(0);
  const [dur, setDur] = useState<number>(labelDur ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [cues, setCues] = useState<PlayerCue[] | null>(null);
  const [fetchedChapters, setFetchedChapters] = useState<Chapter[] | null>(null);
  const [fs, setFs] = useState(false);
  const [pip, setPip] = useState(false);
  const [canPip, setCanPip] = useState(false);
  const [canFs, setCanFs] = useState(true);
  const [shown, setShown] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const hideTimer = useRef<number | undefined>(undefined);
  const lastPointer = useRef("");
  const tipRef = useRef<HTMLDivElement>(null);
  const lastSaved = useRef(0);

  const chapters = useMemo(() => chapterSpans(chaptersProp?.length ? chaptersProp : fetchedChapters ?? [], dur), [chaptersProp, fetchedChapters, dur]);
  const chapterIdx = chapterAt(chapters, current);
  const length = dur || labelDur || 0;

  /* ── mount: remembered position, captions and volume, PiP / fullscreen support ── */
  useEffect(() => {
    setResumeAt(resumeFrom(readStore(resumeKey(src)), labelDur));
    if (captionsSrc && readStore(CC_KEY) === "1") setCaptionsOn(true);
    const vol = readStore(VOL_KEY);
    if (vol) {
      const [v, m] = vol.split(":");
      const n = Number(v);
      if (Number.isFinite(n)) setVolume(clamp(n, 0, 1));
      setMuted(m === "1");
    }
    const v = videoRef.current as IosVideo | null;
    setCanPip(typeof document !== "undefined" && !!document.pictureInPictureEnabled && !!v && "requestPictureInPicture" in v);
    const root = rootRef.current as FsEl | null;
    setCanFs(!!root && (!!root.requestFullscreen || !!root.webkitRequestFullscreen || !!v?.webkitEnterFullscreen));
  }, [src, captionsSrc, labelDur]);

  /* ── the element, for a host that measures playback (MarkdropEmbed) ── */
  useEffect(() => {
    if (!onVideo) return;
    onVideo(videoRef.current);
    return () => onVideo(null);
  }, [onVideo]);

  /* ── lazy: nothing is fetched until the player is near the screen ── */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /* ── volume / rate onto the element ── */
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = rate;
  }, [rate]);

  /* ── fetched text: captions when first turned on, chapters on first play when not given ── */
  useEffect(() => {
    if (!captionsOn || !captionsSrc || cues) return;
    let gone = false;
    fetch(captionsSrc)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        if (!gone) setCues(parseVtt(t));
      })
      .catch(() => {
        if (!gone) setCues([]);
      });
    return () => {
      gone = true;
    };
  }, [captionsOn, captionsSrc, cues]);
  useEffect(() => {
    if (!started || chaptersProp?.length || !chaptersSrc || fetchedChapters) return;
    let gone = false;
    fetch(chaptersSrc)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        if (!gone) setFetchedChapters(parseVtt(t).map((c) => ({ start: c.start, text: c.text })));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [started, chaptersProp, chaptersSrc, fetchedChapters]);

  /* ── progress: a frame loop while playing writes the bar directly; React state at timeupdate ── */
  const paintProgress = useCallback(
    (t: number) => {
      const pct = length > 0 ? clamp((t / length) * 100, 0, 100) : 0;
      if (playedRef.current) playedRef.current.style.width = `${pct}%`;
      if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
    },
    [length],
  );
  useEffect(() => {
    if (!playing || dragging) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) paintProgress(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dragging, paintProgress]);
  useEffect(() => {
    if (!dragging) paintProgress(current);
  }, [current, dragging, paintProgress]);

  const savePosition = useCallback(
    (force = false, el: HTMLVideoElement | null = videoRef.current) => {
      const v = el;
      if (!v || !started) return;
      const t = v.currentTime;
      if (!force && Math.abs(t - lastSaved.current) < 3) return;
      lastSaved.current = t;
      const keep = positionToSave(t, v.duration || length, v.ended);
      writeStore(resumeKey(src), keep === null ? null : String(keep));
    },
    [src, started, length],
  );
  const saveRef = useRef(savePosition);
  saveRef.current = savePosition;
  useEffect(() => {
    const el = videoRef.current;
    const onHide = () => saveRef.current(true, el);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      onHide(); // unmounted (a dialog closed, a client-side navigation): keep the place
    };
  }, []);

  /* ── controls visibility ── */
  const keepShown = useCallback(() => {
    const v = videoRef.current;
    const bar = barRef.current;
    const focusInBar = !!bar && bar.contains(document.activeElement) && (document.activeElement as HTMLElement | null)?.matches?.(":focus-visible");
    return !v || v.paused || v.ended || !!menu || dragging || !!focusInBar;
  }, [menu, dragging]);
  const poke = useCallback(() => {
    setShown(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!keepShown()) setShown(false);
    }, HIDE_MS);
  }, [keepShown]);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!playing || menu || dragging) setShown(true);
    else poke();
  }, [playing, menu, dragging, poke]);

  /* ── fullscreen / pip state ── */
  useEffect(() => {
    const v = videoRef.current;
    const on = () => setPip(true);
    const off = () => setPip(false);
    v?.addEventListener("enterpictureinpicture", on);
    v?.addEventListener("leavepictureinpicture", off);
    return () => {
      v?.removeEventListener("enterpictureinpicture", on);
      v?.removeEventListener("leavepictureinpicture", off);
    };
  }, []);
  useEffect(() => {
    const onFs = () => setFs(fullscreenElement() === rootRef.current);
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);

  /* ── actions ── */
  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      const max = v.duration || length || Infinity;
      const to = clamp(t, 0, Number.isFinite(max) ? Math.max(0, max - 0.05) : t);
      if (v.readyState >= 1) v.currentTime = to;
      else v.addEventListener("loadedmetadata", () => (v.currentTime = to), { once: true });
      setCurrent(to);
      setEnded(false);
    },
    [length],
  );

  const play = useCallback(
    (at?: number) => {
      const v = videoRef.current;
      if (!v) return;
      setStarted(true);
      setNear(true);
      if (at !== undefined) seek(at);
      const p = v.play();
      if (p) p.catch(() => setPlaying(false));
    },
    [seek],
  );

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!started) {
      play(resumeAt ?? undefined);
      rootRef.current?.focus({ preventScroll: true });
      return;
    }
    if (v.paused || v.ended) play(v.ended ? 0 : undefined);
    else v.pause();
  }, [started, play, resumeAt]);

  // Opened by a click (the dialog): play at once, from where this browser left off; never under
  // reduced motion, where the poster and its Play button wait.
  useEffect(() => {
    if (!autoPlay || window.matchMedia?.(REDUCE).matches) return;
    play(resumeFrom(readStore(resumeKey(src)), labelDur) ?? undefined);
    rootRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setVol = useCallback((n: number) => {
    const vol = clamp(Math.round(n * 100) / 100, 0, 1);
    setVolume(vol);
    setMuted(vol === 0);
    writeStore(VOL_KEY, `${vol}:${vol === 0 ? 1 : 0}`);
  }, []);
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      if (!next && volume === 0) setVolume(0.5);
      writeStore(VOL_KEY, `${!next && volume === 0 ? 0.5 : volume}:${next ? 1 : 0}`);
      return next;
    });
  }, [volume]);
  const toggleCaptions = useCallback(() => {
    if (!captionsSrc) return;
    setCaptionsOn((c) => {
      writeStore(CC_KEY, c ? "0" : "1");
      setStatus(c ? "Captions off" : "Captions on");
      return !c;
    });
  }, [captionsSrc]);
  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current as FsEl | null;
    const v = videoRef.current as IosVideo | null;
    if (!root) return;
    if (fullscreenElement()) {
      const d = document as FsDoc;
      void (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.())?.catch?.(() => {});
      return;
    }
    if (root.requestFullscreen) void root.requestFullscreen().catch(() => {});
    else if (root.webkitRequestFullscreen) void root.webkitRequestFullscreen();
    else if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iPhone: the system player
  }, []);
  const togglePip = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    else void v.requestPictureInPicture?.().catch(() => {});
  }, []);

  /* ── keyboard ── */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === "Escape" && menu) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (target.closest("[role=menu]")) return; // the menu handles its own keys
    const isButton = target.tagName === "BUTTON";
    const slider = target.getAttribute("role") === "slider" ? target.dataset.slider : undefined;
    if (isButton && (e.key === " " || e.key === "Enter")) return; // the button's own click
    // A focused slider moves with its arrows (seek: ←/→/↑/↓; volume: all four change the volume).
    if (slider === "volume" && /^Arrow|^Page|^Home$|^End$/.test(e.key)) {
      e.preventDefault();
      const step = e.key.startsWith("Page") ? 0.2 : 0.05;
      if (e.key === "Home") setVol(0);
      else if (e.key === "End") setVol(1);
      else setVol((muted ? 0 : volume) + (e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "PageUp" ? step : -step));
      poke();
      return;
    }
    if (slider === "seek" && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "PageUp" || e.key === "PageDown")) {
      e.preventDefault();
      const by = (e.key.startsWith("Page") ? 10 : 5) * (e.key === "ArrowUp" || e.key === "PageUp" ? 1 : -1);
      if (!started) setStarted(true);
      seek((videoRef.current?.currentTime ?? 0) + by);
      poke();
      return;
    }
    const a = keyAction(e);
    if (!a) return;
    e.preventDefault();
    const v = videoRef.current;
    const now = v?.currentTime ?? 0;
    switch (a.type) {
      case "toggle":
        toggle();
        break;
      case "seekBy":
        if (!started) setStarted(true);
        seek(now + a.by);
        setStatus(`${a.by > 0 ? "Forward" : "Back"} ${Math.abs(a.by)} seconds`);
        break;
      case "seekPct":
        if (!started) setStarted(true);
        seek((length * a.pct) / 100);
        break;
      case "seekTo":
        if (!started) setStarted(true);
        seek(a.at);
        break;
      case "volumeBy":
        setVol((muted ? 0 : volume) + a.by);
        setStatus(`Volume ${Math.round(clamp((muted ? 0 : volume) + a.by, 0, 1) * 100)}%`);
        break;
      case "mute":
        toggleMute();
        setStatus(muted ? "Unmuted" : "Muted");
        break;
      case "fullscreen":
        toggleFullscreen();
        break;
      case "captions":
        toggleCaptions();
        break;
    }
    poke();
  };

  /* ── scrubber ── */
  const timeAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    return clamp((clientX - r.left) / r.width, 0, 1) * length;
  };
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !length) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    setDragging(true);
    const t = timeAt(e.clientX);
    paintProgress(t);
    setHover({ x: e.clientX, t });
    seek(t);
  };
  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!length) return;
    const t = timeAt(e.clientX);
    setHover({ x: e.clientX, t });
    if (dragging) {
      paintProgress(t);
      seek(t);
    }
  };
  const onTrackUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setDragging(false);
    if (e.pointerType !== "mouse") setHover(null);
  };

  /* ── volume slider ── */
  const volRef = useRef<HTMLDivElement>(null);
  const [volDrag, setVolDrag] = useState(false);
  const volAt = (clientX: number) => {
    const r = volRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return volume;
    return clamp((clientX - r.left) / r.width, 0, 1);
  };

  /* ── menus ── */
  const openMenu = (m: Exclude<Menu, null>) => {
    setMenu((cur) => (cur === m ? null : m));
  };
  const closeMenu = useCallback(
    (refocus: boolean) => {
      const was = menu;
      setMenu(null);
      if (refocus && was) menuBtn.current[was]?.focus({ preventScroll: true });
    },
    [menu],
  );
  useEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    const first = el?.querySelector<HTMLElement>('[aria-checked="true"], [aria-current="true"]') ?? el?.querySelector<HTMLElement>("[role^=menuitem]");
    first?.focus({ preventScroll: true });
    first?.scrollIntoView?.({ block: "nearest" });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || Object.values(menuBtn.current).some((b) => b?.contains(t))) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menu]);
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      setMenu(null);
      return;
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    } else return;
    e.preventDefault();
    items[next]?.focus();
  };

  /* ── the surface: click plays/pauses (mouse), tap shows/hides the bar (touch) ── */
  const onSurfaceUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (menu) {
      setMenu(null);
      return;
    }
    if (e.pointerType === "mouse" || e.pointerType === "pen") {
      toggle();
      poke();
      return;
    }
    // Touch: the first tap brings the bar back; a tap while it shows hides it again (playing only).
    if (!shown) poke();
    else if (playing) {
      window.clearTimeout(hideTimer.current);
      setShown(false);
    }
  };

  /* ── video events ── */
  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrent(v.currentTime);
    setBuffered(bufferedEnd(v.buffered, v.currentTime));
    savePosition();
  };

  // The hover preview stays inside the track: placed after it renders, once its width is known.
  useLayoutEffect(() => {
    const tip = tipRef.current, track = trackRef.current;
    if (!hover || !tip || !track) return;
    const r = track.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    tip.style.left = `${clamp(hover.x - r.left, Math.min(half, r.width / 2), Math.max(r.width - half, r.width / 2))}px`;
  }, [hover]);

  const cue = captionsOn && cues ? cues.find((c) => current >= c.start && current < c.end) : undefined;
  const pct = (t: number) => (length > 0 ? clamp((t / length) * 100, 0, 100) : 0);
  const hoverChapter = hover ? chapters[chapterAt(chapters, hover.t)] : undefined;
  const volShown = muted ? 0 : volume;
  const volIcon = muted || volume === 0 ? "muted" : volume < 0.5 ? "volumeLow" : "volume";
  const frameStyle = { aspectRatio: w && h ? `${w} / ${h}` : undefined } as CSSProperties;
  const showStart = !started;
  const showBar = started && (shown || !playing);

  return (
    <figure className={cx("dx-video dx-vp not-prose", className)}>
      <div
        ref={rootRef}
        className={cx("dx-vp__frame", started && "is-started", playing && "is-playing", showBar && "has-bar", fs && "is-fs", menu && "has-menu", !showBar && playing && "is-idle")}
        style={frameStyle}
        role="group"
        aria-label={`Video: ${title}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse") poke();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse" && playing && !menu && !dragging) {
            window.clearTimeout(hideTimer.current);
            hideTimer.current = window.setTimeout(() => {
              if (!keepShown()) setShown(false);
            }, 600);
          }
        }}
        onFocus={() => poke()}
      >
        <video
          ref={videoRef}
          src={src}
          className="dx-vp__video"
          data-video-id={videoId || undefined}
          preload={near ? "metadata" : "none"}
          playsInline
          width={w}
          height={h}
          aria-hidden={!started || undefined}
          tabIndex={-1}
          onPlay={() => {
            setStarted(true);
            setPlaying(true);
            setEnded(false);
            setFailed(false);
          }}
          onPause={() => {
            setPlaying(false);
            savePosition(true);
          }}
          onEnded={() => {
            setPlaying(false);
            setEnded(true);
            writeStore(resumeKey(src), null);
          }}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => {
            setWaiting(false);
            setHasFrame(true);
          }}
          onCanPlay={() => setWaiting(false)}
          onSeeked={() => {
            setWaiting(false);
            if (started) setHasFrame(true);
          }}
          onTimeUpdate={onTimeUpdate}
          onProgress={() => {
            const v = videoRef.current;
            if (v) setBuffered(bufferedEnd(v.buffered, v.currentTime));
          }}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (v && Number.isFinite(v.duration) && v.duration > 0) setDur(v.duration);
          }}
          onDurationChange={() => {
            const v = videoRef.current;
            if (v && Number.isFinite(v.duration) && v.duration > 0) setDur(v.duration);
          }}
          onVolumeChange={() => {
            const v = videoRef.current;
            if (!v) return;
            setMuted(v.muted);
            setVolume(v.volume);
          }}
          onRateChange={() => {
            const v = videoRef.current;
            if (v) setRate(v.playbackRate);
          }}
          onError={() => {
            if (started) setFailed(true);
            setWaiting(false);
          }}
        >
        </video>

        {poster && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={cx("dx-vp__poster", started && hasFrame && "is-gone")} src={poster} alt="" width={w} height={h} loading="lazy" decoding="async" aria-hidden />
        )}

        <div
          className="dx-vp__surface"
          onPointerUp={(e) => {
            lastPointer.current = e.pointerType;
            onSurfaceUp(e);
          }}
          onDoubleClick={() => lastPointer.current !== "touch" && toggleFullscreen()}
          aria-hidden
        />

        {cue && (
          <div className="dx-vp__cues" aria-hidden>
            <span className="dx-vp__cue">{cue.text}</span>
          </div>
        )}

        {fs && showBar && <div className="dx-vp__top">{title}</div>}

        {showStart && (
          <div className="dx-vp__start">
            <button type="button" className="dx-vp__big" onClick={toggle} aria-label={`Play video: ${title}${duration ? ` (${duration})` : ""}${resumeAt ? `, resume from ${formatTime(resumeAt)}` : ""}`}>
              <Glyph name="play" />
            </button>
            <div className="dx-vp__meta">
              <span className="dx-vp__title">{title}</span>
              <span className="dx-vp__chips">
                {duration && <span className="dx-vp__chip">{duration}</span>}
                {resumeAt !== null && (
                  <>
                    <span className="dx-vp__chip dx-vp__chip--resume">Resume from {formatTime(resumeAt)}</span>
                    <button
                      type="button"
                      className="dx-vp__over"
                      onClick={() => {
                        setResumeAt(null);
                        writeStore(resumeKey(src), null);
                        play(0);
                        rootRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      Start over
                    </button>
                  </>
                )}
              </span>
            </div>
          </div>
        )}

        {started && !showStart && (!playing || ended) && !waiting && !failed && (
          <button type="button" className="dx-vp__center" onClick={toggle} tabIndex={-1} aria-hidden>
            <Glyph name={ended ? "replay" : "play"} />
          </button>
        )}
        {waiting && playing && <span className="dx-vp__spin" aria-hidden />}
        {failed && (
          <div className="dx-vp__error" role="alert">
            This video couldn&apos;t be played.{" "}
            <a href={src} target="_blank" rel="noopener">
              Open the file
            </a>
          </div>
        )}

        {started && (
          <div ref={barRef} className={cx("dx-vp__bar", showBar && "is-shown")} onPointerDown={() => poke()}>
            <div
              ref={trackRef}
              className={cx("dx-vp__track", dragging && "is-dragging")}
              role="slider"
              data-slider="seek"
              tabIndex={0}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(length)}
              aria-valuenow={Math.round(current)}
              aria-valuetext={`${seekValueText(current, length)}${chapterIdx >= 0 ? `, ${chapters[chapterIdx].text}` : ""}`}
              onPointerDown={onTrackDown}
              onPointerMove={onTrackMove}
              onPointerUp={onTrackUp}
              onPointerCancel={onTrackUp}
              onPointerLeave={() => !dragging && setHover(null)}
            >
              <div className="dx-vp__rail">
                <div className="dx-vp__buffered" style={{ width: `${pct(buffered)}%` }} />
                {hover && <div className="dx-vp__hoverfill" style={{ width: `${pct(hover.t)}%` }} />}
                <div ref={playedRef} className="dx-vp__played" />
                {chapters.slice(1).map((c) => (
                  <span key={c.start} className="dx-vp__notch" style={{ left: `${pct(c.start)}%` }} />
                ))}
              </div>
              <div ref={thumbRef} className="dx-vp__thumb" />
              {hover && (
                <div ref={tipRef} className="dx-vp__tip" aria-hidden>
                  {hoverChapter && <span className="dx-vp__tipch">{hoverChapter.text}</span>}
                  <span className="dx-vp__tipt">{formatTime(hover.t)}</span>
                </div>
              )}
            </div>

            <div className="dx-vp__row">
              <button type="button" className="dx-vp__btn" onClick={toggle} aria-label={playing ? "Pause (k)" : ended ? "Replay" : "Play (k)"} title={playing ? "Pause (k)" : "Play (k)"}>
                <Glyph name={playing ? "pause" : ended ? "replay" : "play"} />
              </button>

              <div className="dx-vp__vol">
                <button type="button" className="dx-vp__btn" onClick={toggleMute} aria-label={muted || volume === 0 ? "Unmute (m)" : "Mute (m)"} title={muted ? "Unmute (m)" : "Mute (m)"}>
                  <Glyph name={volIcon} />
                </button>
                <div
                  ref={volRef}
                  className="dx-vp__volslider"
                  role="slider"
                  data-slider="volume"
                  tabIndex={0}
                  aria-label="Volume"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(volShown * 100)}
                  aria-valuetext={muted ? "Muted" : `${Math.round(volShown * 100)}%`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    setVolDrag(true);
                    setVol(volAt(e.clientX));
                  }}
                  onPointerMove={(e) => volDrag && setVol(volAt(e.clientX))}
                  onPointerUp={() => setVolDrag(false)}
                  onPointerCancel={() => setVolDrag(false)}
                >
                  <div className="dx-vp__volrail">
                    <div className="dx-vp__volfill" style={{ width: `${volShown * 100}%` }} />
                  </div>
                  <div className="dx-vp__volthumb" style={{ left: `${volShown * 100}%` }} />
                </div>
              </div>

              <span className="dx-vp__time">
                <span>{formatTime(current)}</span>
                <span className="dx-vp__sep"> / </span>
                <span className="dx-vp__total">{formatTime(length)}</span>
              </span>

              {chapterIdx >= 0 ? (
                <button type="button" className="dx-vp__chapter" onClick={() => openMenu("chapters")} tabIndex={-1} aria-hidden>
                  {chapters[chapterIdx].text}
                </button>
              ) : (
                <span className="dx-vp__grow" />
              )}

              {captionsSrc && (
                <button type="button" className={cx("dx-vp__btn", captionsOn && "is-on")} onClick={toggleCaptions} aria-pressed={captionsOn} aria-label="Captions (c)" title="Captions (c)">
                  <Glyph name="captions" />
                </button>
              )}

              <button
                type="button"
                ref={(el) => {
                  menuBtn.current.speed = el;
                }}
                className={cx("dx-vp__btn dx-vp__speed", menu === "speed" && "is-open")}
                onClick={() => openMenu("speed")}
                aria-haspopup="menu"
                aria-expanded={menu === "speed"}
                aria-controls={menu === "speed" ? `${uid}-menu` : undefined}
                aria-label={`Playback speed, ${rate === 1 ? "normal" : `${rate}×`}`}
                title="Playback speed"
              >
                {rate === 1 ? "1×" : `${rate}×`}
              </button>

              {chapters.length > 0 && (
                <button
                  type="button"
                  ref={(el) => {
                    menuBtn.current.chapters = el;
                  }}
                  className={cx("dx-vp__btn", menu === "chapters" && "is-open")}
                  onClick={() => openMenu("chapters")}
                  aria-haspopup="menu"
                  aria-expanded={menu === "chapters"}
                  aria-controls={menu === "chapters" ? `${uid}-menu` : undefined}
                  aria-label="Chapters"
                  title="Chapters"
                >
                  <Glyph name="chapters" />
                </button>
              )}

              {canPip && (
                <button type="button" className={cx("dx-vp__btn dx-vp__pip", pip && "is-on")} onClick={togglePip} aria-pressed={pip} aria-label="Picture in picture" title="Picture in picture">
                  <Glyph name="pip" />
                </button>
              )}

              {canFs && (
                <button type="button" className="dx-vp__btn" onClick={toggleFullscreen} aria-label={fs ? "Exit full screen (f)" : "Full screen (f)"} title={fs ? "Exit full screen (f)" : "Full screen (f)"}>
                  <Glyph name={fs ? "exitFullscreen" : "fullscreen"} />
                </button>
              )}
            </div>
          </div>
        )}

        {menu && (
          <div ref={menuRef} id={`${uid}-menu`} className={cx("dx-vp__menu", menu === "chapters" && "dx-vp__menu--chapters")} role="menu" aria-label={menu === "speed" ? "Playback speed" : "Chapters"} onKeyDown={onMenuKey}>
            <div className="dx-vp__menuhead" aria-hidden>
              {menu === "speed" ? "Speed" : "Chapters"}
            </div>
            {menu === "speed"
              ? SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="menuitemradio"
                    aria-checked={rate === s}
                    tabIndex={-1}
                    className="dx-vp__item"
                    onClick={() => {
                      setRate(s);
                      setStatus(`Speed ${s === 1 ? "normal" : `${s}×`}`);
                      closeMenu(true);
                    }}
                  >
                    <span className="dx-vp__itemcheck">{rate === s && <Glyph name="check" />}</span>
                    <span>{s === 1 ? "Normal" : `${s}×`}</span>
                  </button>
                ))
              : chapters.map((c, i) => (
                  <button
                    key={c.start}
                    type="button"
                    role="menuitem"
                    aria-current={i === chapterIdx ? "true" : undefined}
                    tabIndex={-1}
                    className="dx-vp__item"
                    onClick={() => {
                      play(c.start);
                      closeMenu(true);
                    }}
                  >
                    <span className="dx-vp__itemt">{formatTime(c.start)}</span>
                    <span className="dx-vp__itemtext">{c.text}</span>
                  </button>
                ))}
          </div>
        )}

        <span className="dx-vp__sr" role="status" aria-live="polite">
          {status}
        </span>
      </div>

      {caption && (
        <figcaption className="dx-video__cap dx-vp__cap">
          <span className="dx-video__title">{title}</span>
          {duration && <span className="dx-video__len">{duration}</span>}
        </figcaption>
      )}
      {chapterList && chapters.length > 0 && (
        <ol className="dx-chapters" aria-label={`Chapters: ${title}`}>
          {chapters.map((c, i) => (
            <li key={c.start}>
              <button
                type="button"
                className="dx-chapters__item"
                aria-current={started && i === chapterIdx ? "true" : undefined}
                onClick={() => {
                  play(c.start);
                  rootRef.current?.focus({ preventScroll: true });
                }}
              >
                <span className="dx-chapters__t">{formatTime(c.start)}</span>
                <span>{c.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}

/* ── Dialog: the player in a modal (the landing page's trailer) ───────────── */

/**
 * A native <dialog> holding one player: Esc or the close button closes it (and stops the video),
 * the page behind is inert, focus goes back to whatever opened it. Mounted by the caller when the
 * reader asks for the video, so nothing is fetched before that.
 */
export function VideoDialog({ onClose, ...player }: VideoPlayerProps & { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    opener.current = document.activeElement;
    if (!d.open) d.showModal();
    document.documentElement.classList.add("dx-vp-modal-open");
    // With autoplay (a click opened it) the player takes focus itself; otherwise the poster's Play.
    if (!player.autoPlay || window.matchMedia?.(REDUCE).matches) d.querySelector<HTMLButtonElement>(".dx-vp__big")?.focus();
    return () => {
      document.documentElement.classList.remove("dx-vp-modal-open");
      const o = opener.current as HTMLElement | null;
      if (o?.isConnected) o.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <dialog
      ref={ref}
      className="dx-vp-dialog"
      aria-label={player.title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      <div className="dx-vp-dialog__inner">
        <div className="dx-vp-dialog__bar">
          <span className="dx-vp-dialog__title">{player.title}</span>
          <button type="button" className="dx-vp-dialog__close" onClick={() => ref.current?.close()} aria-label="Close video" title="Close (Esc)">
            <Glyph name="close" />
          </button>
        </div>
        <VideoPlayer {...player} chapterList={false} caption={false} className="dx-vp--dialog" />
      </div>
    </dialog>
  );
}
