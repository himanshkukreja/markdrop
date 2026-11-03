/**
 * A page's local draft: what this browser typed into a page that the server never confirmed
 * (components/pages/PageEditor.tsx offers it back). Tied to the account that typed it: the key
 * names the user (or "anon" for someone editing with the edit secret alone) and the draft carries
 * the same id, so a shared computer never offers one person's unsaved text to another account.
 *
 * Drafts from before they were tied to an account (`md_page_draft:<slug>`) can't be attributed to
 * anyone, so they are never offered: dropLegacyPageDraft removes them.
 *
 * `storage` is localStorage (or any object with getItem/setItem/removeItem); every call is guarded
 * (private windows and full quotas throw). Plain JS so node --test can run it.
 */

export const PAGE_DRAFT_PREFIX = "md_page_draft:";

/** @param {string} slug @param {string | null | undefined} userId */
export function pageDraftKey(slug, userId) {
  return `${PAGE_DRAFT_PREFIX}${userId ? `u:${userId}` : "anon"}:${slug}`;
}

/**
 * This account's draft of the page, or null (none, unreadable, or someone else's).
 * @returns {{ title: string, content: string, rev: number | null, at: number, uid: string | null } | null}
 */
export function readPageDraft(storage, slug, userId) {
  try {
    const raw = storage?.getItem(pageDraftKey(slug, userId));
    const d = raw ? JSON.parse(raw) : null;
    if (!d || typeof d.content !== "string") return null;
    if ((d.uid ?? null) !== (userId || null)) return null;
    return { title: typeof d.title === "string" ? d.title : "", content: d.content, rev: typeof d.rev === "number" ? d.rev : null, at: typeof d.at === "number" ? d.at : 0, uid: d.uid ?? null };
  } catch {
    return null;
  }
}

/** Keep this account's draft. Returns whether it was stored. */
export function writePageDraft(storage, slug, userId, draft) {
  try {
    storage?.setItem(pageDraftKey(slug, userId), JSON.stringify({ title: draft.title ?? "", content: draft.content ?? "", rev: draft.rev ?? null, at: draft.at ?? Date.now(), uid: userId || null }));
    return true;
  } catch {
    return false;
  }
}

export function clearPageDraft(storage, slug, userId) {
  try {
    storage?.removeItem(pageDraftKey(slug, userId));
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

/** Remove a draft written before drafts were tied to an account (whose it is can't be known). */
export function dropLegacyPageDraft(storage, slug) {
  try {
    storage?.removeItem(`${PAGE_DRAFT_PREFIX}${slug}`);
  } catch {
    /* ignore */
  }
}
