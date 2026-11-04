"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDocument } from "@/lib/api";
import { lockHolder, lockPage, pagesErrorStatus, savePage, unlockPage, PagesApiError, type PageDocument } from "@/lib/pages";
import { splitFrontmatter } from "@/components/docs-editor/core/frontmatter.mjs";
import { readPageProps } from "./pageProps";
import { writePageProps } from "./pagePropsWrite";

const pageLocked = (e: unknown) => e instanceof PagesApiError && e.info.code === "page_locked";

/** The server lets a lock lapse 2 minutes after the last heartbeat. */
export const HEARTBEAT_MS = 30_000;
/** Autosave this long after the last change. */
export const AUTOSAVE_MS = 2000;
/** Let go of the lock after this long without a key, a click or a change (someone else may edit). */
export const IDLE_MS = 3 * 60_000;
/** While someone else edits: ask for the lock this often. */
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
  /** Someone else is editing: read only, following their changes live. `lost`: it was ours. */
  | { kind: "theirs"; name: string | null; lost?: boolean }
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
 * - the first key, click or change (`activity`, `update`) takes the lock; it's heartbeated every
 *   30 s, let go of after 3 minutes without activity (what's pending is saved first) and on leave;
 * - autosaves 2 s after the last change through PUT /documents/{slug} with `base_rev`;
 * - 423 (someone else holds the lock): read only, "X is editing", following their changes live;
 *   asks again every 15 s, and when it's free the page is editable again (keeping the lock only
 *   when this person was busy here);
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
  /** The last key, click or change here (for letting go of an idle lock). */
  const lastActive = useRef(0);
  const acquiring = useRef<Promise<boolean> | null>(null);
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
        await lockPage(slug, secret);
        setLock({ kind: "mine" });
        // What was typed while the lock was on its way saves now.
        if (dirty.current && !timer.current) timer.current = window.setTimeout(() => void doSave(), 300);
        return true;
      } catch (e) {
        const status = pagesErrorStatus(e);
        if (status === 423 && pageLocked(e)) setLock({ kind: "readonly", message: "This page is locked. Only its owner and workspace admins can edit it." });
        else if (status === 423) setLock({ kind: "theirs", name: lockHolder(e), lost: dirty.current || undefined });
        else if (status === 403 || status === 401) setLock({ kind: "readonly", message: e instanceof Error ? e.message : "You can't edit this page." });
        // Offline or a server error: stay editable; the next key or change asks again.
        else setLock({ kind: "idle" });
        return false;
      } finally {
        acquiring.current = null;
      }
    })();
    acquiring.current = p;
    return p;
  }, [slug, secret, setLock, doSave]);

  /** Let go of the lock (after saving what's pending): the page stays editable. */
  const release = useCallback(async () => {
    if (lockRef.current.kind !== "mine") return;
    clearTimer();
    if (dirty.current) await doSave();
    if (dirty.current || saving.current || lockRef.current.kind !== "mine") return;
    setLock({ kind: "idle" });
    void unlockPage(slug, { secret }).catch(() => {});
  }, [slug, secret, doSave, setLock]);

  /** A key, a click or a focus in the page: take the lock if we haven't. */
  const activity = useCallback(() => {
    lastActive.current = Date.now();
    if (lockRef.current.kind === "idle") void acquire();
  }, [acquire]);

  // Leave: save what's pending, then let go of the lock. (Opening takes nothing; activity does.)
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

  // Heartbeat while we hold it, or let it go when nobody's been busy here; someone took it over:
  // stop editing (the text stays on screen).
  useEffect(() => {
    if (lock.kind !== "mine") return;
    const id = window.setInterval(async () => {
      if (Date.now() - lastActive.current > IDLE_MS && !saving.current) {
        void release();
        return;
      }
      try {
        await lockPage(slug, secret);
      } catch (e) {
        if (pagesErrorStatus(e) === 423) {
          clearTimer();
          setLock({ kind: "theirs", name: lockHolder(e), lost: true });
        }
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [slug, secret, lock.kind, setLock, release]);

  // Someone else is editing: ask again every 15 s. When it's free, load the newest; keep the lock
  // only when this person was busy here (or has text from before it was lost).
  useEffect(() => {
    if (lock.kind !== "theirs") return;
    const id = window.setInterval(async () => {
      try {
        await lockPage(slug, secret);
      } catch {
        return; /* still theirs: try again next time */
      }
      try {
        const latest = await fetchLatest();
        const mine = dirty.current ? { ...fields.current } : null;
        adopt(latest);
        setLock({ kind: "mine" });
        // Text typed before the lock was lost: keep it on screen and save it as the next version.
        if (mine && mine.content !== latest.content) {
          fields.current = mine;
          cbs.current.onRemote({ ...mine, rev: baseRev.current });
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
  }, [slug, secret, lock.kind, fetchLatest, adopt, doSave, setLock, release]);

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

  return { save, lock, conflict, update, resolveConflict, flush, retry, activity, remoteCover };
}

/** The cover `latest` added when that is all that differs from `base` (else null). */
export function coverOnlyChange(base: string, latest: string): string | null {
  const a = readPageProps(base), b = readPageProps(latest);
  if (a.cover || !b.cover) return null;
  if (splitFrontmatter(base).body !== splitFrontmatter(latest).body) return null;
  const rest = (p: ReturnType<typeof readPageProps>) => JSON.stringify({ ...p, cover: null, coverY: 50 });
  return rest(a) === rest(b) ? b.cover : null;
}
