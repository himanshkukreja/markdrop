/** A page's `source` (backend services/notion_import/source.py): it was imported from Notion. Plain data
 * (no React): the page's read (app/[slug]/doc/types.ts) parses it on the server too. */
export interface NotionSource {
  kind: "notion";
  url: string | null;
  imported_at: string | null;
  sync: null | {
    state: "on" | "off" | "paused" | "edited";
    last_synced_at: string | null;
    /** Only for the person whose sync it is. */
    id?: string;
    keep_in_sync?: boolean;
  };
}

export function notionSourceOf(v: unknown): NotionSource | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<NotionSource>;
  if (s.kind !== "notion") return null;
  const url = typeof s.url === "string" && s.url.startsWith("https://") ? s.url : null;
  return { kind: "notion", url, imported_at: typeof s.imported_at === "string" ? s.imported_at : null, sync: s.sync && typeof s.sync === "object" ? s.sync : null };
}
