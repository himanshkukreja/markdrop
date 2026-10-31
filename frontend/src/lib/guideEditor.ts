/**
 * The Guides editor's own endpoints (backend routers/docs_site_editor.py): Ask AI on a selection,
 * review comments anchored to text, and who else has the guide open.
 *
 * Ask AI sends the selection and gets back a suggestion; nothing is stored but counts (the ledger
 * row has no text). Comments are the team's words: callers keep them out of analytics
 * (ph-no-capture) and report only that one was added.
 */
import { docsRequest } from "@/lib/docsSites";
import { after, guideEvents } from "@/lib/guidesEvents";

const enc = encodeURIComponent;

// ── Ask AI ───────────────────────────────────────────────────────────────────

export type EditorAiAction = "improve" | "shorten" | "fix" | "translate";

export interface EditorAiStatus {
  available: boolean;
  /** Why it isn't: disabled | not_configured | guide_budget (the guide's monthly AI budget, shared
   * with Ask AI) | user_daily | budget (the server's spend cap) | busy. */
  reason?: string | null;
  /** A sentence saying why, when it isn't available. */
  message?: string | null;
  used_today: number;
  limit_today: number;
  /** The guide's AI uses this month (Ask AI answers and AI help together) and its budget. */
  guide_used_month: number;
  guide_limit_month: number;
  max_chars: number;
  languages: string[];
}

export function editorAiStatus(siteId: string): Promise<EditorAiStatus> {
  return docsRequest(`/${enc(siteId)}/ai/edit/status`);
}

export interface EditorAiResult {
  markdown: string;
  request_id: string;
  used_today: number;
  limit_today: number;
}

/** A rewrite of `text` (Markdown). Rejects with the server's message (limits, model trouble). */
export function editorAiEdit(siteId: string, input: { action: EditorAiAction; text: string; language?: string; page_id?: string }): Promise<EditorAiResult> {
  guideEvents.aiAssist(input.action);
  return docsRequest(`/${enc(siteId)}/ai/edit`, { method: "POST", json: input });
}

// ── Comments ─────────────────────────────────────────────────────────────────

export interface CommentReply {
  id: string;
  body: string;
  by: string;
  by_name: string | null;
  at: string;
}

export interface PageComment {
  id: string;
  page_id: string;
  /** The page's draft version when the comment was written. */
  rev: number | null;
  quote: string;
  prefix: string | null;
  suffix: string | null;
  body: string;
  by: string;
  by_name: string | null;
  at: string;
  replies: CommentReply[];
  resolved: boolean;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  can_delete: boolean;
}

const commentsPath = (siteId: string, pageId: string) => `/${enc(siteId)}/pages/${enc(pageId)}/comments`;

export function listComments(siteId: string, pageId: string): Promise<{ comments: PageComment[]; open: number }> {
  return docsRequest(commentsPath(siteId, pageId));
}

export function addComment(siteId: string, pageId: string, input: { quote: string; prefix?: string; suffix?: string; body: string }): Promise<PageComment> {
  return docsRequest<PageComment>(commentsPath(siteId, pageId), { method: "POST", json: input }).then(after(() => guideEvents.commentAdded()));
}

export function replyToComment(siteId: string, pageId: string, commentId: string, body: string): Promise<PageComment> {
  return docsRequest(`${commentsPath(siteId, pageId)}/${enc(commentId)}/replies`, { method: "POST", json: { body } });
}

export function resolveComment(siteId: string, pageId: string, commentId: string, resolved: boolean): Promise<PageComment> {
  return docsRequest(`${commentsPath(siteId, pageId)}/${enc(commentId)}/resolve`, { method: "POST", json: { resolved } });
}

export function deleteComment(siteId: string, pageId: string, commentId: string): Promise<{ deleted: true }> {
  return docsRequest(`${commentsPath(siteId, pageId)}/${enc(commentId)}`, { method: "DELETE" });
}

/** Open (unresolved) comments per page. */
export function commentsSummary(siteId: string): Promise<{ pages: Record<string, number> }> {
  return docsRequest(`/${enc(siteId)}/comments/summary`);
}

// ── Presence ─────────────────────────────────────────────────────────────────

export interface PresencePerson {
  user_id: string;
  name: string;
  page_id: string | null;
  page_title: string | null;
  page_path: string | null;
  /** Holds the edit lock on that page. */
  editing: boolean;
}

/** "I'm here" (every 30 s while the editor is open): answers with everyone else who is. */
export function beatPresence(siteId: string, session: string, pageId: string | null): Promise<{ people: PresencePerson[] }> {
  return docsRequest(`/${enc(siteId)}/presence`, { method: "POST", json: { session, page_id: pageId } });
}

export function leavePresence(siteId: string, session: string): Promise<{ ok: true }> {
  return docsRequest(`/${enc(siteId)}/presence?session=${enc(session)}`, { method: "DELETE", keepalive: true });
}
