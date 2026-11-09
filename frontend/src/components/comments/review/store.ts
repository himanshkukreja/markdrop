"use client";

/**
 * Review UI state that outlives one render and is shared between slot components: which thread has its
 * suggestion editor or its "Ask AI" box open (thread actions open them; the suggestion section renders them),
 * and signed links for files in comments (fetched in batches, renewed before they expire).
 */
import { useSyncExternalStore } from "react";
import { fileLinks, type FileLink } from "@/lib/commentsReview";
import type { CallOpts } from "@/lib/comments";

type Listener = () => void;

export interface EditorState {
  text: string;
  /** Drafting with AI right now / the draft came from AI. */
  drafting: boolean;
  ai: boolean;
  note: string | null;
}

class ReviewUi {
  private editors = new Map<string, EditorState>();
  private asking = new Set<string>();
  private listeners = new Set<Listener>();
  version = 0;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private emit() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  editor(id: string): EditorState | undefined {
    return this.editors.get(id);
  }

  openEditor(id: string, init: Partial<EditorState> = {}) {
    this.editors.set(id, { text: "", drafting: false, ai: false, note: null, ...this.editors.get(id), ...init });
    this.emit();
  }

  closeEditor(id: string) {
    if (this.editors.delete(id)) this.emit();
  }

  isAsking(id: string) {
    return this.asking.has(id);
  }

  setAsking(id: string, on: boolean) {
    if (on) this.asking.add(id);
    else this.asking.delete(id);
    this.emit();
  }
}

export const reviewUi = new ReviewUi();

export function useReviewUi() {
  useSyncExternalStore(reviewUi.subscribe, () => reviewUi.version, () => 0);
  return reviewUi;
}

// ── Signed links for files in comments ───────────────────────────────────────

class Links {
  private cache = new Map<string, FileLink>();
  private waiting = new Map<string, Set<string>>();
  private timers = new Map<string, number>();
  private listeners = new Set<Listener>();
  private failed = new Set<string>();
  version = 0;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private emit() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  private fresh(l: FileLink | undefined): l is FileLink {
    if (!l) return false;
    if (!l.expires_at) return true;
    return Date.parse(l.expires_at) - Date.now() > 60_000;
  }

  get(slug: string, id: string, opts: CallOpts = {}): FileLink | undefined {
    const key = `${slug}:${id}`;
    const hit = this.cache.get(key);
    if (this.fresh(hit)) return hit;
    if (!this.failed.has(key)) this.want(slug, id, opts);
    return hit;
  }

  /** A link the uploader got back with the file (no request needed). */
  put(slug: string, link: FileLink) {
    this.cache.set(`${slug}:${link.id}`, link);
    this.emit();
  }

  private want(slug: string, id: string, opts: CallOpts) {
    const set = this.waiting.get(slug) ?? new Set<string>();
    if (set.has(id)) return;
    set.add(id);
    this.waiting.set(slug, set);
    if (this.timers.has(slug)) return;
    this.timers.set(slug, window.setTimeout(() => void this.flush(slug, opts), 30));
  }

  private async flush(slug: string, opts: CallOpts) {
    this.timers.delete(slug);
    const ids = [...(this.waiting.get(slug) ?? [])];
    this.waiting.delete(slug);
    if (!ids.length) return;
    try {
      const r = await fileLinks(slug, ids, opts);
      for (const id of ids) {
        const l = r.attachments[id];
        if (l) this.cache.set(`${slug}:${id}`, l);
        else this.failed.add(`${slug}:${id}`);
      }
    } catch {
      ids.forEach((id) => this.failed.add(`${slug}:${id}`));
    }
    this.emit();
  }
}

export const links = new Links();

export function useFileLink(slug: string, id: string, opts: CallOpts = {}): FileLink | undefined {
  useSyncExternalStore(links.subscribe, () => links.version, () => 0);
  return links.get(slug, id, opts);
}
