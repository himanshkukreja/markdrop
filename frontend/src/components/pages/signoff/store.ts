"use client";

/**
 * A page's sign-offs for this viewer: one store per page (the reader's blocks, the editor's blocks
 * and the summary under the title share it), filled from GET …/signoffs and kept fresh when the
 * live socket says someone signed, when the page changes, and when the viewer changes.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getSignoffs, signOff, type SignoffState } from "@/lib/signoffs";

export interface PersonCard {
  name: string;
  avatar?: string | null;
}

export class SignoffStore {
  readonly slug: string;
  private states = new Map<string, SignoffState>();
  private people = new Map<string, PersonCard>();
  private listeners = new Set<() => void>();
  private seq = 0;
  version = 0;
  loaded = false;

  constructor(slug: string) {
    this.slug = slug;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  get(block: string | null | undefined): SignoffState | undefined {
    return block ? this.states.get(block) : undefined;
  }

  all(): SignoffState[] {
    return [...this.states.values()];
  }

  /** Signed blocks: id → who signed (for the editor's lock). */
  signed(): Map<string, SignoffState> {
    const out = new Map<string, SignoffState>();
    this.states.forEach((s, id) => s.option && out.set(id, s));
    return out;
  }

  /** A person picked in the editor (shown before the page is saved and read back). */
  remember(id: string, card: PersonCard) {
    this.people.set(id, card);
    this.emit();
  }

  person(id: string | null | undefined): PersonCard | undefined {
    if (!id) return undefined;
    const fromServer = [...this.states.values()].find((s) => s.person?.id === id && s.person.name);
    return fromServer?.person?.name ? { name: fromServer.person.name, avatar: fromServer.person.avatar } : this.people.get(id);
  }

  async refresh() {
    const seq = ++this.seq;
    try {
      const list = await getSignoffs(this.slug);
      if (seq !== this.seq) return;
      this.states = new Map(list.map((s) => [s.block, s]));
      this.loaded = true;
      this.emit();
    } catch {
      if (seq === this.seq && !this.loaded) {
        this.loaded = true;
        this.emit();
      }
    }
  }

  async sign(block: string, option: string | null, acknowledgeOpenComments = false): Promise<SignoffState> {
    this.seq++; // a refresh already on its way would bring the state from before
    const s = await signOff(this.slug, block, option, acknowledgeOpenComments);
    this.states.set(block, s);
    this.emit();
    return s;
  }
}

const stores = new Map<string, SignoffStore>();

export function signoffStore(slug: string): SignoffStore {
  let s = stores.get(slug);
  if (!s) {
    s = new SignoffStore(slug);
    stores.set(slug, s);
  }
  return s;
}

/** The sign-off heads in a page's Markdown (what's asked for changes when they do). */
export function signoffKey(markdown: string): string {
  return (markdown.match(/^[ \t>]*:{3,}signoff(?:\[[^\n]*?\])?\{[^\n]*\}/gm) ?? []).join("\n");
}

/**
 * The store for a page, refreshed when its sign-off blocks change, when the viewer changes, and
 * on the live socket's `signoff` and `changed` events.
 */
export function usePageSignoffs(slug: string | null, markdown: string, opts: { viewer?: string | null; subscribeLive?: ((fn: (msg: Record<string, unknown>) => void) => () => void) | null; enabled?: boolean } = {}) {
  const store = useMemo(() => (slug ? signoffStore(slug) : null), [slug]);
  const key = useMemo(() => signoffKey(markdown), [markdown]);
  const enabled = opts.enabled !== false && !!store && !!key;
  useEffect(() => {
    if (!enabled) return;
    const t = window.setTimeout(() => void store!.refresh(), store!.loaded ? 600 : 0);
    return () => window.clearTimeout(t);
  }, [enabled, store, key, opts.viewer]);
  const subscribeLive = opts.subscribeLive;
  useEffect(() => {
    if (!enabled || !subscribeLive) return;
    return subscribeLive((msg) => {
      if (msg.type === "signoff" || msg.type === "changed" || msg.type === "appended") void store!.refresh();
    });
  }, [enabled, store, subscribeLive]);
  useSyncExternalStore(store?.subscribe ?? noopSubscribe, () => store?.version ?? 0, () => 0);
  return store;
}

const noopSubscribe = () => () => {};

/** Re-renders when the store changes; the state of one block. */
export function useSignoffState(store: SignoffStore | null | undefined, block: string | null) {
  useSyncExternalStore(store?.subscribe ?? noopSubscribe, () => store?.version ?? 0, () => 0);
  return store?.get(block);
}
