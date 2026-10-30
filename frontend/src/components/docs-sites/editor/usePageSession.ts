"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DocsApiError, docsErrorMessage, docsErrorStatus, getPage, lockPage, restoreVersion, savePage, unlockPage,
  type Page, type PageLock, type SaveConflict,
} from "@/lib/docsSites";

/** Lock heartbeat: the server lets a lock lapse 2 minutes after the last one. */
export const HEARTBEAT_MS = 30_000;
/** Autosave this long after the last keystroke. */
export const AUTOSAVE_MS = 2000;

export interface PageFields {
  title: string;
  description: string;
  icon: string | null;
  hidden: boolean;
  path: string;
  /** The body (no frontmatter); the header is the fields above, other keys frontmatter_extra. */
  markdown: string;
  frontmatter_extra: Record<string, unknown>;
}

export type SaveState =
  | { state: "saved"; at: string | null }
  | { state: "dirty" }
  | { state: "saving" }
  | { state: "error"; message: string };

export type LockState =
  | { kind: "none" }
  | { kind: "acquiring" }
  | { kind: "mine" }
  /** Someone else holds it. `lost`: it was ours and they took over (or it lapsed and they got it). */
  | { kind: "theirs"; lock: PageLock | null; lost?: boolean }
  /** Viewers, or the API refused us the lock for another reason. */
  | { kind: "readonly" };

const fieldsOf = (p: Page): PageFields => ({
  title: p.title ?? "",
  description: p.description ?? "",
  icon: p.icon ?? null,
  hidden: !!p.hidden,
  path: p.path,
  markdown: p.markdown ?? "",
  frontmatter_extra: p.frontmatter_extra ?? {},
});

const lockFrom = (e: unknown, fallback: PageLock | null): PageLock | null => {
  const l = e instanceof DocsApiError ? (e.info.lock as PageLock | undefined) : undefined;
  return l && typeof l === "object" && l.name ? l : fallback;
};

/** First path segments the docs site uses itself (the API refuses them too). */
const RESERVED_SEGMENTS = new Set(["docs-assets", "mcp", "md", "og", "changelog"]);

/** The API's page-address rules: "/" or up to 6 segments of [a-z0-9-]. */
export function pathProblem(path: string): string {
  if (path === "/") return "";
  if (!path.startsWith("/")) return "The address starts with /.";
  if (path.endsWith("/")) return "The address can't end with /.";
  const parts = path.slice(1).split("/");
  if (parts.some((p) => !p)) return "The address can't have //.";
  if (parts.some((p) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p))) return "Use lowercase letters, numbers and hyphens between the slashes.";
  if (parts.length > 6) return "Use at most 6 levels.";
  if (path.length > 200) return "That address is too long.";
  if (RESERVED_SEGMENTS.has(parts[0]!)) return `/${parts[0]} is used by the docs site itself.`;
  return "";
}

/**
 * One page open in the editor: loads it, holds its lock (acquire on open, heartbeat every 30 s,
 * release on leave; admins can take over), autosaves drafts with `base_rev` and surfaces the two
 * refusals the editor must handle: 409 (someone saved a newer version → `conflict`) and 423
 * (someone else holds the lock → `lock.kind === "theirs"`).
 */
