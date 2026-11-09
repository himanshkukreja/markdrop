"use client";

/**
 * The comments store for one item (CONTRACT §11.2). Loads the threads once when the item opens (signed-in
 * viewers, or anyone when the owner shows comments publicly), follows the live socket's `comments` signal
 * (at most one re-read every 3 s, none while the tab is hidden, one catch-up when it's shown), and opens a
 * thread from `#c-<id>` links (notifications, Home, Slack).
 *
 * Anonymous readers of an item that keeps its comments private get the provider in "sign in" mode: no
 * request at all, only the "Sign in to comment" prompt on a selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  THREAD_HASH,
  assignThread,
  createThread,
  deleteMessage,
  editMessage,
  listComments,
  reactMessage,
  reopenThread,
  replyThread,
  resolveThread,
  threadHash,
  type AnchorIn,
  type CommentPermsDto,
  type CommentsList,
  type DocComments,
  type Thread,
} from "@/lib/comments";
import { useToast } from "@/components/ui";
import { CommentsContext, type CommentsCtx, type CommentsFilter } from "./context";

const LIVE_GAP_MS = 3000;
const PANEL_KEY = "md_comments_panel";

const NO_PERMS: CommentPermsDto = {
  eligible: true, enabled: true, view: false, comment: false, resolve_any: false, accept: false, assign: false,
  settings: false, moderate: false, reason: "signin",
};

function readPanelPref(): "open" | "closed" | null {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    return v === "open" || v === "closed" ? v : null;
  } catch {
    return null;
  }
}

function writePanelPref(v: "open" | "closed") {
  try { localStorage.setItem(PANEL_KEY, v); } catch { /* storage off */ }
}

export interface CommentsProviderProps {
  slug: string;
  summary: DocComments;
  user: { id: string; name: string | null } | null;
  signInHref: string;
  subscribeLive?: ((fn: (msg: Record<string, unknown>) => void) => () => void) | null;
  readPassword?: string | null;
  workspace?: string | null;
  children: ReactNode;
}

