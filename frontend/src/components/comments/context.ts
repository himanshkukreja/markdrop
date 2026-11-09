"use client";

/**
 * The comments store's context (CONTRACT §11.2). `useComments()` is null outside a CommentsProvider
 * (anonymous readers of an item that doesn't show its comments publicly get no provider at all).
 */
import { createContext, useContext } from "react";
import type { AnchorIn, CommentPermsDto, Thread } from "@/lib/comments";

export type CommentsFilter = "open" | "resolved" | "mine";

export interface CommentsCtx {
  slug: string;
  enabled: boolean;
  isPublic: boolean;
  perms: CommentPermsDto;
  counts: { open: number; resolved: number };
  threads: Thread[];
  loading: boolean;
  error: string | null;
  filter: CommentsFilter;
  setFilter(f: CommentsFilter): void;
  activeId: string | null;
  setActive(id: string | null, opts?: { scroll?: boolean }): void;
  panelOpen: boolean;
  openPanel(threadId?: string): void;
  closePanel(): void;
  /** Opens the composer for a new thread on this anchor. */
  startDraft(anchor: AnchorIn): void;
  draftAnchor: AnchorIn | null;
  cancelDraft(): void;
  create(anchor: AnchorIn, body: string, mentions: string[], extra?: { attachments?: string[]; suggestion?: string | null; assignee?: string | null }): Promise<Thread>;
  reply(threadId: string, body: string, mentions: string[], extra?: { attachments?: string[]; suggestion?: string | null }): Promise<void>;
  edit(threadId: string, messageId: string, body: string, mentions: string[]): Promise<void>;
  remove(threadId: string, messageId: string): Promise<void>;
  resolve(threadId: string): Promise<void>;
  reopen(threadId: string): Promise<void>;
  react(threadId: string, messageId: string, emoji: string): Promise<void>;
  assign(threadId: string, userId: string | null): Promise<void>;
  /** B/C call after their own writes. */
  refresh(): Promise<void>;
  /** B/C: put a thread they got back into the store. */
  upsert(thread: Thread): void;
  user: { id: string; name: string | null } | null;
  signInHref: string;
  readPassword?: string | null;
}

export const CommentsContext = createContext<CommentsCtx | null>(null);

export function useComments(): CommentsCtx | null {
  return useContext(CommentsContext);
}
