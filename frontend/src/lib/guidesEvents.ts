/**
 * Markdrop Guides' product events, through lib/track (first-party, mirrored to PostHog and GA by
 * its privacy layer). lib/docsSites fires them once the API has accepted the change, so every screen
 * that makes the change reports it the same way, and a refused call reports nothing.
 *
 * Props are enums, counts and booleans only: never a site, page or person id, a title or name, an
 * address or domain, a URL (an import's source included), CSS, a note or an email.
 *
 *   guide_created                 source: blank|template|import|github, template?: product|api|helpcenter, workspace
 *   guide_import_started          source: gitbook
 *   guide_page_created / guide_page_deleted / guide_page_restored
 *   guide_publish_requested       note (a publish note was written)
 *   guide_review_submitted / guide_review_approved / guide_review_changes_requested / guide_review_withdrawn
 *   guide_restored                (an earlier publish put live again)
 *   guide_design_saved            preset, mode, brand, css (custom CSS present, never its text)
 *   guide_renamed / guide_address_changed
 *   guide_ask_ai_toggled          enabled
 *   guide_ask_ai_renamed / guide_ask_ai_questions (n)
 *   guide_access_changed          access: public|password|members
 *   guide_indexing_changed        enabled
 *   guide_reviews_required        enabled
 *   guide_redirects_saved         n
 *   guide_member_role_changed     scope: workspace|site, role (admin|reviewer|editor|viewer|none|inherit)
 *   guide_unpublished / guide_deleted
 *
 * What finishes on the server (a build going live or failing, an import finishing or failing) is
 * recorded there, in docs_events, and shown in the admin's Product health tab.
 */
import { track } from "@/lib/track";
import { ROLES, createdEvents, pick, sitePatchEvents, type Props, type SitePatchLike } from "@/lib/guidesEventsCore";

/** track() itself stays silent on a customer's published guide (data-docs-trackers="off"). */
function emit(name: string, props?: Props): void {
  if (typeof window === "undefined") return;
  try {
    track(name, props);
  } catch {
    /* analytics must never break the studio */
  }
}

export const guideEvents = {
  created(input: Parameters<typeof createdEvents>[0]) {
    for (const [n, p] of createdEvents(input)) emit(n, p);
  },
  siteUpdated(patch: SitePatchLike) {
    for (const [n, p] of sitePatchEvents(patch)) emit(n, p);
  },
  pageCreated: () => emit("guide_page_created"),
  pageDeleted: () => emit("guide_page_deleted"),
  pageRestored: () => emit("guide_page_restored"),
  publishRequested: (note: boolean) => emit("guide_publish_requested", { note }),
  reviewSubmitted: () => emit("guide_review_submitted"),
  reviewApproved: () => emit("guide_review_approved"),
  changesRequested: () => emit("guide_review_changes_requested"),
  reviewWithdrawn: () => emit("guide_review_withdrawn"),
  restored: () => emit("guide_restored"),
  unpublished: () => emit("guide_unpublished"),
  deleted: () => emit("guide_deleted"),
  memberRole: (scope: "workspace" | "site", role: string | null) =>
    emit("guide_member_role_changed", { scope, role: role === null ? "inherit" : pick(role, ROLES) ?? "other" }),
};

/** `.then(after(fn))`: run fn once the call succeeded, and pass the result on. */
export function after<T>(fn: (r: T) => void): (r: T) => T {
  return (r: T) => {
    fn(r);
    return r;
  };
}
