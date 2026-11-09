/**
 * Extension points other tracks plug into (CONTRACT §11.3): thread actions (B: Suggest, Apply with AI),
 * sections under a thread's first message (B: the suggestion card), extras under a message (B: attachments),
 * composer tools (B: attach, suggest), checks before posting (B: tone check), and the panel header's menu
 * (B: Summarize; C: Export with comments, Insights). Tracks register in their own index files; nobody edits
 * Track A's components to add a button.
 */
import type { ComponentType } from "react";
import type { IconName } from "@/components/ui/icons";
import type { Message, Thread } from "@/lib/comments";
import type { CommentsCtx } from "./context";
import { register as registerReview } from "./review";
import { register as registerInsights } from "./insights";
// Track D (Jira in pages): "Create Jira issue" / "Link a Jira issue" on a thread, and the linked issue under it.
import { register as registerJira } from "@/components/jira/pages/ThreadJira";

export interface Draft {
  body: string;
  mentions: string[];
  attachments: Array<{ id: string; name: string; mime: string; size: number }>;
  suggestion?: string | null;
}

export interface ThreadAction {
  id: string;
  label: string;
  icon: IconName;
  when(t: Thread, c: CommentsCtx): boolean;
  run(t: Thread, c: CommentsCtx): void | Promise<void>;
}

export interface ThreadSection {
  id: string;
  Component: ComponentType<{ thread: Thread; ctx: CommentsCtx }>;
}

export interface MessageExtra {
  id: string;
  Component: ComponentType<{ message: Message; thread: Thread; ctx: CommentsCtx }>;
}

export interface ComposerTool {
  id: string;
  Component: ComponentType<{ draft: Draft; setDraft(d: Draft): void; ctx: CommentsCtx; threadId: string | null }>;
}

/** Runs before a post; resolve to the (possibly changed) draft, or null to cancel. */
export type BeforePost = (draft: Draft, ctx: CommentsCtx, threadId: string | null) => Promise<Draft | null>;

export interface PanelAction {
  id: string;
  label: string;
  icon: IconName;
  when(c: CommentsCtx): boolean;
  run(c: CommentsCtx): void;
}

export interface CommentSlots {
  threadActions: ThreadAction[];
  threadSections: ThreadSection[];
  messageExtras: MessageExtra[];
  composerTools: ComposerTool[];
  beforePost: BeforePost[];
  panelActions: PanelAction[];
}

let registry: CommentSlots | null = null;

export function slots(): CommentSlots {
  if (registry) return registry;
  registry = { threadActions: [], threadSections: [], messageExtras: [], composerTools: [], beforePost: [], panelActions: [] };
  registerReview(registry);
  registerInsights(registry);
  registerJira(registry);
  return registry;
}