export function usePageSession({ siteId, pageId, canEdit, onSaved }: {
  siteId: string;
  pageId: string | null;
  canEdit: boolean;
  onSaved?: (p: Page) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [fields, setFields] = useState<PageFields | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [save, setSave] = useState<SaveState>({ state: "saved", at: null });
  const [lock, setLockState] = useState<LockState>({ kind: "none" });
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  /** Moves each time a version is loaded from the server (open, reload, restore, conflict): the editor re-reads it. */
  const [loadSeq, setLoadSeq] = useState(0);

  const baseRev = useRef(0);
  const fieldsRef = useRef<PageFields | null>(null);
  const dirty = useRef(false);
  const saving = useRef(false);
  const timer = useRef<number | null>(null);
  const lockRef = useRef<LockState>({ kind: "none" });
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  // The ref follows every change at once (saves and heartbeats read it between renders).
  const setLock = useCallback((next: LockState | ((l: LockState) => LockState)) => {
    const v = typeof next === "function" ? next(lockRef.current) : next;
    lockRef.current = v;
    setLockState(v);
  }, []);

  const apply = useCallback((p: Page) => {
    const f = fieldsOf(p);
    setPage(p);
    setFields(f);
    fieldsRef.current = f;
    baseRev.current = p.rev ?? 0;
    dirty.current = false;
    setSave({ state: "saved", at: p.updated_at ?? null });
    setLoadSeq((n) => n + 1);
  }, []);

  const clearTimer = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const doSave = useCallback(async (): Promise<void> => {
    clearTimer();
    if (!pageId || !dirty.current || saving.current || lockRef.current.kind !== "mine" || !fieldsRef.current) return;
    const f = fieldsRef.current;
    const bad = pathProblem(f.path);
    if (bad) { setSave({ state: "error", message: bad }); return; }
    if (!f.title.trim()) { setSave({ state: "error", message: "Give the page a title." }); return; }
    saving.current = true;
    dirty.current = false;
    setSave({ state: "saving" });
    try {
      const p = await savePage(siteId, pageId, { ...f, title: f.title.trim(), base_rev: baseRev.current });
      baseRev.current = p.rev;
      setPage(p);
      onSavedRef.current?.(p);
      if (dirty.current) setSave({ state: "dirty" });
      else setSave({ state: "saved", at: p.updated_at });
    } catch (e) {
      dirty.current = true;
      const status = docsErrorStatus(e);
      const info = e instanceof DocsApiError ? e.info : {};
      if (status === 409 && typeof info.rev === "number") {
        setConflict({
          rev: info.rev,
          updated_by: (info.updated_by as string | undefined) ?? null,
          updated_by_name: (info.updated_by_name as string | undefined) ?? null,
          updated_at: (info.updated_at as string | undefined) ?? null,
        });
        setSave({ state: "error", message: "Someone saved a newer version." });
      } else if (status === 423) {
        setLock({ kind: "theirs", lock: lockFrom(e, null), lost: true });
        setSave({ state: "error", message: "Not saved: someone else is editing this page." });
      } else {
        setSave({ state: "error", message: docsErrorMessage(e, "Couldn't save. We'll keep trying.") });
        // Network blips: try again shortly.
        if (status === 0 || status >= 500) timer.current = window.setTimeout(() => void doSave(), 5000);
      }
    } finally {
      saving.current = false;
      // Typing during the save: save again.
      if (dirty.current && lockRef.current.kind === "mine" && !timer.current) timer.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
    }
  }, [siteId, pageId]);

  const acquire = useCallback(async (takeover = false): Promise<boolean> => {
    if (!pageId) return false;
    try {
      await lockPage(siteId, pageId, takeover);
      setLock({ kind: "mine" });
      return true;
    } catch (e) {
      const status = docsErrorStatus(e);
      if (status === 423) setLock({ kind: "theirs", lock: lockFrom(e, null) });
      else if (status === 403) setLock({ kind: "readonly" });
      else setLock({ kind: "theirs", lock: null });
      return false;
    }
  }, [siteId, pageId]);

  // Open a page: load it, then take the lock (editors and admins).
  useEffect(() => {
    clearTimer();
    setPage(null);
    setFields(null);
    fieldsRef.current = null;
    setConflict(null);
    setLoadError(null);
    setLock({ kind: "none" });
    dirty.current = false;
    if (!pageId) return;
    let live = true;
    (async () => {
      try {
        const p = await getPage(siteId, pageId);
        if (!live) return;
        apply(p);
        if (!canEdit) { setLock({ kind: "readonly" }); return; }
        setLock({ kind: "acquiring" });
        const ok = await acquire();
        if (!live) return;
        // Someone else had it: show who (the page response may already say).
        if (!ok && p.lock) setLock((l) => (l.kind === "theirs" && !l.lock ? { kind: "theirs", lock: p.lock } : l));
      } catch (e) {
        if (live) setLoadError({ status: docsErrorStatus(e), message: docsErrorMessage(e, "Couldn't open this page.") });
      }
    })();
    return () => {
      live = false;
      // Leaving: save what's pending, then let go of the lock.
      const held = lockRef.current.kind === "mine";
      const pending = dirty.current && fieldsRef.current;
      clearTimer();
      if (held && pending && fieldsRef.current) {
        const f = fieldsRef.current;
        void savePage(siteId, pageId, { ...f, base_rev: baseRev.current })
          .then((p) => onSavedRef.current?.(p))
          .catch(() => {})
          .finally(() => void unlockPage(siteId, pageId, { keepalive: true }).catch(() => {}));
      } else if (held) {
        void unlockPage(siteId, pageId, { keepalive: true }).catch(() => {});
      }
    };
  }, [siteId, pageId, canEdit, apply, acquire]);

  // Heartbeat while we hold the lock; if someone took it, stop editing (keep the text on screen).
  useEffect(() => {
    if (!pageId || lock.kind !== "mine") return;
    const id = window.setInterval(async () => {
      try {
        await lockPage(siteId, pageId);
      } catch (e) {
        if (docsErrorStatus(e) === 423) {
          clearTimer();
          setLock({ kind: "theirs", lock: lockFrom(e, null), lost: true });
        }
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [siteId, pageId, lock.kind]);

  // Someone else is editing: try again every 30 s; when it's free, load their latest and take it.
  useEffect(() => {
    if (!pageId || lock.kind !== "theirs" || lock.lost || !canEdit) return;
    const id = window.setInterval(async () => {
      try {
        const p = await getPage(siteId, pageId);
        if (p.lock) { setLock({ kind: "theirs", lock: p.lock }); apply(p); return; }
        apply(p);
        await acquire();
      } catch { /* try again next time */ }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [siteId, pageId, lock, canEdit, apply, acquire]);

  // Closing the tab with unsaved text: ask; and release the lock either way.
  useEffect(() => {
    if (!pageId) return;
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) e.preventDefault();
    };
    const hide = () => {
      if (lockRef.current.kind === "mine") void unlockPage(siteId, pageId, { keepalive: true }).catch(() => {});
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("pagehide", hide);
    };
  }, [siteId, pageId]);

  const update = useCallback((patch: Partial<PageFields>) => {
    if (lockRef.current.kind !== "mine" || !fieldsRef.current) return;
    const next = { ...fieldsRef.current, ...patch };
    fieldsRef.current = next;
    setFields(next);
    dirty.current = true;
    setSave({ state: "dirty" });
    clearTimer();
    timer.current = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
  }, [doSave]);

  /** 409: keep mine (overwrite their version) or take theirs (drop my unsaved changes). */
  const resolveConflict = useCallback(async (choice: "mine" | "theirs") => {
    if (!pageId) return;
    const known = conflict;
    setConflict(null);
    if (choice === "theirs") {
      const current = await getPage(siteId, pageId).catch(() => null);
      if (current) apply(current);
      return;
    }
    // Save on top of their version: the next save names their rev as its base.
    const rev = known?.rev ?? (await getPage(siteId, pageId).catch(() => null))?.rev;
    if (rev === undefined) return;
    baseRev.current = rev;
    dirty.current = true;
    await doSave();
  }, [siteId, pageId, conflict, apply, doSave]);

  /** Admins: take the lock from whoever holds it, then load the latest draft. */
  const takeOver = useCallback(async () => {
    if (!pageId) return;
    const ok = await acquire(true);
    if (!ok) return;
    const p = await getPage(siteId, pageId);
    const mine = dirty.current ? fieldsRef.current : null;
    apply(p);
    // We had unsaved text when the lock was lost: keep it on screen and save it as the next version.
    if (mine) update(mine);
  }, [siteId, pageId, acquire, apply, update]);

  const restore = useCallback(async (rev: number) => {
    if (!pageId) return;
    const p = await restoreVersion(siteId, pageId, rev);
    apply(p);
    onSavedRef.current?.(p);
  }, [siteId, pageId, apply]);

  const retry = useCallback(() => {
    dirty.current = true;
    void doSave();
  }, [doSave]);

  /** Drop what's on screen, load the latest draft, and edit again if the page is free. */
  const reloadLatest = useCallback(async () => {
    if (!pageId) return;
    const p = await getPage(siteId, pageId);
    apply(p);
    if (!canEdit) return;
    const ok = await acquire();
    if (!ok && p.lock) setLock((l) => (l.kind === "theirs" && !l.lock ? { kind: "theirs", lock: p.lock } : l));
  }, [siteId, pageId, canEdit, apply, acquire, setLock]);

  return { page, fields, loadSeq, loadError, save, lock, conflict, update, saveNow: doSave, retry, resolveConflict, takeOver, restore, reloadLatest };
}
