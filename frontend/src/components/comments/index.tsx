"use client";

/**
 * Comments on pages and markdown documents (CONTRACT §11). `CommentsHost` puts the store around an item
 * when its read says comments apply to this reader; `CommentLayer` paints highlights and offers "Comment"
 * on a selection; `CommentsPanel` lists the threads; `CommentsButton` sits in the top bar.
 */
import type { ReactNode } from "react";
import type { DocComments } from "@/lib/comments";
import { CommentsProvider } from "./CommentsProvider";

export { CommentLayer } from "./CommentLayer";
export { CommentsPanel, CommentsButton } from "./CommentsPanel";
export { useComments } from "./context";
export type { CommentsCtx } from "./context";

export function CommentsHost({ summary, children, ...rest }: {
  slug: string;
  summary: DocComments | null | undefined;
  user: { id: string; name: string | null } | null;
  signInHref: string;
  subscribeLive?: ((fn: (msg: Record<string, unknown>) => void) => () => void) | null;
  readPassword?: string | null;
  children: ReactNode;
}) {
  if (!summary || !summary.enabled) return <>{children}</>;
  return <CommentsProvider summary={summary} {...rest}>{children}</CommentsProvider>;
}
