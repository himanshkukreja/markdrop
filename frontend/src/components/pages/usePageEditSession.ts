"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDocument } from "@/lib/api";
import { lockHolder, lockPage, pagesErrorStatus, savePage, unlockPage, PagesApiError, type PageDocument } from "@/lib/pages";

const pageLocked = (e: unknown) => e instanceof PagesApiError && e.info.code === "page_locked";

/** The server lets a lock lapse 2 minutes after the last heartbeat. */
export const HEARTBEAT_MS = 30_000;
/** Autosave this long after the last change. */
export const AUTOSAVE_MS = 2000;

export type SaveState =
  | { state: "saved"; at: number | null }
  | { state: "dirty" }
  | { state: "saving" }
  | { state: "error"; message: string };

export type LockState =
  | { kind: "acquiring" }
  | { kind: "mine" }
  /** Someone else is editing: read only, following their changes live. `lost`: it was ours. */
  | { kind: "theirs"; name: string | null; lost?: boolean }
  /** The API refused the lock for another reason (no edit rights any more). */
  | { kind: "readonly"; message: string };

export interface Conflict {
  /** Their newest version. */
  doc: PageDocument;
}

/**
 * One page open in the block editor (one editor at a time):
 *
 * - takes the edit lock on open, heartbeats it every 30 s and releases it on leave;
 * - autosaves 2 s after the last change through PUT /documents/{slug} with `base_rev`;
 * - 423 (someone else holds the lock): read only, "X is editing", following live changes, and
 *   takes the lock when it's free again;
 * - 409 (a newer version): when it only adds to the end of what this editor last saved (an AI app's
 *   append_blocks), the addition is merged in and the save retried; otherwise "This page changed",
 *   with Load the latest / Keep mine;
 * - a live `appended` event goes straight into the editor at the end (`onAppend`).
 */
export function usePageEditSession({
  slug,
  secret,
  initial,
  onSaved,
  onAppend,
  onRemote,
  subscribeLive,
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
}) {
  const [save, setSave] = useState<SaveState>({ state: "saved", at: null });
  const [lock, setLockState] = useState<LockState>({ kind: "acquiring" });
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
  const cbs = useRef({ onSaved, onAppend, onRemote });
  cbs.current = { onSaved, onAppend, onRemote };

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
          const was = base.current.content.replace(/\s+$/, "");
          const now = (latest.content ?? "").replace(/\s+$/, "");
          if (now.startsWith(was) && (latest.title ?? "") === base.current.title) {
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

  const acquire = useCallback(async (): Promise<boolean> => {
    try {
      await lockPage(slug, secret);
      setLock({ kind: "mine" });
      return true;
    } catch (e) {
      const status = pagesErrorStatus(e);
      if (status === 423 && pageLocked(e)) setLock({ kind: "readonly", message: "This page is locked. Only its owner and workspace admins can edit it." });
      else if (status === 423) setLock({ kind: "theirs", name: lockHolder(e) });
      else if (status === 403 || status === 401) setLock({ kind: "readonly", message: e instanceof Error ? e.message : "You can't edit this page." });
      else setLock({ kind: "theirs", name: null });
      return false;
    }
  }, [slug, secret, setLock]);

  // Open: take the lock. Leave: save what's pending, then let go of it.
  useEffect(() => {
    void acquire();
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
  }, [slug, secret, acquire]);

  // Heartbeat while we hold it; someone took it over: stop editing (the text stays on screen).
  useEffect(() => {
    if (lock.kind !== "mine") return;
    const id = window.setInterval(async () => {
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
  }, [slug, secret, lock.kind, setLock]);

  // Someone else is editing: try again every 30 s; when it's free, load the newest and take it.
  useEffect(() => {
    if (lock.kind !== "theirs") return;
    const id = window.setInterval(async () => {
      try {
        await lockPage(slug, secret);
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
        }
      } catch {
        /* still theirs: try again next time */
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [slug, secret, lock.kind, fetchLatest, adopt, doSave, setLock]);

  // Live: appended blocks go in at the end; someone else's change is shown while read only.
  useEffect(() => {
    if (!subscribeLive) return;
    return subscribeLive((msg) => {
      const rev = typeof msg.rev === "number" ? msg.rev : null;
      if (msg.type === "appended" && typeof msg.markdown === "string") {
        if (lockRef.current.kind === "mine") {
          // Only appends can land while we hold the lock: the server now has what we last saved
          // plus this, at `rev`.
          if (rev !== null && baseRev.current !== null && rev <= baseRev.current) return;
          base.current = { ...base.current, content: `${base.current.content.replace(/\s+$/, "")}\n\n${msg.markdown.trim()}\n` };
          if (rev !== null) baseRev.current = rev;
          cbs.current.onAppend(msg.markdown);
        } else {
          void fetchLatest().then(adopt).catch(() => {});
        }
        return;
      }
      if (msg.type === "changed") {
        if (rev !== null && baseRev.current !== null && rev <= baseRev.current) return; // our own save
        if (lockRef.current.kind !== "mine") void fetchLatest().then(adopt).catch(() => {});
      }
    });
  }, [subscribeLive, fetchLatest, adopt]);

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
    if (lockRef.current.kind !== "mine") return;
    const same = next.title === base.current.title && next.content === base.current.content;
    dirty.current = !same;
    if (same) {
      if (!saving.current) setSave((s) => (s.state === "dirty" ? { state: "saved", at: Date.now() } : s));
      clearTimer();
      return;
    }
    setSave({ state: "dirty" });
    clearTimer();
    timer.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
  }, [doSave]);

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
    if (dirty.current) await doSave();
  }, [doSave]);

  const retry = useCallback(() => {
    dirty.current = true;
    void doSave();
  }, [doSave]);

  return { save, lock, conflict, update, resolveConflict, flush, retry };
}
