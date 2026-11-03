/**
 * Markdrop Guides' product events, through lib/track (first-party, mirrored to PostHog and GA by
 * its privacy layer). lib/docsSites fires them once the API has accepted the change, so every screen
 * that makes the change reports it the same way, and a refused call reports nothing.
 *
 * Props are enums, counts and booleans only: never a site, page or person id, a title or name, an
 * address or domain, a URL (an import's source included), CSS, a note or an email.
 *
 *   guide_created                 source: blank|template|import|github, template?: product|api|helpcenter, workspace
 *   guide_import_started          source: gitbook | github (+ sync, mode for github)
 *   guide_page_created / guide_page_deleted / guide_page_restored
 *   guide_publish_requested       note (a publish note was written)
 *   guide_review_submitted / guide_review_approved / guide_review_changes_requested / guide_review_withdrawn
 *   guide_restored                (an earlier publish put live again)
 *   guide_design_saved            preset, mode, brand, css (custom CSS present, never its text)
 *   guide_design_reset            source: import|created (the design back to the one the guide started with)
 *   guide_renamed / guide_address_changed
 *   guide_ask_ai_toggled          enabled
 *   guide_ask_ai_renamed / guide_ask_ai_questions (n)
 *   guide_access_changed          access: public|password|members
 *   guide_indexing_changed        enabled
 *   guide_reviews_required        enabled
 *   guide_redirects_saved         n
 *   guide_member_role_changed     scope: workspace|site, role (admin|reviewer|editor|viewer|none|inherit)
 *   guide_unpublished / guide_deleted
 *   guide_domain_added / guide_domain_removed
 *   guide_domain_live             (seen going live on this screen; the server logs docs_domain_live too)
 *   guide_insights_write_page     source: search|ask|both (Insights › "Write a page" for something readers couldn't find)
 *   guide_feedback_resolved / guide_feedback_reopened
 *   guide_insights_cleared        (an admin deleted the collected data)
 *   guide_publish_started         from: site_bar|publish_screen|design_banner (where Publish was pressed)
 *   guide_compare_viewed          from: publish|none, to: publish|drafts
 *   guide_compare_view_changed    view: text|split
 *   guide_live_opened             from: site_bar|publish|toast|compare|banner (the live guide in a new tab)
 *   guide_address_copied          own (an own domain, else the free address)
 *   guide_share_copied
 *   guide_setup_step_opened       step: pages|look|publish|domain|team|insights|changelog
 *   guide_domain_one_click        (the provider's Domain Connect page opened)
 *   guide_domain_handoff          how: copy|email|link|csv (the DNS steps sent on to someone)
 *   guide_api_sample_used         (an API reference started from the sample file)
 *   guide_ai_assist               action: improve|shorten|fix|translate (the editor's Ask AI on a selection)
 *   guide_find_replace            (the editor's Find and replace opened)
 *   guide_comment_added           (a review comment on a page; replies aren't counted)
 *   guide_check_fixed             kind: link_missing|image_alt|heading_empty (a page check's Fix)
 *   guide_changelog_entry_created kind: new|improved|fixed (a changelog entry written)
 *   guide_changelog_imported      n (a page of release notes turned into n changelog entries)
 *   guide_fixes_checked           (the Fix list re-checked now)
 *   guide_fix_status              type: drop|search|ask|not_helpful|video|pdf|broken|stale|heavy|agent_unanswered|agent_unfriendly, status: open|in_progress|fixed|dismissed
 *   guide_fix_drafted             type (an AI-drafted fix)
 *   guide_fix_applied             type, how: editor|new_page (a drafted fix put in a page)
 *   guide_fix_demo_viewed         (the Fix list's sample, before a guide has readers)
 *
 * The Markdrop Guides landing page (markdrop.in/guides, components/guides-landing), for
 * the landing test: which pillar people click for.
 *   guide_landing_viewed          (the landing page shown; the denominator)
 *   guide_landing_cta             id: start|open|tour|pillar|docs|compare|pricing (open: "Open your guides",
 *                                 signed in), section: the <section> id,
 *                                 pillar?: fix_list|private_pages|live_demos (a pillar card's own button)
 *   guide_landing_demo            step: item|drafted|published (the hero's live demo: its Rank,
 *                                 Draft and Fix steps chosen)
 *   guide_created                 + pillar, when the guide came from a pillar button in this tab
 *
 * What finishes on the server (a build going live or failing, an import finishing or failing) is
 * recorded there, in docs_events, and shown in the admin's Product health tab.
 */
import { track } from "@/lib/track";
import { ROLES, createdEvents, pick, sitePatchEvents, type Props, type SitePatchLike } from "@/lib/guidesEventsCore";

