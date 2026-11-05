/**
 * A page's local draft: what this browser typed into a page that the server never confirmed
 * (components/pages/PageEditor.tsx offers it back). Tied to the account that typed it: the key
 * names the user (or "anon" for someone editing with the edit secret alone) and the draft carries
 * the same id, so a shared computer never offers one person's unsaved text to another account.
 *
 * Drafts from before they were tied to an account (`md_page_draft:<slug>`) can't be attributed to
 * anyone, so they are never offered: dropLegacyPageDraft removes them.
 *
 * A draft also keeps what it was typed on (`base`, `baseTitle`: the page at `rev` as this browser
 * had it), so offering it back after someone else changed the page merges it in (restorePageDraft)
 * instead of saving the old copy over the newer version.
 *
 * `storage` is localStorage (or any object with getItem/setItem/removeItem); every call is guarded
 * (private windows and full quotas throw). Plain JS so node --test can run it.
 */

import { merge3 } from "./pageMerge.mjs";

export const PAGE_DRAFT_PREFIX = "md_page_draft:";

/** @param {string} slug @param {string | null | undefined} userId */
export function pageDraftKey(slug, userId) {
  return `${PAGE_DRAFT_PREFIX}${userId ? `u:${userId}` : "anon"}:${slug}`;
}

/**
 * This account's draft of the page, or null (none, unreadable, or someone else's).
 * @returns {{ title: string, content: string, rev: number | null, at: number, uid: string | null, base?: string, baseTitle?: string } | null}
 */
export function readPageDraft(storage, slug, userId) {
  try {
    const raw = storage?.getItem(pageDraftKey(slug, userId));
    const d = raw ? JSON.parse(raw) : null;
    if (!d || typeof d.content !== "string") return null;
    if ((d.uid ?? null) !== (userId || null)) return null;
    const out = { title: typeof d.title === "string" ? d.title : "", content: d.content, rev: typeof d.rev === "number" ? d.rev : null, at: typeof d.at === "number" ? d.at : 0, uid: d.uid ?? null };
    if (typeof d.base === "string") Object.assign(out, { base: d.base, baseTitle: typeof d.baseTitle === "string" ? d.baseTitle : out.title });
    return out;
  } catch {
    return null;
  }
}

/** Keep this account's draft. Returns whether it was stored. */
export function writePageDraft(storage, slug, userId, draft) {
  try {
    storage?.setItem(pageDraftKey(slug, userId), JSON.stringify({
      title: draft.title ?? "", content: draft.content ?? "", rev: draft.rev ?? null, at: draft.at ?? Date.now(), uid: userId || null,
      ...(typeof draft.base === "string" ? { base: draft.base, baseTitle: draft.baseTitle ?? "" } : {}),
    }));
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

/**
 * What restoring `draft` onto the page as it is now (`current`: title, content, rev) should put in
 * the editor. Nobody changed it since (same rev): the draft. Someone did: the draft's changes merged
 * onto theirs (lib/pageMerge.mjs) — `how: "merged"`; where both changed the same lines, both are
 * kept (theirs, then the draft's) — `how: "both"`. A draft without its base (written before drafts
 * kept one) can't be merged: the draft goes under the current page as a whole (`how: "appended"`).
 * @param {{ title: string, content: string, rev: number | null, base?: string, baseTitle?: string }} draft
 * @param {{ title: string, content: string, rev: number | null }} current
 * @returns {{ title: string, content: string, how: "draft" | "merged" | "both" | "appended" }}
 */
export function restorePageDraft(draft, current) {
  if (draft.rev !== null && draft.rev === current.rev) return { title: draft.title, content: draft.content, how: "draft" };
  if (typeof draft.base !== "string") {
    if (current.content === draft.content) return { title: draft.title || current.title, content: current.content, how: "draft" };
    return { title: current.title, content: merge3("", draft.content, current.content).bothContent, how: "appended" };
  }
  const m = merge3(draft.base, draft.content, current.content);
  const baseTitle = draft.baseTitle ?? current.title;
  const title = draft.title !== baseTitle ? draft.title : current.title;
  return m.clean ? { title, content: m.content, how: "merged" } : { title, content: m.bothContent, how: "both" };
}
