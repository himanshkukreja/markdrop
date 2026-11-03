/** A page image's id and a page's address (re-exported by pageBlocks.mjs). */

/** `asset:<id>` → id (null for any other address). */
export function assetId(src) {
  if (typeof src !== "string") return null;
  const m = /^asset:([A-Za-z0-9_-]{1,128})$/.exec(src.trim());
  return m ? m[1] : null;
}

/**
 * A page's address. On markdrop.in it is `/<slug>`; on a workspace's own domain a page lives under
 * its folders and its ancestors: `/<folders…>/<parent-slug>/<child-slug>`.
 */
export function pagePath(slug, { tenant = false, folderPath = [], ancestors = [] } = {}) {
  const segs = tenant ? [...folderPath, ...ancestors, slug] : [slug];
  return `/${segs.filter(Boolean).map(encodeURIComponent).join("/")}`;
}
