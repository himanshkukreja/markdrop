/**
 * Track C (reach) registers its comment UI here (CONTRACT §11.3): the panel's ⋯ menu gains
 *
 * - "Comment insights" — open / resolved threads, reply times, the most-discussed sections (a dialog);
 * - "Export with comments" — the page's Export dialog, opening with "Include comments" on (pages only).
 *
 * Exports with comments themselves live in components/pages/export (Markdown, Word, PDF); the analytics
 * Comments tab in components/analytics/DocAnalytics.tsx renders <CommentsInsights>.
 */
import { canRequestExport, requestExportWithComments } from "@/lib/commentsInsights";
import type { CommentSlots } from "../slots";
import { openInsights } from "./InsightsDialog";

export { CommentsInsights } from "./CommentsInsights";

export function register(slots: CommentSlots): void {
  slots.panelActions.push(
    {
      id: "insights.open",
      label: "Comment insights",
      icon: "chart",
      when: (c) => c.perms.view && c.counts.open + c.counts.resolved > 0,
      run: (c) => openInsights(c),
    },
    {
      id: "insights.export",
      label: "Export with comments…",
      icon: "download",
      // The page's Export dialog listens (app/[slug]/DocumentView.tsx); a classic document has none.
      when: (c) => c.perms.view && c.counts.open + c.counts.resolved > 0 && canRequestExport(),
      run: () => requestExportWithComments(),
    },
  );
}