export function CommentsProvider({ slug, summary, user, signInHref, subscribeLive, readPassword, workspace, children }: CommentsProviderProps) {
  const toast = useToast();
  const [list, setList] = useState<CommentsList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CommentsFilter>("open");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [draftAnchor, setDraftAnchor] = useState<AnchorIn | null>(null);
  const canLoad = summary.enabled && (summary.can_view || summary.public);
  const opts = useMemo(() => ({ readPassword: readPassword ?? null, workspace: workspace ?? null }), [readPassword, workspace]);
  const userId = user?.id ?? null;

  const load = useCallback(async () => {
    if (!canLoad) return;
    setLoading(true);
    try {
      const got = await listComments(slug, opts);
      setList(got);
      setError(null);
    } catch (e) {
      const status = (e as { status?: number }).status;
      // Not allowed any more (signed out, access narrowed, switched off): a clean page, no error.
      if (status === 401 || status === 403 || status === 404) setList(null);
      else setError(e instanceof Error ? e.message : "Couldn't load comments.");
    } finally {
      setLoading(false);
    }
  }, [canLoad, slug, opts]);

  // Once on open (and again when the reader signs in or out).
  useEffect(() => {
    setList(null);
    void load();
  }, [load, userId]);

  // The panel starts open on wide screens when there's something to read (and the reader didn't close it).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !list) return;
    opened.current = true;
    const pref = readPanelPref();
    const wide = typeof window !== "undefined" && window.matchMedia?.("(min-width: 1400px)").matches;
    if (pref === "open" || (pref !== "closed" && wide && list.counts.open > 0)) setPanelOpen(true);
  }, [list]);

  // Live: a `comments` signal re-reads the list, coalesced.
  useEffect(() => {
    if (!subscribeLive || !canLoad) return;
    let last = 0;
    let timer: number | null = null;
    let pending = false;
    const flush = () => {
      timer = null;
      if (!pending) return;
      if (document.visibilityState === "hidden") return;
      pending = false;
      last = Date.now();
      void load();
    };
    const queue = () => {
      pending = true;
      if (timer != null || document.visibilityState === "hidden") return;
      const wait = Math.max(0, last + LIVE_GAP_MS - Date.now()) + Math.random() * 300;
      timer = window.setTimeout(flush, wait);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && pending && timer == null) timer = window.setTimeout(flush, Math.random() * 300);
    };
    document.addEventListener("visibilitychange", onVisible);
    const off = subscribeLive((msg) => {
      if (msg.type === "comments" || msg.type === "resync") queue();
    });
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [subscribeLive, canLoad, load]);

  const openPanel = useCallback((threadId?: string) => {
    setPanelOpen(true);
    writePanelPref("open");
    if (threadId) {
      setActiveId(threadId);
      const t = list?.threads.find((x) => x.id === threadId);
      if (t) setFilter((f) => (t.status === "resolved" ? "resolved" : f === "resolved" ? "open" : f));
    }
  }, [list]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setDraftAnchor(null);
    writePanelPref("closed");
  }, []);

  // `#c-<id>`: open that thread (from a notification, Home, an email or Slack).
  useEffect(() => {
    if (!list) return;
    const go = () => {
      const m = THREAD_HASH.exec(window.location.hash);
      if (!m) return;
      const t = list.threads.find((x) => x.id === m[1]);
      if (!t) return;
      setPanelOpen(true);
      setActiveId(t.id);
      setFilter(t.status === "resolved" ? "resolved" : "open");
      window.dispatchEvent(new CustomEvent("md:comments-reveal", { detail: { id: t.id } }));
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [list]);

  const upsert = useCallback((t: Thread) => {
    setList((cur) => {
      if (!cur) return cur;
      const i = cur.threads.findIndex((x) => x.id === t.id);
      const threads = i === -1 ? [...cur.threads, t] : cur.threads.map((x) => (x.id === t.id ? t : x));
      const open = threads.filter((x) => x.status === "open").length;
      return { ...cur, threads, counts: { open, resolved: threads.length - open } };
    });
  }, []);

  const fail = useCallback((e: unknown): never => {
    const msg = e instanceof Error ? e.message : "That didn't work. Try again.";
    toast.error(msg);
    throw e;
  }, [toast]);

  const ctx: CommentsCtx = useMemo(() => {
    const perms = list?.can ?? { ...NO_PERMS, enabled: summary.enabled, view: false, comment: false, reason: summary.reason };
    const threads = list?.threads ?? [];
    return {
      slug,
      enabled: summary.enabled,
      isPublic: list?.public ?? summary.public,
      perms,
      counts: list?.counts ?? { open: summary.open ?? 0, resolved: 0 },
      threads,
      loading,
      error,
      filter,
      setFilter,
      activeId,
      setActive: (id, o) => {
        setActiveId(id);
        if (id && o?.scroll) window.dispatchEvent(new CustomEvent("md:comments-reveal", { detail: { id } }));
      },
      panelOpen,
      openPanel,
      closePanel,
      draftAnchor,
      startDraft: (anchor) => {
        setDraftAnchor(anchor);
        setActiveId(null);
        setFilter((f) => (f === "resolved" ? "open" : f));
        setPanelOpen(true);
      },
      cancelDraft: () => setDraftAnchor(null),
      create: async (anchor, body, mentions, extra) => {
        try {
          const t = await createThread(slug, { anchor, body, mentions, ...(extra ?? {}) }, opts);
          upsert(t);
          setDraftAnchor(null);
          setActiveId(t.id);
          if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${threadHash(t.id)}`);
          return t;
        } catch (e) {
          return fail(e);
        }
      },
      reply: async (id, body, mentions, extra) => {
        try {
          const got = await replyThread(slug, id, { body, mentions, ...(extra ?? {}) }, opts);
          upsert(got.thread);
        } catch (e) {
          fail(e);
        }
      },
      edit: async (id, mid, body, mentions) => {
        try {
          await editMessage(slug, id, mid, { body, mentions }, opts);
          await load();
        } catch (e) {
          fail(e);
        }
      },
      remove: async (id, mid) => {
        try {
          await deleteMessage(slug, id, mid, opts);
          await load();
        } catch (e) {
          fail(e);
        }
      },
      resolve: async (id) => {
        try {
          upsert(await resolveThread(slug, id, opts));
          toast.success("Resolved", { action: { label: "Undo", onClick: () => void reopenThread(slug, id, opts).then(upsert) } });
        } catch (e) {
          fail(e);
        }
      },
      reopen: async (id) => {
        try {
          upsert(await reopenThread(slug, id, opts));
        } catch (e) {
          fail(e);
        }
      },
      react: async (id, mid, emoji) => {
        try {
          const m = await reactMessage(slug, id, mid, emoji, undefined, opts);
          setList((cur) => cur && {
            ...cur,
            threads: cur.threads.map((t) => (t.id !== id ? t : { ...t, messages: t.messages.map((x) => (x.id === mid ? m : x)) })),
          });
        } catch (e) {
          fail(e);
        }
      },
      assign: async (id, uid) => {
        try {
          upsert(await assignThread(slug, id, uid, opts));
        } catch (e) {
          fail(e);
        }
      },
      refresh: load,
      upsert,
      user,
      signInHref,
      readPassword: readPassword ?? null,
    };
  }, [list, summary, slug, loading, error, filter, activeId, panelOpen, openPanel, closePanel, draftAnchor, opts, upsert, fail, load, user, signInHref, readPassword, toast]);

  return <CommentsContext.Provider value={ctx}>{children}</CommentsContext.Provider>;
}
