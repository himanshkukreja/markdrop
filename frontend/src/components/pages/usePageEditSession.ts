"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDocument } from "@/lib/api";
import { keepUnsaved, lockFacts, lockHolder, lockPage, lockStatus, pagesErrorStatus, savePage, unlockPage, PagesApiError, type LockFacts, type LockInfo, type LockTimers, type PageDocument } from "@/lib/pages";
import { splitFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import { merge3 } from "@/lib/pageMerge.mjs";
import { readPageProps } from "./pageProps";
import { writePageProps } from "./pagePropsWrite";

const pageLocked = (e: unknown) => e instanceof PagesApiError && e.info.code === "page_locked";

/** The server lets a lock lapse 2 minutes after the last heartbeat. */
export const HEARTBEAT_MS = 30_000;
/** Autosave this long after the last change. */
export const AUTOSAVE_MS = 2000;
/** Let go of the lock after this long without a change (someone else may edit). The server does too. */
export const IDLE_MS = 2 * 60_000;
/** Let go of the lock after the tab has been hidden this long. The server does too. */
export const HIDDEN_MS = 60_000;
/** While someone else edits: ask whether it's free this often (asking never takes it). */
export const RETRY_MS = 15_000;

export type SaveState =
  | { state: "saved"; at: number | null }
  | { state: "dirty" }
  | { state: "saving" }
  | { state: "error"; message: string };

export type LockState =
  /**
   * Nobody's lock is ours and we know of no one else's: the page is editable, and the first key,
   * click or change takes the lock (an editor who's only reading never blocks anyone).
   */
  | { kind: "idle" }
  | { kind: "acquiring" }
  | { kind: "mine" }
  /**
   * Someone else is editing: read only, following their changes live. `lost`: it was ours.
   * `takenBy`: they took it over (`kept`: the version in history holding what wasn't saved here).
   * `facts`: how long they've been idle, unsaved changes, when it releases, whether we may take over.
   */
  | { kind: "theirs"; name: string | null; lost?: boolean; takenBy?: string | null; kept?: number | null; facts?: LockFacts | null }
  /** The API refused the lock for another reason (no edit rights any more, the page is locked). */
  | { kind: "readonly"; message: string };

export interface Conflict {
  /** Their newest version. */
  doc: PageDocument;
}

/**
 * One page open in the block editor (one editor at a time). A page is always editable for the
 * people who can edit it (no Edit / Done), so the edit lock follows what they do:
 *
 * - the first real change (`update`) takes the lock — opening, clicking, moving the caret or
 *   selecting never do (`activity` only notes the person is here); it's heartbeated every 30 s
 *   (saying whether anything changed, whether the tab is hidden, whether something is unsaved) and
 *   let go of 2 minutes after the last change, 60 s after the tab was hidden, and on leave (what's
 *   pending is saved first). The server lets it lapse on the same clocks, so a frozen or throttled
 *   tab never holds a page; the next change takes it again;
 * - the page's owner and workspace admins can take over (`takeOver`); the editor it was taken from
 *   keeps its unsaved text as a version in the page's history (POST …/lock/keep) and says so;
 * - autosaves 2 s after the last change through PUT /documents/{slug} with `base_rev`;
 * - 423 (someone else holds the lock): read only, "X is editing", following their changes live;
 *   asks whether it's free every 15 s (GET …/lock never takes it), and when it is the page is
 *   editable again (taking the lock only when there is text of ours to save);
 * - 409 (a newer version): when it only adds to the end of what this editor last saved (an AI
 *   app's append_blocks), the addition is merged in and the save retried; otherwise "This page
 *   changed", with Load the latest / Keep mine;
 * - a live `appended` event goes straight into the editor at the end (`onAppend`); while the lock
 *   isn't ours, any change is shown as it lands (unless this editor has text on its way);
 * - an auto cover (live `cover`, or `remoteCover` from a poll) goes into the page's front matter
 *   (`onCover`) without counting as an edit; a 409 whose only difference is that cover is merged
 *   too, so the page never loses it to a save that started before it landed.
 */
export function usePageEditSession({
  slug,
  secret,
  initial,
  onSaved,
  onAppend,
  onRemote,
  subscribeLive,
  onCover,
}: {
  slug: string;
  secret: string | null;
  initial: { title: string; content: string; rev: number | null };
  onSaved?: (doc: PageDocument) => void;
  /** Markdown to add at the end of the editor (a live append or a merged 409). */
  onAppend: (markdown: string) => void;
  /** A whole new version to show (someone else's edit while read only, Load the latest). */
  onRemote: (doc: { title: string; content: string; rev: number | null }) => void;
  subscribeLive?: (fn: (msg: Record<string, unknown>) => void) => () => void;
  /** An auto cover landed (`gallery:<id>`): put it in the page's front matter. */
  onCover?: (cover: string) => void;
}) {
  const [save, setSave] = useState<SaveState>({ state: "saved", at: null });
  const [lock, setLockState] = useState<LockState>({ kind: "idle" });
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /** Someone took this editor's lock over and nobody holds it now (an AI app's write): say so. */
  const [notice, setNotice] = useState<{ by: string; kept: number | null } | null>(null);

  const lockRef = useRef<LockState>(lock);
  const setLock = useCallback((l: LockState) => {
    lockRef.current = l;
    setLockState(l);
  }, []);
  const fields = useRef({ title: initial.title, content: initial.content });
  /** What the server holds at `baseRev` as far as this editor knows (the last load or save). */
  const base = useRef({ title: initial.title, content: initial.content });
  const baseRev = useRef<number | null>(initial.rev);
  const dirty = useRef(false);
  const saving = useRef(false);
  const timer = useRef<number | null>(null);
  /** The last key, click or focus here (the person is here; it takes nothing). */
  const lastActive = useRef(0);
  /** The last real change here (the idle clock: the lock goes 2 minutes after it). */
  const lastEdit = useRef(0);
  /** When the last heartbeat went (a change after it is reported as `edited`). */
  const lastBeat = useRef(0);
  /** The server's timings (lock answers carry them; tests shorten them). */
  const timers = useRef({ heartbeat: HEARTBEAT_MS, idle: IDLE_MS, hidden: HIDDEN_MS });
  const applyTimers = (t: LockTimers | undefined) => {
    if (!t) return;
    const ms = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v * 1000 : d);
    timers.current = { heartbeat: ms(t.heartbeat_s, HEARTBEAT_MS), idle: ms(t.idle_s, IDLE_MS), hidden: ms(t.hidden_s, HIDDEN_MS) };
  };
  const acquiring = useRef<Promise<boolean> | null>(null);
  /** Taking the lock failed for want of a network (or a server error) with text to save: try again. */
  const acquireRetry = useRef<number | null>(null);
  const cbs = useRef({ onSaved, onAppend, onRemote, onCover });
  cbs.current = { onSaved, onAppend, onRemote, onCover };

  const clearTimer = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const fetchLatest = useCallback(async (): Promise<PageDocument> => {
    const pwd = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(`pwd:${slug}`) || undefined : undefined;
    return (await getDocument(slug, pwd, secret || undefined)) as PageDocument;
  }, [slug, secret]);

  const adopt = useCallback((doc: PageDocument) => {
    const next = { title: doc.title ?? "", content: doc.content ?? "" };
    base.current = next;
    fields.current = next;
    baseRev.current = typeof doc.rev === "number" ? doc.rev : null;
    dirty.current = false;
    setSave({ state: "saved", at: Date.now() });
    cbs.current.onRemote({ ...next, rev: baseRev.current });
  }, []);

  const doSave = useCallback(async (): Promise<void> => {
    clearTimer();
    if (!dirty.current || saving.current || lockRef.current.kind !== "mine") return;
    const sent = { ...fields.current };
    saving.current = true;
    dirty.current = false;
    setSave({ state: "saving" });
    try {
      const doc = await savePage(slug, { title: sent.title, content: sent.content, baseRev: baseRev.current }, secret);
      baseRev.current = typeof doc.rev === "number" ? doc.rev : baseRev.current;
      base.current = sent;
      // An auto cover that landed before this save, merged in by the server: take it, so the next
      // save doesn't drop it (which would count as removing it).
      const merged = doc.cover_auto ? readPageProps(doc.content ?? "").cover : null;
      if (merged && !readPageProps(sent.content).cover) {
        base.current = { ...sent, content: doc.content ?? sent.content };
        if (!readPageProps(fields.current.content).cover) {
          fields.current = { ...fields.current, content: writePageProps(fields.current.content, { cover: merged, coverY: 50 }) };
        }
        cbs.current.onCover?.(merged);
      }
      cbs.current.onSaved?.(doc);
      setSave(dirty.current ? { state: "dirty" } : { state: "saved", at: Date.now() });
    } catch (e) {
      dirty.current = true;
      const status = pagesErrorStatus(e);
      if (status === 423 && pageLocked(e)) {
        setLock({ kind: "readonly", message: "This page is locked. Only its owner and workspace admins can edit it." });
        setSave({ state: "error", message: "Not saved: this page is locked." });
      } else if (status === 423) {
        setLock({ kind: "theirs", name: lockHolder(e), lost: true });
        setSave({ state: "error", message: "Not saved: someone else is editing this page." });
      } else if (status === 409) {
        // A newer version. If it only added to the end of what we last saved (an AI app's
        // append_blocks), take the addition and save on top; anything else is the author's call.
        try {
          const latest = await fetchLatest();
          // Only an auto cover landed since our base: take it into what we're saving and retry.
          const cover = coverOnlyChange(base.current.content, latest.content ?? "");
          if (cover && (latest.title ?? "") === base.current.title) {
            base.current = { title: latest.title ?? "", content: latest.content ?? "" };
            baseRev.current = typeof latest.rev === "number" ? latest.rev : baseRev.current;
            fields.current = { ...fields.current, content: writePageProps(fields.current.content, { cover, coverY: 50 }) };
            cbs.current.onCover?.(cover);
            setSave({ state: "dirty" });
            timer.current = window.setTimeout(() => void doSave(), 300);
            return;
          }
          const was = base.current.content.replace(/\s+$/, "");
          const now = (latest.content ?? "").replace(/\s+$/, "");
          // Whole new blocks only: text added to the end of our last line (another tab, another
          // editor) is not an append, and taking it as one would split that line in two.
          if (now.startsWith(was) && (!was || /^[ \t]*\n/.test(now.slice(was.length))) && (latest.title ?? "") === base.current.title) {
            const extra = now.slice(was.length);
            base.current = { title: latest.title ?? "", content: latest.content ?? "" };
            baseRev.current = typeof latest.rev === "number" ? latest.rev : baseRev.current;
            if (extra.trim()) cbs.current.onAppend(extra);
            setSave({ state: "dirty" });
            timer.current = window.setTimeout(() => void doSave(), 300);
          } else {
            setConflict({ doc: latest });
            setSave({ state: "error", message: "This page changed." });
          }
        } catch {
          setSave({ state: "error", message: "This page changed. Couldn't load the newest version." });
        }
      } else if (status === 403 || status === 401) {
        setLock({ kind: "readonly", message: e instanceof Error ? e.message : "You can't edit this page any more." });
        setSave({ state: "error", message: "Not saved: you can't edit this page any more." });
      } else {
        setSave({ state: "error", message: e instanceof PagesApiError && status && status < 500 ? e.message : "Couldn't save. Trying again…" });
        if (status === 0 || status >= 500) timer.current = window.setTimeout(() => void doSave(), 5000);
      }
    } finally {
      saving.current = false;
      if (dirty.current && lockRef.current.kind === "mine" && !timer.current) timer.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
    }
  }, [slug, secret, fetchLatest, setLock]);

  /** Take the lock (once at a time). True when it's ours. */
  const acquire = useCallback((): Promise<boolean> => {
    if (lockRef.current.kind === "mine") return Promise.resolve(true);
    if (acquiring.current) return acquiring.current;
    setLock({ kind: "acquiring" });
    const p = (async () => {
      try {
        const r = await lockPage(slug, secret, { intent: "edit", dirty: dirty.current });
        applyTimers(r.timers);
        lastBeat.current = Date.now();
        setNotice(null);
        setLock({ kind: "mine" });
        // What was typed while the lock was on its way saves now.
        if (dirty.current && !timer.current) timer.current = window.setTimeout(() => void doSave(), 300);
        return true;
      } catch (e) {
        const status = pagesErrorStatus(e);
        if (status === 423 && pageLocked(e)) setLock({ kind: "readonly", message: "This page is locked. Only its owner and workspace admins can edit it." });
        else if (status === 423) setLock({ kind: "theirs", name: lockHolder(e), lost: dirty.current || undefined, facts: lockFacts(e) });
        else if (status === 403 || status === 401) setLock({ kind: "readonly", message: e instanceof Error ? e.message : "You can't edit this page." });
        // Offline or a server error: stay editable, and ask again shortly while there's text to save
        // (the first change may well have been made offline).
        else {
          setLock({ kind: "idle" });
          if (dirty.current && acquireRetry.current === null) {
            acquireRetry.current = window.setTimeout(() => {
              acquireRetry.current = null;
              if (lockRef.current.kind === "idle" && dirty.current) void acquireRef.current();
            }, 5000);
          }
        }
        return false;
      } finally {
        acquiring.current = null;
      }
    })();
    acquiring.current = p;
    return p;
  }, [slug, secret, setLock, doSave]);
  const acquireRef = useRef(acquire);
  acquireRef.current = acquire;
  useEffect(() => () => {
    if (acquireRetry.current !== null) window.clearTimeout(acquireRetry.current);
  }, []);
  // Back online with text to save that never got the lock: ask now.
  useEffect(() => {
    const online = () => {
      if (lockRef.current.kind === "idle" && dirty.current) void acquireRef.current();
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);

  /** Let go of the lock (after saving what's pending): the page stays editable. */
  const release = useCallback(async () => {
    if (lockRef.current.kind !== "mine") return;
    clearTimer();
    if (dirty.current) await doSave();
    if (dirty.current || saving.current || lockRef.current.kind !== "mine") return;
    setLock({ kind: "idle" });
    void unlockPage(slug, { secret }).catch(() => {});
  }, [slug, secret, doSave, setLock]);

  /**
   * A key, a click or a focus in the page: the person is here. It takes nothing: only a real
   * change (`update`) takes the lock, so a page opened and left alone blocks no one.
   */
  const activity = useCallback(() => {
    lastActive.current = Date.now();
  }, []);

  /** Nothing unsaved here: show the page's newest version if someone wrote one meanwhile. */
  const catchUp = useCallback(async () => {
    if (dirty.current || saving.current) return;
    try {
      const latest = await fetchLatest();
      if (dirty.current || saving.current) return;
      if (typeof latest.rev === "number" && (baseRev.current === null || latest.rev > baseRev.current)) adopt(latest);
    } catch {
      /* the next live change or save brings it */
    }
  }, [fetchLatest, adopt]);

  /**
   * Our text (`mine`, typed on top of `was`) goes on top of their newer version (`latest`, already
   * adopted): merged line by line (lib/pageMerge). Where both changed the same lines theirs stays on
   * the page and ours is kept in version history first — never dropped. Marks it to save.
   */
  const putMineOnTop = useCallback(async (was: { title: string; content: string }, mine: { title: string; content: string }, latest: PageDocument) => {
    const theirs = { title: latest.title ?? "", content: latest.content ?? "" };
    const m = merge3(was.content, mine.content, theirs.content);
    let content = m.content;
    if (!m.clean) {
      try {
        await keepUnsaved(slug, { title: mine.title, content: m.mineContent, base_rev: baseRev.current, reason: "conflict" }, secret);
      } catch {
        content = mine.content; /* couldn't keep it: our text stays as it was, and saves */
      }
    }
    const title = mine.title !== was.title ? mine.title : theirs.title;
    fields.current = { title, content };
    cbs.current.onRemote({ ...fields.current, rev: baseRev.current });
  }, [slug, secret]);

  /**
   * The lock went to someone else, or was taken over. Taken over with text not saved yet: that text
   * is kept as a version in the page's history first (never dropped), then the page shows theirs.
   * When the lock is someone's now: read only, following them; when nobody's (an AI app's write
   * took it): editable, with a notice.
   */
  const lose = useCallback(async (holder: string | null, takenBy: string | null, facts: LockFacts | null = null) => {
    clearTimer();
    let kept: number | null = null;
    let keptAll = !dirty.current;
    if (takenBy && dirty.current) {
      const f = { ...fields.current };
      try {
        kept = (await keepUnsaved(slug, { title: f.title, content: f.content, base_rev: baseRev.current, reason: "taken_over" }, secret)).version;
        keptAll = true;
      } catch {
        /* couldn't reach the server: the text stays on screen (and in this browser) */
      }
      if (keptAll) {
        try {
          adopt(await fetchLatest());
        } catch {
          /* the live socket brings theirs */
        }
      }
    }
    if (holder) setLock({ kind: "theirs", name: holder, lost: !keptAll || undefined, takenBy, kept, facts });
    else {
      setLock({ kind: "idle" });
      if (takenBy) setNotice({ by: takenBy, kept });
    }
    // Their change may have landed while this editor still thought the lock was its own.
    void catchUp();
  }, [slug, secret, adopt, fetchLatest, setLock, catchUp]);

  /**
   * Who's viewing says someone else is editing (before this editor asked for the lock): ask the
   * server how idle they are, whether they have unsaved changes and whether we may take over. It
   * takes nothing; from then on the page follows the "theirs" poll.
   */
  const probe = useCallback(async () => {
    if (lockRef.current.kind !== "idle") return;
    try {
      const st = await lockStatus(slug, secret);
      applyTimers(st.timers);
      if (st.holder && !st.mine && lockRef.current.kind === "idle") setLock({ kind: "theirs", name: st.holder.name, facts: lockFacts(st) });
    } catch {
      /* who's viewing still says so */
    }
  }, [slug, secret, setLock]);

  /** Renew the lock (`intent=heartbeat`): never takes back one that lapsed or was taken over. */
  const beat = useCallback(async () => {
    if (lockRef.current.kind !== "mine") return;
    const edited = lastEdit.current > lastBeat.current;
    lastBeat.current = Date.now();
    let r: LockInfo;
    try {
      r = await lockPage(slug, secret, { intent: "heartbeat", edited, hidden: document.visibilityState === "hidden", dirty: dirty.current || saving.current });
    } catch (e) {
      const status = pagesErrorStatus(e);
      if (status === 423 && !pageLocked(e)) {
        const f = lockFacts(e);
        await lose(lockHolder(e), f?.takenOverBy ?? null, f);
      } else if (status === 423) {
        clearTimer();
        setLock({ kind: "readonly", message: "This page is locked. Only its owner and workspace admins can edit it." });
      } else if (status === 401 || status === 403 || status === 404) {
        // No edit rights any more, or the page is gone: stop holding it here.
        clearTimer();
        setLock({ kind: "readonly", message: status === 404 ? "This page was deleted or moved." : e instanceof Error ? e.message : "You can't edit this page any more." });
      }
      return;
    }
    applyTimers(r.timers);
    if (r.mine !== false || lockRef.current.kind !== "mine") return;
    if (r.reason === "taken_over") await lose(null, r.taken_over?.by ?? "Someone");
    // Lapsed (idle, hidden, no heartbeat): nobody's now, and someone may have written since. The
    // next change takes it again.
    else if (!saving.current) {
      setLock({ kind: "idle" });
      void catchUp();
    }
  }, [slug, secret, lose, setLock, catchUp]);

  // Leave: save what's pending, then let go of the lock. (Opening takes nothing; a change does.)
  useEffect(() => {
    return () => {
      clearTimer();
      const held = lockRef.current.kind === "mine";
      if (held && dirty.current) {
        const f = fields.current;
        void savePage(slug, { title: f.title, content: f.content, baseRev: baseRev.current }, secret)
          .then((doc) => cbs.current.onSaved?.(doc))
          .catch(() => {})
          .finally(() => void unlockPage(slug, { keepalive: true, secret }).catch(() => {}));
      } else if (held) {
        void unlockPage(slug, { keepalive: true, secret }).catch(() => {});
      }
    };
  }, [slug, secret]);

  // Heartbeat while we hold it, or let it go 2 minutes after the last change (what's pending is
  // saved first). Someone took it over: `lose` (the text is kept).
  useEffect(() => {
    if (lock.kind !== "mine") return;
    if (!lastEdit.current) lastEdit.current = Date.now();
    const id = window.setInterval(() => {
      if (Date.now() - lastEdit.current > timers.current.idle && !saving.current) {
        void release();
        return;
      }
      void beat();
    }, timers.current.heartbeat);
    return () => window.clearInterval(id);
  }, [lock.kind, release, beat]);

  // The tab hidden: save what's pending and say so (the server lets the lock go 60 s later); still
  // hidden then, let go here too. Back: say so (the answer may be that it lapsed meanwhile).
  useEffect(() => {
    if (lock.kind !== "mine") return;
    let hideTimer = 0;
    const onVisibility = () => {
      window.clearTimeout(hideTimer);
      if (lockRef.current.kind !== "mine") return;
      if (document.visibilityState === "hidden") {
        void (async () => {
          if (dirty.current && !saving.current) await doSave();
          await beat();
        })();
        hideTimer = window.setTimeout(() => {
          if (document.visibilityState === "hidden") void release();
        }, timers.current.hidden);
      } else void beat();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(hideTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [lock.kind, doSave, beat, release]);

  // Live `lock` (someone took a lock over; no names on the socket), or someone else's version while
  // we think we hold it (it lapsed and they wrote): ask the server where we stand.
  useEffect(() => {
    if (!subscribeLive) return;
    return subscribeLive((msg) => {
      if (lockRef.current.kind !== "mine") return;
      const rev = typeof msg.rev === "number" ? msg.rev : null;
      if (msg.type === "lock" || (msg.type === "changed" && rev !== null && baseRev.current !== null && rev > baseRev.current && !saving.current)) void beat();
    });
  }, [subscribeLive, beat]);

  // Someone else is editing: ask again every 15 s. When it's free, load the newest; keep the lock
  // only when this person was busy here (or has text from before it was lost).
  useEffect(() => {
    if (lock.kind !== "theirs") return;
    const id = window.setInterval(async () => {
      // Asking never takes it: a tab left open on someone else's edit never grabs the page.
      try {
        const st = await lockStatus(slug, secret);
        applyTimers(st.timers);
        if (st.holder && !st.mine) {
          const l = lockRef.current;
          if (l.kind === "theirs") setLock({ ...l, name: st.holder.name ?? l.name, facts: lockFacts(st) });
          return; /* still theirs: try again next time */
        }
      } catch {
        return;
      }
      // Free. Nothing of ours to save: show the newest and wait for a change.
      if (!dirty.current) {
        try {
          adopt(await fetchLatest());
        } catch {
          /* the next change loads it */
        }
        setLock({ kind: "idle" });
        return;
      }
      try {
        const r = await lockPage(slug, secret, { intent: "edit", dirty: true });
        applyTimers(r.timers);
        lastEdit.current = Date.now();
      } catch {
        return; /* taken again meanwhile */
      }
      try {
        const latest = await fetchLatest();
        const mine = dirty.current ? { ...fields.current } : null;
        const was = { ...base.current };
        adopt(latest);
        setLock({ kind: "mine" });
        // Text typed before the lock was lost: merged into their newer version (lib/pageMerge) and
        // saved as the next version. Where both changed the same lines, theirs stays on the page and
        // ours is kept in version history first — never dropped.
        if (mine && mine.content !== latest.content) {
          await putMineOnTop(was, mine, latest);
          dirty.current = true;
          setSave({ state: "dirty" });
          timer.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
        } else if (Date.now() - lastActive.current > 60_000) {
          void release();
        }
      } catch {
        void release();
      }
    }, RETRY_MS);
    return () => window.clearInterval(id);
  }, [slug, secret, lock.kind, fetchLatest, adopt, doSave, setLock, release, putMineOnTop]);

  /**
   * An auto cover the server wrote at `rev` (a live `cover` event or a poll): into the editor, as part
   * of what the server holds (so it isn't an edit). When more than the cover changed since our base,
   * the next save meets a 409 and the merge above takes it.
   */
  const remoteCover = useCallback((cover: string, rev: number | null) => {
    if (rev !== null && baseRev.current !== null && rev <= baseRev.current) return;
    if (readPageProps(fields.current.content).cover) return; // someone chose one here meanwhile
    if (rev !== null && baseRev.current !== null && rev === baseRev.current + 1 && !saving.current) {
      base.current = { ...base.current, content: writePageProps(base.current.content, { cover, coverY: 50 }) };
      baseRev.current = rev;
    }
    cbs.current.onCover?.(cover);
  }, []);

  // Live: appended blocks go in at the end; anyone else's change is shown while the lock isn't ours.
  useEffect(() => {
    if (!subscribeLive) return;
    return subscribeLive((msg) => {
      const rev = typeof msg.rev === "number" ? msg.rev : null;
      if (msg.type === "cover" && typeof msg.cover === "string") {
        remoteCover(msg.cover, rev);
        return;
      }
      if (msg.type === "appended" && typeof msg.markdown === "string") {
        if (lockRef.current.kind === "mine") {
          // Only appends can land while we hold the lock: the server now has what we last saved
          // plus this, at `rev`.
          if (rev !== null && baseRev.current !== null && rev <= baseRev.current) return;
          base.current = { ...base.current, content: `${base.current.content.replace(/\s+$/, "")}\n\n${msg.markdown.trim()}\n` };
          if (rev !== null) baseRev.current = rev;
          cbs.current.onAppend(msg.markdown);
        } else if (!dirty.current) {
          void fetchLatest().then(adopt).catch(() => {});
        }
        return;
      }
      if (msg.type === "changed") {
        if (rev !== null && baseRev.current !== null && rev <= baseRev.current) return; // our own save
        // A version was restored (history/PageHistory): it replaces what's here, even while ours.
        if (msg.restored === true) {
          void fetchLatest().then(adopt).catch(() => {});
          return;
        }
        // Someone else's edit: show it, unless this editor has text on its way to the server (that
        // save then meets the newer version and asks).
        if (lockRef.current.kind !== "mine" && !dirty.current) void fetchLatest().then(adopt).catch(() => {});
      }
    });
  }, [subscribeLive, fetchLatest, adopt, remoteCover]);

  // A restore from this tab's version history: load it now (the live socket may be down).
  useEffect(() => {
    const onRestored = (e: Event) => {
      if ((e as CustomEvent<{ slug?: string }>).detail?.slug === slug) void fetchLatest().then(adopt).catch(() => {});
    };
    window.addEventListener("markdrop:page-restored", onRestored);
    return () => window.removeEventListener("markdrop:page-restored", onRestored);
  }, [slug, fetchLatest, adopt]);

  // Closing the tab with unsaved changes: ask; and release the lock either way.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) e.preventDefault();
    };
    const hide = () => {
      if (lockRef.current.kind === "mine") void unlockPage(slug, { keepalive: true, secret }).catch(() => {});
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("pagehide", hide);
    };
  }, [slug, secret]);

  /** The editor changed the title or the Markdown. */
  const update = useCallback((patch: Partial<{ title: string; content: string }>) => {
    const next = { ...fields.current, ...patch };
    fields.current = next;
    const kind = lockRef.current.kind;
    if (kind === "theirs" || kind === "readonly") return;
    const same = next.title === base.current.title && next.content === base.current.content;
    dirty.current = !same;
    if (same) {
      if (!saving.current) setSave((s) => (s.state === "dirty" ? { state: "saved", at: Date.now() } : s));
      clearTimer();
      return;
    }
    lastActive.current = Date.now();
    lastEdit.current = Date.now();
    setSave({ state: "dirty" });
    clearTimer();
    // Not ours yet: take it, and the save follows (acquire).
    if (kind !== "mine") {
      void acquire();
      return;
    }
    timer.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
  }, [doSave, acquire]);

  /** 409: take theirs (drop what isn't saved) or keep mine (save on top of theirs). */
  const resolveConflict = useCallback(async (choice: "theirs" | "mine") => {
    const c = conflict;
    setConflict(null);
    if (!c) return;
    if (choice === "theirs") {
      adopt(c.doc);
      return;
    }
    base.current = { title: c.doc.title ?? "", content: c.doc.content ?? "" };
    baseRev.current = typeof c.doc.rev === "number" ? c.doc.rev : baseRev.current;
    dirty.current = true;
    await doSave();
  }, [conflict, adopt, doSave]);

  const flush = useCallback(async () => {
    if (!dirty.current) return;
    if (lockRef.current.kind !== "mine" && !(await acquire())) return;
    await doSave();
  }, [doSave, acquire]);

  const retry = useCallback(() => {
    dirty.current = true;
    if (lockRef.current.kind !== "mine") void acquire();
    else void doSave();
  }, [doSave, acquire]);

  /**
   * Edit anyway (the page's owner, a workspace admin): take the lock from whoever holds it. Their
   * editor is told and keeps what it hadn't saved. Here the page is loaded fresh first (unless this
   * editor has text of its own on screen), then it's ours. A refusal comes back as its message.
   */
  const takeOver = useCallback(async (): Promise<string | null> => {
    try {
      const r = await lockPage(slug, secret, { intent: "edit", takeOver: true, dirty: dirty.current });
      applyTimers(r.timers);
      lastEdit.current = Date.now();
      lastBeat.current = Date.now();
      setNotice(null);
      try {
        const mine = dirty.current ? { ...fields.current } : null;
        const was = { ...base.current };
        const latest = await fetchLatest();
        adopt(latest);
        // Text of ours on screen (typed before someone else had the page): on top of theirs.
        if (mine && mine.content !== (latest.content ?? "")) {
          await putMineOnTop(was, mine, latest);
          dirty.current = true;
          setSave({ state: "dirty" });
        }
      } catch {
        /* editing what's on screen; a save that meets a newer version asks */
      }
      setLock({ kind: "mine" });
      if (dirty.current && !timer.current) timer.current = window.setTimeout(() => void doSave(), 300);
      return null;
    } catch (e) {
      if (pagesErrorStatus(e) === 423 && pageLocked(e)) {
        setLock({ kind: "readonly", message: "This page is locked. Only its owner and workspace admins can edit it." });
      }
      return e instanceof Error ? e.message : "Couldn't take over editing.";
    }
  }, [slug, secret, adopt, fetchLatest, doSave, setLock, putMineOnTop]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { save, lock, conflict, update, resolveConflict, flush, retry, activity, remoteCover, takeOver, notice, dismissNotice, probe };
}

/** The cover `latest` added when that is all that differs from `base` (else null). */
export function coverOnlyChange(base: string, latest: string): string | null {
  const a = readPageProps(base), b = readPageProps(latest);
  if (a.cover || !b.cover) return null;
  if (splitFrontmatter(base).body !== splitFrontmatter(latest).body) return null;
  const rest = (p: ReturnType<typeof readPageProps>) => JSON.stringify({ ...p, cover: null, coverY: 50 });
  return rest(a) === rest(b) ? b.cover : null;
}
