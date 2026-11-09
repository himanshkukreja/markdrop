/**
 * Track B (review power) registers its comment UI here (CONTRACT §11.3):
 *
 * - threadSections: the suggested edit (with Accept / Reject / Withdraw / Edit), its editor, Ask Markdrop AI
 * - threadActions: Suggest an edit, Apply with AI, Ask Markdrop AI
 * - messageExtras: files and images in a message
 * - composerTools: Attach, Suggest (new comments on selected text), Check tone
 * - beforePost: the tone check (only drafts that read harsh reach AI)
 * - panelActions: Summarize discussion
 */
import type { Thread } from "@/lib/comments";
import type { CommentsCtx } from "../context";
import type { CommentSlots } from "../slots";
import { AttachTool, MessageFiles } from "./Attachments";
import { SuggestTool, ToneTool, toneBeforePost } from "./Composer";
import { SuggestionSection } from "./SuggestionSection";
import { openSummary } from "./Summary";
import { reviewUi } from "./store";
import "./review.css";

function canSuggest(t: Thread, c: CommentsCtx): boolean {
  if (t.anchor.type !== "text" || t.status !== "open" || !c.perms.comment || !c.user) return false;
  const s = t.suggestion;
  return !(s && s.state === "open" && s.by?.id !== c.user.id);
}

export function register(slots: CommentSlots): void {
  slots.threadSections.push({ id: "review.suggestion", Component: SuggestionSection });
  slots.threadActions.push(
    {
      id: "review.suggest",
      label: "Suggest an edit",
      icon: "edit",
      when: canSuggest,
      run: (t) => reviewUi.openEditor(t.id, { text: t.suggestion?.state === "open" ? t.suggestion.text : t.anchor.quote?.exact ?? "", ai: false, note: null }),
    },
    {
      id: "review.apply-ai",
      label: "Apply with AI",
      icon: "sparkle",
      when: canSuggest,
      run: (t) => reviewUi.openEditor(t.id, { text: t.anchor.quote?.exact ?? "", drafting: true, ai: false, note: null }),
    },
    {
      id: "review.ask-ai",
      label: "Ask Markdrop AI",
      icon: "message",
      when: (t, c) => !!c.user && c.perms.comment && t.status === "open",
      run: (t) => reviewUi.setAsking(t.id, true),
    },
  );
  slots.messageExtras.push({ id: "review.files", Component: MessageFiles });
  slots.composerTools.push(
    { id: "review.attach", Component: AttachTool },
    { id: "review.suggest", Component: SuggestTool },
    { id: "review.tone", Component: ToneTool },
  );
  slots.beforePost.push((draft, ctx) => toneBeforePost(draft, ctx));
  slots.panelActions.push({
    id: "review.summary",
    label: "Summarize discussion",
    icon: "sparkle",
    when: (c) => !!c.user && c.perms.view && c.counts.open + c.counts.resolved > 0,
    run: (c) => openSummary(c),
  });
}
