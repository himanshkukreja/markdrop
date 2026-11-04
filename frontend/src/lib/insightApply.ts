/**
 * "Apply in page" (Analytics › Content › ✦ Insights): hands a rewrite from the analytics page to
 * the page's editor in the same tab. The analytics page stores it here and opens `/<slug>?apply=insight`;
 * the editor (components/pages/PageEditor) takes it once and offers it as a suggestion over that
 * section (DocsEditorApi.suggest: Accept / Discard; nothing changes until Accept).
 *
 * sessionStorage, so it stays in this tab and is gone when the tab closes; it is taken (removed)
 * on the first read, and ignored after 10 minutes.
 */
export interface InsightRewrite {
  slug: string;
  heading: string;
  level: number;
  markdown: string;
  title: string;
  at: number;
}

const KEY = (slug: string) => `md:insight-apply:${slug}`;
const MAX_AGE_MS = 10 * 60 * 1000;
export const APPLY_PARAM = "apply";
export const APPLY_VALUE = "insight";

export function storeRewrite(r: Omit<InsightRewrite, "at">): boolean {
  try {
    sessionStorage.setItem(KEY(r.slug), JSON.stringify({ ...r, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function takeRewrite(slug: string): InsightRewrite | null {
  try {
    const raw = sessionStorage.getItem(KEY(slug));
    sessionStorage.removeItem(KEY(slug));
    if (!raw) return null;
    const r = JSON.parse(raw) as InsightRewrite;
    if (r.slug !== slug || typeof r.markdown !== "string" || typeof r.heading !== "string") return null;
    if (Date.now() - (r.at || 0) > MAX_AGE_MS) return null;
    return r;
  } catch {
    return null;
  }
}

export const applyHref = (slug: string) => `/${encodeURIComponent(slug)}?${APPLY_PARAM}=${APPLY_VALUE}`;
