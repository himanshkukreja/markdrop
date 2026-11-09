"use client";

/**
 * A page's Jira (chips, cards, lists) for this viewer: one GET …/items for every chip and card on the
 * page (the server batches Jira: one search per site, under the viewer's own token), refreshed when
 * the page's issues change and when someone changes an issue (the live socket's `{type: "jira"}`,
 * coalesced: at most one re-read every 1.5 s, none while the tab is hidden, one when it shows).
 * Anonymous readers get the snapshot ("KEY · title") and nothing else; no Jira call is made for them.
 *
 * Kept free of heavy imports: the reader loads it only when a page has Jira in it.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { itemId, jiraPageItems, jiraRemember, type JiraIssue, type JiraPageItem, type JiraPageItems } from "@/lib/jiraPages";

type Live = ((fn: (msg: Record<string, unknown>) => void) => () => void) | null | undefined;

const EMPTY: JiraPageItems = { configured: false, signed_in: false, connected: false, broken: false, can_edit: false, default_site: null, sites: [], items: {}, lists: 0 };

export class JiraPagesStore {
  readonly slug: string;
  readonly viewer: string | null;
  state: JiraPageItems = EMPTY;
  loaded = false;
  /** Bumped when lists should re-read (a live nudge, an action). */
  version = 0;
  private fns = new Set<() => void>();
  private timer: number | null = null;
  private wantReload = false;
  private remembered = new Set<string>();
  private last = 0;

  constructor(slug: string, viewer: string | null) {
    this.slug = slug;
    this.viewer = viewer;
  }

  subscribe = (fn: () => void) => {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  };

  private emit() {
    this.state = { ...this.state };
    for (const fn of this.fns) fn();
  }

  /** (Re)reads the page's items now. */
  async load(): Promise<void> {
    this.last = Date.now();
    try {
      this.state = await jiraPageItems(this.slug);
    } catch {
      this.state = { ...this.state };
    }
    this.loaded = true;
    this.emit();
  }

  /** A re-read soon (coalesced), e.g. after a live nudge; nothing while hidden. */
  reload = () => {
    if (typeof document !== "undefined" && document.hidden) {
      this.wantReload = true;
      return;
    }
    if (this.timer !== null) return;
    const wait = Math.max(0, 1500 - (Date.now() - this.last));
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.version += 1;
      void this.load();
    }, wait);
  };

  onVisible = () => {
    if (!document.hidden && this.wantReload) {
      this.wantReload = false;
      this.reload();
    }
  };

  get(site: string | null, key: string): JiraPageItem | null {
    const s = site || this.state.default_site;
    if (!s) return null;
    return this.state.items[itemId(s, key)] ?? null;
  }

  /** A site for something written without one: the page's, else the only one your Jira reaches. */
  siteFor(site?: string | null): string | null {
    return site || this.state.default_site || (this.state.sites.length === 1 ? this.state.sites[0] : null);
  }

  /** An action came back with the issue: show it at once (everyone else re-reads through the live nudge). */
  patch(site: string, issue: JiraIssue | null) {
    if (!issue) return;
    const id = itemId(site, issue.key);
    const cur = this.state.items[id];
    this.state.items = { ...this.state.items, [id]: { key: issue.key, site, url: cur?.url ?? `https://${site}/browse/${issue.key}`, title: issue.summary ?? cur?.title ?? null, issue } };
    this.version += 1;
    this.emit();
  }

  /**
   * An issue that isn't in the saved page yet (just inserted in the editor): its details for the editor
   * now, and its snapshot on the server (so readers get "KEY · title" from the next save on).
   */
  async ensure(site: string | null, key: string): Promise<void> {
    const s = this.siteFor(site);
    if (!s || this.get(s, key)?.issue || !this.state.can_edit || !this.state.connected) return;
    const id = itemId(s, key);
    if (this.remembered.has(id)) return;
    this.remembered.add(id);
    try {
      const r = await jiraRemember(this.slug, key, s);
      this.state.items = { ...this.state.items, [id]: { key, site: r.site, title: r.title, url: r.url, issue: r.issue } };
      this.emit();
    } catch {
      /* not visible to this editor: the chip stays a key */
    }
  }
}

/** The page's store, loaded once and kept current over the live socket. Null when disabled. */
export function useJiraPagesStore(slug: string | null, viewer: string | null, subscribeLive: Live, enabled: boolean, refsKey = ""): JiraPagesStore | null {
  const store = useMemo(() => (slug && enabled ? new JiraPagesStore(slug, viewer) : null), [slug, viewer, enabled]);
  useEffect(() => {
    if (!store) return;
    void store.load();
  }, [store, refsKey]);
  useEffect(() => {
    if (!store || !subscribeLive) return;
    return subscribeLive((msg) => {
      if (msg?.type === "jira") store.reload();
    });
  }, [store, subscribeLive]);
  useEffect(() => {
    if (!store) return;
    document.addEventListener("visibilitychange", store.onVisible);
    return () => document.removeEventListener("visibilitychange", store.onVisible);
  }, [store]);
  return store;
}

/** The store's state, re-rendering when it changes. */
export function useJiraState(store: JiraPagesStore | null): JiraPageItems {
  return useSyncExternalStore(store ? store.subscribe : noop, () => (store ? store.state : EMPTY), () => EMPTY);
}

/** One chip's or card's item (null until known); asks the editor's store for one not saved yet. */
export function useJiraItem(store: JiraPagesStore | null, site: string | null, key: string | null): { item: JiraPageItem | null; state: JiraPageItems; loaded: boolean } {
  const state = useJiraState(store);
  const item = store && key ? store.get(site, key) : null;
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!store || !key || !store.loaded || asked) return;
    if (!item?.issue) {
      setAsked(true);
      void store.ensure(site, key);
    }
  }, [store, key, site, item, asked, state]);
  return { item, state, loaded: !!store?.loaded };
}

const noop = () => () => {};
