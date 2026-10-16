"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isUnauthorized, useOnUnauthorized } from "../shared";
import {
  JourneysError, jget, nextDelay, notConfigured, staleOf, type LiveFeedRes, type NotConfigured, type StreamEvent,
} from "../journeys/api";

/** Poll every 10 s while the tab is visible (backing off to 30 s and 60 s on errors or stale data). */
export const LIVE_POLL_MS = 10_000;
/** Events kept on screen: the newest, within the feed's 30-minute window. */
const KEEP = 200;
const WINDOW_MS = 30 * 60_000;

export interface LiveFeed {
  feed: LiveFeedRes | undefined;
  /** The stream, accumulated across polls: newest first, deduped by id. */
  events: StreamEvent[];
  /** Ids that arrived with the latest poll (they animate in). */
  fresh: ReadonlySet<string>;
  error: JourneysError | null;
  setup: NotConfigured | null;
  updatedAt: number | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * The Live section's poll (GET /live/feed). Each answer replaces the sessions, pages and counts;
 * the stream grows from what is new since the previous answer's `cursor`. One request at a time,
 * none while `paused` or while the tab is hidden (a hidden tab catches up when it comes back).
 */
export function useLiveFeed(token: string, paused: boolean): LiveFeed {
  const onUnauthorized = useOnUnauthorized();
  const [feed, setFeed] = useState<LiveFeedRes>();
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<JourneysError | null>(null);
  const [setup, setSetup] = useState<NotConfigured | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const cursor = useRef<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const fails = useRef(0);
  const retryIn = useRef<number | null>(null);

  useEffect(() => {
    if (paused) return;
    let off = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let due = false;
    let stopped = false;
    let freshTimer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (off || inflight) return;
      if (document.visibilityState !== "visible") {
        due = true;
        return;
      }
      inflight = true;
      setLoading(true);
      try {
        const d = await jget<LiveFeedRes | NotConfigured>(token, "/live/feed", { since: cursor.current ?? undefined });
        if (off) return;
        if (notConfigured(d)) {
          setSetup(d);
          stopped = true;
          return;
        }
        setSetup(null);
        const first = seen.current.size === 0 && !cursor.current;
        const added = d.events.filter((e) => !seen.current.has(e.id));
        for (const e of added) seen.current.add(e.id);
        if (d.cursor) cursor.current = d.cursor;
        if (added.length) {
          const cut = Date.now() - WINDOW_MS;
          setEvents((prev) => {
            const merged = [...added, ...prev].sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
            const kept = merged.filter((e) => new Date(e.t).getTime() > cut).slice(0, KEEP);
            if (kept.length < merged.length) {
              const keep = new Set(kept.map((e) => e.id));
              for (const e of merged) if (!keep.has(e.id)) seen.current.delete(e.id);
            }
            return kept;
          });
          if (!first) {
            setFresh(new Set(added.map((e) => e.id)));
            if (freshTimer) clearTimeout(freshTimer);
            freshTimer = setTimeout(() => !off && setFresh(new Set()), 2_000);
          }
        }
        setFeed(d);
        setError(null);
        setUpdatedAt(Date.now());
        const st = staleOf(d);
        fails.current = st ? fails.current + 1 : 0;
        retryIn.current = st?.retry_in ?? null;
      } catch (e) {
        if (off) return;
        if (isUnauthorized(e)) {
          onUnauthorized();
          return;
        }
        const err = e instanceof JourneysError ? e : new JourneysError(0, e instanceof Error ? e.message : "Something went wrong");
        setError(err);
        fails.current += 1;
        retryIn.current = err.retryIn;
      } finally {
        inflight = false;
        if (!off) setLoading(false);
        if (!off && !stopped) {
          timer = setTimeout(run, nextDelay(LIVE_POLL_MS, fails.current, retryIn.current));
        }
      }
    };

    const onVis = () => {
      if (document.visibilityState === "visible" && due) {
        due = false;
        if (timer) clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    void run();
    return () => {
      off = true;
      if (timer) clearTimeout(timer);
      if (freshTimer) clearTimeout(freshTimer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [token, paused, nonce, onUnauthorized]);

  const refresh = useCallback(() => {
    fails.current = 0;
    setNonce((n) => n + 1);
  }, []);

  return { feed, events, fresh, error, setup, updatedAt, loading, refresh };
}
