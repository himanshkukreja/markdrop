/**
 * A bookmark: the link's title, description and image, as kept in the page's Markdown (readers never
 * fetch anything from the site). Shared by the editor's node view and the reading view, so it imports
 * nothing from the editor: a reader's page loads it without Tiptap or ProseMirror.
 */
import { Icon } from "@/components/ui";

export function BookmarkCard({ a }: { a: Record<string, string | undefined> }) {
  let host = "";
  try {
    host = new URL(a.url ?? "").host;
  } catch {
    /* not a URL */
  }
  const safe = /^https?:\/\//.test(a.url ?? "") ? a.url : undefined;
  const img = /^https:\/\//.test(a.image ?? "") ? a.image : undefined;
  return (
    <a className="pb-bookmark not-prose" href={safe} target="_blank" rel="noopener noreferrer nofollow">
      <span className="pb-bookmark__text">
        <strong className="pb-bookmark__title">{a.title || host || a.url}</strong>
        {a.description && <span className="pb-bookmark__desc">{a.description}</span>}
        <span className="pb-bookmark__url">
          <Icon name="link" size={12} aria-hidden /> {a.site || host}
        </span>
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {img && <img className="pb-bookmark__img" src={img} alt="" loading="lazy" referrerPolicy="no-referrer" />}
    </a>
  );
}
