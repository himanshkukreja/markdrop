"use client";

import { useEffect, useRef, useState } from "react";
import { beatPresence, leavePresence, type PresencePerson } from "@/lib/guideEditor";

/** A beat this often; the server forgets a tab 75 s after its last one. */
const BEAT_MS = 30_000;

/** This tab's id (the server keys presence by tab, so two tabs of one person are one person). */
function sessionId(): string {
  const key = "guides:presence-session";
  try {
    const have = sessionStorage.getItem(key);
    if (have && /^[A-Za-z0-9_-]{8,40}$/.test(have)) return have;
    const made = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
    sessionStorage.setItem(key, made);
    return made;
  } catch {
    return `t${Math.random().toString(36).slice(2, 14)}`;
  }
}

/**
 * Who else has this guide's editor open (and on which page): a light "I'm here" heartbeat while the
 * tab is visible, sent again at once when you open another page; a goodbye when the tab closes.
 */
export function usePresence(siteId: string, pageId: string | null): PresencePerson[] {
  const [people, setPeople] = useState<PresencePerson[]>([]);
  const session = useRef<string | null>(null);
  const page = useRef(pageId);
  page.current = pageId;

  useEffect(() => {
    session.current ??= sessionId();
    const s = session.current;
    let live = true;
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      beatPresence(siteId, s, page.current)
        .then((r) => { if (live) setPeople(r.people); })
        .catch(() => { /* presence is a nicety: never an error on screen */ });
    };
    beat();
    const id = window.setInterval(beat, BEAT_MS);
    const onVis = () => { if (document.visibilityState === "visible") beat(); };
    const bye = () => void leavePresence(siteId, s).catch(() => {});
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", bye);
    return () => {
      live = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", bye);
      bye();
    };
  }, [siteId]);

  // Another page: say so now, not at the next beat (the first page went with the first beat).
  const seen = useRef(pageId);
  useEffect(() => {
    const s = session.current;
    if (!s || seen.current === pageId) return;
    seen.current = pageId;
    let live = true;
    beatPresence(siteId, s, pageId).then((r) => { if (live) setPeople(r.people); }).catch(() => {});
    return () => { live = false; };
  }, [siteId, pageId]);

  return people;
}
