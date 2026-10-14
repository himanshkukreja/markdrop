/**
 * D20: the /new draft, kept in this browser's localStorage so a closed tab, a crash or a failed
 * publish doesn't lose the text.
 *
 * Plaintext only, and never while Encrypt is on: turning Encrypt on removes any stored copy, and
 * nothing is written until it's off again. Cleared when the document is published. Every storage
 * call is guarded (private windows and full quotas throw).
 */

export const DRAFT_KEY = "md_new_draft";

export interface NewDraft {
  title: string;
  content: string;
  /** ms since epoch. */
  savedAt: number;
}

export function readDraft(): NewDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<NewDraft>;
    const title = typeof d.title === "string" ? d.title : "";
    const content = typeof d.content === "string" ? d.content : "";
    if (!title.trim() && !content.trim()) return null;
    return { title, content, savedAt: typeof d.savedAt === "number" ? d.savedAt : 0 };
  } catch {
    return null;
  }
}

/** Saves, or removes the draft when both fields are empty. Returns whether a draft is now stored. */
export function writeDraft(title: string, content: string): boolean {
  try {
    if (!title.trim() && !content.trim()) {
      localStorage.removeItem(DRAFT_KEY);
      return false;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ title, content, savedAt: Date.now() } satisfies NewDraft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}
