/**
 * A guide's changelog (backend routers/docs_site_changelog.py): entries, its settings (the hub's
 * title and description, products, Coming next), the media picker, and turning a page of dated
 * release notes into entries. Everyone on the guide reads; editors, reviewers and admins write.
 * Entries are drafts until the guide's next Publish, which writes the engine's changelog.json.
 */
import { docsRequest } from "@/lib/docsSites";
import { after, guideEvents } from "@/lib/guidesEvents";

export type ChangeKind = "new" | "improved" | "fixed";
export const CHANGE_KINDS: readonly ChangeKind[] = ["new", "improved", "fixed"];
/** published: readers see it as it is; changed: live, edited since; new: never published. */
export type EntryStatus = "published" | "changed" | "new";

export interface ChangelogProduct {
  id: string;
  label: string;
}

export interface ChangelogNextItem {
  title: string;
  body?: string;
  area?: string;
}

export interface ChangelogSettings {
  title: string;
  description: string;
  products: ChangelogProduct[];
  next: ChangelogNextItem[];
}

export interface EntryMedia {
  image?: string;
  video?: string;
  alt?: string;
}

export interface EntryFields {
  slug: string;
  date: string;
  title: string;
  kind: ChangeKind;
  area: string;
  products: string[];
  versions: Record<string, string>;
  summary: string;
  highlights: string[];
  media: EntryMedia;
  try: { label: string; href: string } | null;
  /** Page ids. */
  docs: string[];
  body: string;
}

export interface ChangelogEntrySummary extends Omit<EntryFields, "body"> {
  id: string;
  has_body: boolean;
  status: EntryStatus;
  rev: number;
  updated_at: string | null;
  updated_by: string | null;
  updated_by_name?: string | null;
  created_at: string | null;
}

export interface ChangelogEntry extends ChangelogEntrySummary {
  body: string;
}

export interface ChangelogOverview {
  settings: ChangelogSettings;
  /** The settings readers see are these (false: changed since the last publish). */
  settings_published: boolean;
  entries: ChangelogEntrySummary[];
  /** Published entries deleted since: readers see them until the next publish. */
  removed: Array<{ id: string; slug: string; title: string; date: string }>;
  limits: { entries: number; body_chars: number; products: number; next: number; highlights: number };
  ever_published: boolean;
}

export interface ChangelogMediaItem {
  url: string;
  name: string;
  size: number | null;
  kind: "image" | "video";
  created_at: string | null;
}

export interface ReleaseNotesCandidate {
  page_id: string;
  path: string;
  title: string;
  entries: number;
  skipped: number;
  newest: string;
  oldest: string;
  preview: Array<{ title: string; date: string; kind: ChangeKind }>;
}

export type EntryInput = Partial<Omit<EntryFields, "try">> & { try?: { label?: string; href?: string } | null };

const enc = encodeURIComponent;
const base = (siteId: string) => `/${enc(siteId)}/changelog`;

export const getChangelog = (siteId: string) => docsRequest<ChangelogOverview>(base(siteId));

export const getEntry = (siteId: string, id: string) => docsRequest<ChangelogEntry>(`${base(siteId)}/entries/${enc(id)}`);

export const createEntry = (siteId: string, input: EntryInput) =>
  docsRequest<ChangelogEntry>(`${base(siteId)}/entries`, { method: "POST", json: input })
    .then(after((e) => guideEvents.changelogEntryCreated(e.kind)));

/** A change on ``baseRev``: 409 (DocsApiError, info.rev / updated_by_name) when someone saved since. */
export const saveEntry = (siteId: string, id: string, input: EntryInput, baseRev?: number) =>
  docsRequest<ChangelogEntry>(`${base(siteId)}/entries/${enc(id)}`, { method: "PUT", json: { ...input, ...(baseRev ? { base_rev: baseRev } : {}) } });

export const deleteEntry = (siteId: string, id: string) =>
  docsRequest<{ deleted: boolean }>(`${base(siteId)}/entries/${enc(id)}`, { method: "DELETE" });

export const duplicateEntry = (siteId: string, id: string) =>
  docsRequest<ChangelogEntry>(`${base(siteId)}/entries/${enc(id)}/duplicate`, { method: "POST" });

export const saveChangelogSettings = (siteId: string, settings: ChangelogSettings) =>
  docsRequest<{ settings: ChangelogSettings; entries_changed: number }>(`${base(siteId)}/settings`, { method: "PUT", json: settings });

export const changelogMedia = (siteId: string, kind?: "image" | "video") =>
  docsRequest<{ items: ChangelogMediaItem[] }>(`${base(siteId)}/media${kind ? `?kind=${kind}` : ""}`);

export const releaseNotesCandidates = (siteId: string) =>
  docsRequest<{ pages: ReleaseNotesCandidate[] }>(`${base(siteId)}/candidates`);

export const importReleaseNotes = (siteId: string, pageId: string) =>
  docsRequest<{ created: number; skipped: number; page: { id: string; path: string; title: string }; entries: ChangelogEntrySummary[] }>(
    `${base(siteId)}/import-page`, { method: "POST", json: { page_id: pageId } },
  ).then(after((r) => guideEvents.changelogImported(r.created)));
