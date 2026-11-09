"use client";

/**
 * Comments on pages and markdown documents (CONTRACT §11). `CommentsHost` puts the store around an item
 * when its read says comments apply to this reader; `CommentLayer` paints highlights and offers "Comment"
 * on a selection; `CommentsPanel` lists the threads; `CommentsButton` sits in the top bar.
 */
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { DocComments } from "@/lib/comments";
import { CommentsProvider } from "./CommentsProvider";

export { CommentLayer } from "./CommentLayer";
export { CommentsButton } from "./CommentsButton";
// The panel (threads, composer, mention picker) loads only when an item has comments for this reader.
export const CommentsPanel = dynamic(() => import("./CommentsPanel").then((m) => m.CommentsPanel), { ssr: false, loading: () => null });
export { useComments } from "./context";
export type { CommentsCtx } from "./context";

const OFF: DocComments = { enabled: false, public: false, open: null, can_view: false, can_comment: false, reason: null };

export function CommentsHost({ summary, children, ...rest }: {
  slug: string;
  summary: DocComments | null | undefined;
  user: { id: string; name: string | null } | null;
  signInHref: string;
  subscribeLive?: ((fn: (msg: Record<string, unknown>) => void) => () => void) | null;
  readPassword?: string | null;
  children: ReactNode;
}) {
  // Always the provider (an inactive one without a summary): switching between a bare fragment and a provider
  // as the signed-in read arrives would remount the whole page under it.
  return <CommentsProvider summary={summary && summary.enabled ? summary : OFF} {...rest}>{children}</CommentsProvider>;
}
