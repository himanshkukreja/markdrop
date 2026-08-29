/**
 * Filename → URL slug, mirroring `backend/app/utils/slug.py::slugify`.
 *
 * Used to prefill the slug box when a file is picked, so the published link
 * reads like the file rather than a random string. Keep the two in step: the
 * server re-derives a slug from the filename when the client doesn't send one.
 */

// A trailing file extension: at least one letter, so a version like "2.0" keeps
// its ".0" while "report.pdf" loses its ".pdf".
const EXT_RE = /\.[a-zA-Z][a-zA-Z0-9]{0,4}$/;

export function slugifyFilename(name: string): string {
  return (
    name
      .trim()
      .replace(EXT_RE, "")
      // Fold accents rather than dropping them: "résumé" should become
      // "resume", not "r-sum".
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/^-+|-+$/g, "")
  );
}

/** A human-facing title from a filename: extension off, separators to spaces. */
export function titleFromFilename(name: string): string {
  return name.trim().replace(EXT_RE, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}
