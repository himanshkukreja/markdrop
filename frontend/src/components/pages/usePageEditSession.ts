"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getDocument } from "@/lib/api";
import { keepUnsaved, lockFacts, lockHolder, lockPage, lockStatus, pagesErrorStatus, savePage, unlockPage, PagesApiError, type LockFacts, type LockInfo, type LockTimers, type PageDocument } from "@/lib/pages";
import { splitFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import { readPageProps } from "./pageProps";
import { writePageProps } from "./pagePropsWrite";
import { merge3 } from "@/lib/pageMerge.mjs";

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
  /**
   * The three-way merge of this editor's unsaved changes onto `doc` (lib/pageMerge.mjs): what
   * Keep both / Use mine save. Absent when the titles conflict and the bodies don't.
   */
  merged?: { both: string; mine: string; title: string; count: number };
}

/** Why the page can't be edited here any more (it moved away, was deleted, access ended). */
const errStatus = (e: unknown): number => (e instanceof PagesApiError || e instanceof ApiError ? e.status : 0);

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
 * - 409 (a newer version): this editor's unsaved changes are merged onto it line by line
 *   (lib/pageMerge.mjs: an AI app's append_blocks, someone's edit to another paragraph) and the
 *   save retried; only when both changed the same lines: a banner with Keep both / Use theirs /
 *   Use mine (nothing is dropped without being asked; no saves until it's answered);
 * - catching up (fix/collab-audit): the live socket reconnecting (`resync`), the network coming
 *   back and the tab being shown again re-read the page; a newer version is shown, or merged
 *   under unsaved changes the same way, and pending text is saved;
 * - renamed while open (`gone` + the old address answering `moved`): saves follow the new
 *   address and `onMoved` takes the tab there; deleted, or no longer readable: read only, saying
 *   why, the text stays on screen and in this browser's draft;
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
  onMoved,
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
  /** The page was renamed while open: what was typed is saved there; go to its new address. */
  onMoved?: (doc: PageDocument) => void;
}) {
  const [save, setSave] = useState<SaveState>({ state: "saved", at: null });
  const [lock, setLockState] = useState<LockState>({ kind: "idle" });
  const [conflict, setConflictState] = useState<Conflict | null>(null);
  /** A conflict waiting for its answer: nothing saves meanwhile (each try would only meet it again). */
  const conflictRef = useRef<Conflict | null>(null);
  const setConflict = useCallback((c: Conflict | null) => {
    conflictRef.current = c;
    setConflictState(c);
  }, []);
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
  /** The lock's release token (its answers carry one): what the leaving beacon sends. */
  const releaseToken = useRef<string | null>(null);
  const keepToken = (r: LockInfo) => {
    if (typeof r.release_token === "string" && r.release_token) releaseToken.current = r.release_token;
  };
  /** The editor is going (unmount, another page): nothing new is scheduled, the lock is let go. */
  const leaving = useRef(false);
  /** Taking the lock failed for want of a network (or a server error) with text to save: try again. */
  const acquireRetry = useRef<number | null>(null);
  const cbs = useRef({ onSaved, onAppend, onRemote, onCover, onMoved });
  cbs.current = { onSaved, onAppend, onRemote, onCover, onMoved };
  /** Where this page is now: its slug, or the new one after a rename while open. */
  const slugRef = useRef(slug);
  useEffect(() => {
    slugRef.current = slug;
  }, [slug]);

  const clearTimer = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const fetchLatest = useCallback(async (): Promise<PageDocument> => {
    const pwd = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(`pwd:${slug}`) || undefined : undefined;
    return (await getDocument(slugRef.current, pwd, secret || undefined)) as PageDocument;
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

  /**
   * A newer version (`latest`) under this editor's unsaved changes: merged line by line onto it.
   * Clean: the editor shows the merge (still unsaved) and true. Both sides changed the same lines
   * (or both renamed the page differently): nothing changes here, the Conflict to ask about.
   */
  const rebase = useCallback((latest: PageDocument): true | Conflict => {
    const theirs = { title: latest.title ?? "", content: latest.content ?? "" };
    const was = base.current, mine = fields.current;
    const m = merge3(was.content, mine.content, theirs.content);
    const titleClash = mine.title !== was.title && theirs.title !== was.title && mine.title !== theirs.title;
    const title = mine.title !== was.title ? mine.title : theirs.title;
    if (!m.clean || titleClash) {
      return { doc: latest, merged: { both: m.bothContent, mine: m.mineContent, title, count: m.conflicts.length + (titleClash ? 1 : 0) } };
    }
    base.current = theirs;
    baseRev.current = typeof latest.rev === "number" ? latest.rev : baseRev.current;
    fields.current = { title, content: m.content };
    dirty.current = title !== theirs.title || m.content !== theirs.content;
    cbs.current.onRemote({ ...fields.current, rev: baseRev.current });
    return true;
  }, []);

  /** A 404 (or `gone`): renamed (follow it), deleted or no longer readable (read only, say so). */
  const checkGone = useRef<() => Promise<void>>(async () => {});
  const doSave = useCallback(async (): Promise<void> => {
    clearTimer();
    if (!dirty.current || saving.current || lockRef.current.kind !== "mine" || conflictRef.current) return;
    const sent = { ...fields.current };
    saving.current = true;
    dirty.current = false;
    setSave({ state: "saving" });
    try {
      const doc = await savePage(slugRef.current, { title: sent.title, content: sent.content, baseRev: baseRev.current }, secret);
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
            // Someone changed other lines (or the same ones): merge what's unsaved here onto it.
            const r = rebase(latest);
            if (r === true) {
              setSave(dirty.current ? { state: "dirty" } : { state: "saved", at: Date.now() });
              if (dirty.current) timer.current = window.setTimeout(() => void doSave(), 300);
            } else {
              setConflict(r);
              setSave({ state: "error", message: "This page changed." });
            }
          }
        } catch {
          setSave({ state: "error", message: "This page changed. Couldn't load the newest version." });
        }
      } else if (status === 403 || status === 401) {
        setLock({ kind: "readonly", message: e instanceof Error ? e.message : "You can't edit this page any more." });
        setSave({ state: "error", message: "Not saved: you can't edit this page any more." });
      } else if (status === 404) {
        // Renamed, deleted or no longer readable while open: find out which.
        void checkGone.current();
      } else {
        setSave({ state: "error", message: e instanceof PagesApiError && status && status < 500 ? e.message : "Couldn't save. Trying again…" });
        if (status === 0 || status >= 500) timer.current = window.setTimeout(() => void doSave(), 5000);
      }
    } finally {
      saving.current = false;
      if (dirty.current && lockRef.current.kind === "mine" && !timer.current && !leaving.current) timer.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
    }
  }, [slug, secret, fetchLatest, setLock, rebase, setConflict]);

  /** Take the lock (once at a time). True when it's ours. */
  const acquire = useCallback((): Promise<boolean> => {
    if (lockRef.current.kind === "mine") return Promise.resolve(true);
    // Never taken by an editor on its way out (a change its teardown reports, a late retry).
    if (leaving.current) return Promise.resolve(false);
    if (acquiring.current) return acquiring.current;
    setLock({ kind: "acquiring" });
    const p = (async () => {
      try {
        const r = await lockPage(slugRef.current, secret, { intent: "edit", dirty: dirty.current });
        applyTimers(r.timers);
        keepToken(r);
        lastBeat.current = Date.now();
        setNotice(null);
        setLock({ kind: "mine" });
        // What was typed while the lock was on its way saves now (or, the editor gone meanwhile,
        // as it lets go: see the leave effect).
        if (dirty.current && !timer.current && !leaving.current) timer.current = window.setTimeout(() => void doSave(), 300);
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
          // 404: renamed, deleted or no longer readable.
          if (status === 404) void checkGone.current();
          if (status !== 404 && dirty.current && acquireRetry.current === null) {
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

  /** Let go of the lock (after saving what's pending): the page stays editable. */
  const release = useCallback(async () => {
    if (lockRef.current.kind !== "mine") return;
    clearTimer();
    if (dirty.current) await doSave();
    if (dirty.current || saving.current || lockRef.current.kind !== "mine") return;
    setLock({ kind: "idle" });
    void unlockPage(slugRef.current, { secret }).catch(() => {});
  }, [slug, secret, doSave, setLock]);

  /**
   * The editor is leaving (unmount: another page, the sub-page it just made): what's pending is
   * saved, then the lock goes, whatever state it was caught in. A lock still on its way (the first
   * change was just made) is let go of as soon as it's ours; a save on its way lands first, so
   * what came after it saves on top. The text also stays in this browser's draft.
   */
  const letGo = useCallback(async (at: string) => {
    if (lockRef.current.kind === "acquiring" && acquiring.current) {
      if (!(await acquiring.current.catch(() => false))) return;
    }
    if (lockRef.current.kind !== "mine") return;
    for (let i = 0; saving.current && i < 200; i++) await new Promise((r) => window.setTimeout(r, 50));
    clearTimer();
    if (dirty.current && lockRef.current.kind === "mine" && !conflictRef.current) {
      const f = { ...fields.current };
      dirty.current = false;
      try {
        const doc = await savePage(at, { title: f.title, content: f.content, baseRev: baseRev.current }, secret);
        baseRev.current = typeof doc.rev === "number" ? doc.rev : baseRev.current;
        base.current = f;
      } catch {
        dirty.current = true; /* kept in this browser's draft */
      }
    }
    if (lockRef.current.kind !== "mine") return;
    setLock({ kind: "idle" });
    void unlockPage(at, { keepalive: true, secret, releaseToken: releaseToken.current }).catch(() => {});
  }, [secret, setLock]);

  /**
   * A key, a click or a focus in the page: the person is here. It takes nothing: only a real
   * change (`update`) takes the lock, so a page opened and left alone blocks no one.
   */
  const activity = useCallback(() => {
    lastActive.current = Date.now();
  }, []);

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
        await keepUnsaved(slugRef.current, { title: mine.title, content: m.mineContent, base_rev: baseRev.current, reason: "conflict" }, secret);
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
        kept = (await keepUnsaved(slugRef.current, { title: f.title, content: f.content, base_rev: baseRev.current, reason: "taken_over" }, secret)).version;
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
    void catchUp.current();
  }, [secret, adopt, fetchLatest, setLock]);

  /**
   * Who's viewing changed its mind about someone else editing: ask the server where the lock stands
   * (it takes nothing). Someone holds it: read only, with how idle they are, whether they have
   * unsaved changes and whether we may take over. Free while we were following someone: editable
   * again at once (showing their newest version) instead of on the next 15 s poll.
   */
  const probe = useCallback(async () => {
    const k = lockRef.current.kind;
    if (k !== "idle" && k !== "theirs") return;
    try {
      const st = await lockStatus(slugRef.current, secret);
      applyTimers(st.timers);
      const now = lockRef.current;
      if (st.holder && !st.mine) {
        if (now.kind === "idle") setLock({ kind: "theirs", name: st.holder.name, facts: lockFacts(st) });
        else if (now.kind === "theirs") setLock({ ...now, name: st.holder.name ?? now.name, facts: lockFacts(st) });
      } else if (now.kind === "theirs" && !now.lost && !dirty.current) {
        try {
          adopt(await fetchLatest());
        } catch {
          /* the next change or live event brings it */
        }
        if (lockRef.current.kind === "theirs") setLock({ kind: "idle" });
      }
    } catch {
      /* who's viewing still says so */
    }
  }, [secret, setLock, adopt, fetchLatest]);

  /** Renew the lock (`intent=heartbeat`): never takes back one that lapsed or was taken over. */
  const beat = useCallback(async () => {
    if (lockRef.current.kind !== "mine") return;
    const edited = lastEdit.current > lastBeat.current;
    lastBeat.current = Date.now();
    let r: LockInfo;
    try {
      r = await lockPage(slugRef.current, secret, { intent: "heartbeat", edited, hidden: document.visibilityState === "hidden", dirty: dirty.current || saving.current });
    } catch (e) {
      const status = pagesErrorStatus(e);
      if (status === 423 && !pageLocked(e)) {
        const f = lockFacts(e);
        await lose(lockHolder(e), f?.takenOverBy ?? null, f);
      } else if (status === 423) {
        clearTimer();
        setLock({ kind: "readonly", message: "This page is locked. Only its owner and workspace admins can edit it." });
      } else if (status === 401 || status === 403 || status === 404) {
        // No edit rights any more, or renamed or deleted: checkGone says which (and follows a rename).
        clearTimer();
        void checkGone.current();
      }
      return;
    }
    applyTimers(r.timers);
    keepToken(r);
    if (r.mine !== false || lockRef.current.kind !== "mine") return;
    if (r.reason === "taken_over") await lose(null, r.taken_over?.by ?? "Someone");
    // Lapsed (idle, hidden, no heartbeat): nobody's now, and someone may have written since. The
    // next change takes it again.
    else if (!saving.current) {
      setLock({ kind: "idle" });
      void catchUp.current();
    }
  }, [secret, lose, setLock]);

  // Leave: save what's pending, then let go of the lock (letGo). Opening takes nothing; a change does.
  const letGoRef = useRef(letGo);
  letGoRef.current = letGo;
  useEffect(() => {
    leaving.current = false;
    return () => {
      leaving.current = true;
      clearTimer();
      if (acquireRetry.current !== null) window.clearTimeout(acquireRetry.current);
      acquireRetry.current = null;
      void letGoRef.current(slugRef.current);
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
        const st = await lockStatus(slugRef.current, secret);
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
        const r = await lockPage(slugRef.current, secret, { intent: "edit", dirty: true });
        applyTimers(r.timers);
        keepToken(r);
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
        // save then meets the newer version and merges). Held or not: a lock that lapsed while this
        // laptop slept lets others write, and with nothing unsaved here there's nothing to lose.
        if (!dirty.current && !saving.current) void fetchLatest().then(adopt).catch(() => {});
        return;
      }
      // Renamed, deleted or no longer readable while open.
      if (msg.type === "gone") {
        void checkGone.current();
        return;
      }
      // The socket came back after a gap (sleep, network, a server restart): events may be lost.
      if (msg.type === "resync") void catchUp.current();
    });
  }, [subscribeLive, fetchLatest, adopt, remoteCover]);

  /**
   * Catch up with the server (after the socket, the network or the tab came back): a newer
   * version is shown, or merged under what's unsaved here; pending text is saved.
   */
  const catchUp = useRef<() => Promise<void>>(async () => {});
  catchUp.current = async () => {
    if (saving.current || lockRef.current.kind === "readonly" || conflictRef.current) return;
    let latest: PageDocument;
    try {
      latest = await fetchLatest();
    } catch (e) {
      if (errStatus(e) === 404 || errStatus(e) === 403 || errStatus(e) === 401) void checkGone.current();
      return;
    }
    if ((latest as { moved?: boolean }).moved) {
      void checkGone.current();
      return;
    }
    const rev = typeof latest.rev === "number" ? latest.rev : null;
    const newer = rev !== null && baseRev.current !== null && rev > baseRev.current;
    if (newer && saving.current) return; // that save meets it (409) and merges
    if (newer && !dirty.current) {
      adopt(latest);
      return;
    }
    if (newer) {
      const r = rebase(latest);
      if (r !== true) {
        setConflict(r);
        setSave({ state: "error", message: "This page changed." });
        return;
      }
    }
    if (!dirty.current) return;
    setSave({ state: "dirty" });
    // What was typed while offline saves now (taking the lock first when it isn't ours).
    if (lockRef.current.kind === "mine") {
      clearTimer();
      timer.current = window.setTimeout(() => void doSave(), 300);
    } else if (lockRef.current.kind === "idle") {
      void acquire();
    }
  };

  checkGone.current = async () => {
    let doc: PageDocument;
    try {
      doc = await fetchLatest();
    } catch (e) {
      const status = errStatus(e);
      if (status === 404 || status === 410) {
        clearTimer();
        setLock({ kind: "readonly", message: "This page was deleted (or you can no longer open it). What's on screen is kept in this browser; copy anything you need." });
        setSave({ state: "error", message: "Not saved: this page isn't here any more." });
      } else if (status === 403 || status === 401) {
        clearTimer();
        setLock({ kind: "readonly", message: "You can no longer edit this page. What's on screen is kept in this browser; copy anything you need." });
        setSave({ state: "error", message: "Not saved: you can't edit this page any more." });
      }
      return;
    }
    const moved = doc as PageDocument & { moved?: boolean };
    if (!moved.moved || !doc.slug || doc.slug === slugRef.current) return;
    // Renamed: save what's here at the new address first (the lock is the page's, not the
    // address's, so it still holds), then go there.
    slugRef.current = doc.slug;
    if (dirty.current && lockRef.current.kind === "mine") {
      clearTimer();
      await doSave();
    } else if (dirty.current && lockRef.current.kind === "idle" && (await acquire())) {
      clearTimer();
      await doSave();
    }
    cbs.current.onMoved?.(doc);
  };

  // The network or the tab came back: catch up (the socket's own `resync` may come later, or not
  // at all when it never noticed it was cut off).
  useEffect(() => {
    let hiddenAt = 0;
    const online = () => void catchUp.current();
    const vis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 30_000) void catchUp.current();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

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
    // The tab closing (or going to another site): the beacon goes now — there's no time to save
    // first (what's unsaved stays in this browser's draft, and leaving asked). A lock still on its
    // way is let go of too: a release token from an earlier lock here (the same person and page)
    // or the session says who.
    const hide = () => {
      const k = lockRef.current.kind;
      if (k === "mine" || k === "acquiring") void unlockPage(slugRef.current, { keepalive: true, secret, releaseToken: releaseToken.current }).catch(() => {});
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
    // Leaving: noted (letGo saves it if the lock is ours; the draft keeps it), never a new lock.
    if (leaving.current) return;
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

  /**
   * Both changed the same lines: keep both (theirs, then mine, in each clashing stretch; everything
   * else merged), use theirs (what's unsaved here goes, but stays in this browser's draft), or use
   * mine (their other changes are kept; only the clashing lines take mine; theirs stay in version
   * history).
   */
  const resolveConflict = useCallback(async (choice: "theirs" | "mine" | "both") => {
    const c = conflict;
    setConflict(null);
    if (!c) return;
    if (choice === "theirs") {
      adopt(c.doc);
      return;
    }
    // Merged again now: what was typed while the banner showed counts too.
    const was = base.current, mine = fields.current;
    const theirs = { title: c.doc.title ?? "", content: c.doc.content ?? "" };
    const m = merge3(was.content, mine.content, theirs.content);
    const title = mine.title !== was.title ? mine.title : theirs.title;
    base.current = theirs;
    baseRev.current = typeof c.doc.rev === "number" ? c.doc.rev : baseRev.current;
    fields.current = { title, content: choice === "both" ? m.bothContent : m.mineContent };
    cbs.current.onRemote({ ...fields.current, rev: baseRev.current });
    dirty.current = true;
    await doSave();
  }, [conflict, adopt, doSave, setConflict]);

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
      const r = await lockPage(slugRef.current, secret, { intent: "edit", takeOver: true, dirty: dirty.current });
      applyTimers(r.timers);
      keepToken(r);
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

  /** What the server holds as far as this editor knows (a local draft's base). */
  const baseline = useCallback(() => ({ ...base.current, rev: baseRev.current }), []);

  return { save, lock, conflict, update, resolveConflict, flush, retry, activity, remoteCover, baseline, takeOver, notice, dismissNotice, probe };
}

/** The cover `latest` added when that is all that differs from `base` (else null). */
export function coverOnlyChange(base: string, latest: string): string | null {
  const a = readPageProps(base), b = readPageProps(latest);
  if (a.cover || !b.cover) return null;
  if (splitFrontmatter(base).body !== splitFrontmatter(latest).body) return null;
  const rest = (p: ReturnType<typeof readPageProps>) => JSON.stringify({ ...p, cover: null, coverY: 50 });
  return rest(a) === rest(b) ? b.cover : null;
}