const FIX_TYPES = new Set(["drop", "search", "ask", "not_helpful", "video", "pdf", "broken", "stale", "heavy", "agent_unanswered", "agent_unfriendly"]);
const fixType = (t: string) => pick(t, FIX_TYPES) ?? "other";

/** The landing page's pillar buttons, and the guide that follows one (sessionStorage: this tab only). */
const PILLARS = new Set(["fix_list", "private_pages", "live_demos"]);
const LANDING_CTAS = new Set(["start", "open", "tour", "pillar", "docs", "compare", "pricing"]);
const PILLAR_KEY = "md_guides_pillar";
function rememberLandingPillar(p: string) {
  try {
    sessionStorage.setItem(PILLAR_KEY, p);
  } catch { /* storage off */ }
}
function takeLandingPillar(): string | undefined {
  try {
    const p = sessionStorage.getItem(PILLAR_KEY);
    sessionStorage.removeItem(PILLAR_KEY);
    return p && PILLARS.has(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

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
    const pillar = takeLandingPillar();
    for (const [n, p] of createdEvents(input)) emit(n, pillar && n === "guide_created" ? { ...p, pillar } : p);
  },
  landingViewed: () => emit("guide_landing_viewed"),
  landingCta(id: string, section: string, pillar?: string | null) {
    const p = pillar ? pick(pillar, PILLARS) : undefined;
    if (p) rememberLandingPillar(p);
    emit("guide_landing_cta", { id: pick(id, LANDING_CTAS) ?? "other", section: section.slice(0, 40), ...(p ? { pillar: p } : {}) });
  },
  landingDemo: (step: "item" | "drafted" | "published") => emit("guide_landing_demo", { step }),
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
  designReset: (source: "import" | "created") => emit("guide_design_reset", { source }),
  unpublished: () => emit("guide_unpublished"),
  deleted: () => emit("guide_deleted"),
  domainAdded: () => emit("guide_domain_added"),
  domainRemoved: () => emit("guide_domain_removed"),
  domainLive: () => emit("guide_domain_live"),
  insightsWritePage: (source: "search" | "ask" | "both") => emit("guide_insights_write_page", { source }),
  feedbackResolved: (resolved: boolean) => emit(resolved ? "guide_feedback_resolved" : "guide_feedback_reopened"),
  insightsCleared: () => emit("guide_insights_cleared"),
  publishStarted: (from: "site_bar" | "publish_screen" | "design_banner") => emit("guide_publish_started", { from }),
  compareViewed: (from: "publish" | "none", to: "publish" | "drafts") => emit("guide_compare_viewed", { from, to }),
  compareView: (view: "text" | "split") => emit("guide_compare_view_changed", { view }),
  liveOpened: (from: "site_bar" | "publish" | "toast" | "compare" | "banner") => emit("guide_live_opened", { from }),
  addressCopied: (own: boolean) => emit("guide_address_copied", { own }),
  shareCopied: () => emit("guide_share_copied"),
  setupStep: (step: "pages" | "look" | "publish" | "domain" | "team" | "insights" | "changelog") => emit("guide_setup_step_opened", { step }),
  changelogEntryCreated: (kind: "new" | "improved" | "fixed") => emit("guide_changelog_entry_created", { kind }),
  changelogImported: (n: number) => emit("guide_changelog_imported", { n }),
  domainOneClick: () => emit("guide_domain_one_click"),
  domainHandoff: (how: "copy" | "email" | "link" | "csv") => emit("guide_domain_handoff", { how }),
  apiSampleUsed: () => emit("guide_api_sample_used"),
  aiAssist: (action: "improve" | "shorten" | "fix" | "translate" | "tone" | "checklist" | "table" | "explain" | "write" | "action_items" | "summary" | "meta") => emit("guide_ai_assist", { action }),
  findReplace: () => emit("guide_find_replace"),
  commentAdded: () => emit("guide_comment_added"),
  checkFixed: (kind: "link_missing" | "image_alt" | "heading_empty") => emit("guide_check_fixed", { kind }),
  fixesChecked: () => emit("guide_fixes_checked"),
  fixStatus: (type: string, status: "open" | "in_progress" | "fixed" | "dismissed") => emit("guide_fix_status", { type: fixType(type), status }),
  fixDrafted: (type: string) => emit("guide_fix_drafted", { type: fixType(type) }),
  fixApplied: (type: string, how: "editor" | "new_page") => emit("guide_fix_applied", { type: fixType(type), how }),
  fixDemo: () => emit("guide_fix_demo_viewed"),
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
