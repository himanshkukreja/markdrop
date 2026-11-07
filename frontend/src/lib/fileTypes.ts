/**
 * My files › filter by type (feat/files-type-filter). Pure: the URL ⇄ filter mapping, which chips
 * show, the per-type copy, and the remembered choice. The backend's table is services/file_types.py.
 * Run: node --test src/lib/fileTypes.test.mjs
 */

/** What a file is. "document" = markdown documents and pages; "html" = HTML pages and sites. */
export type FileType = "document" | "pdf" | "video" | "image" | "sheet" | "slides" | "word" | "html" | "other";

/** The chip selected. "files" is an old ?kind=artifact link (every upload), shown only while it's on. */
export type TypeFilter = "all" | FileType | "files";

export const FILE_TYPES: readonly FileType[] = ["document", "pdf", "video", "image", "sheet", "slides", "word", "html", "other"];

export interface TypeMeta {
  chip: string;
  title: string;
  /** "No {noun} match “…”" */
  noun: string;
  icon: string;
  empty: { title: string; description: string; action: string; href: string; icon: string };
}

const upload = (what: string, description: string, action: string, icon = "upload") =>
  ({ title: `No ${what} yet`, description, action, href: "/upload", icon });

export const TYPE_META: Record<TypeFilter, TypeMeta> = {
  all: { noun: "items", chip: "All", title: "My files", icon: "layers",
    empty: { title: "Publish your first document", description: "", action: "New document", href: "/new", icon: "lines" } },
  document: { noun: "documents", chip: "Documents", title: "Documents", icon: "lines",
    empty: { title: "No documents yet", description: "Markdown documents and pages you publish while signed in appear here.", action: "New document", href: "/new", icon: "lines" } },
  pdf: { noun: "PDFs", chip: "PDFs", title: "PDFs", icon: "doc",
    empty: upload("PDFs", "Upload a PDF and get a link that opens it in any browser, nothing to download.", "Upload a PDF") },
  video: { noun: "videos", chip: "Videos", title: "Videos", icon: "film",
    empty: upload("videos", "Upload a video and share a link that plays it in any browser.", "Upload a video") },
  image: { noun: "images", chip: "Images", title: "Images", icon: "image",
    empty: upload("images", "Upload a PNG, JPG, GIF, WebP or SVG and get a link that shows it.", "Upload an image") },
  sheet: { noun: "sheets", chip: "Sheets", title: "Sheets", icon: "table",
    empty: upload("sheets", "Excel and CSV files open as a grid anyone can scroll.", "Upload a sheet") },
  slides: { noun: "slide decks", chip: "Slides", title: "Slides", icon: "slides",
    empty: upload("slide decks", "PowerPoint decks open as slides in the browser, nothing to install.", "Upload a deck") },
  word: { noun: "Word documents", chip: "Word", title: "Word documents", icon: "doc",
    empty: upload("Word documents", "Word documents open as a readable page anyone can view.", "Upload a Word document") },
  html: { noun: "HTML pages or sites", chip: "HTML & sites", title: "HTML & sites", icon: "code",
    empty: upload("HTML pages or sites", "Publish an HTML page, or a zipped site, and get a link that renders it.", "Upload a page or site") },
  other: { noun: "other files", chip: "Other", title: "Other files", icon: "archive",
    empty: { title: "No other files", description: "Text, JSON and audio files you publish land here.", action: "Upload a file", href: "/upload", icon: "upload" } },
  files: { noun: "files", chip: "All files", title: "Files", icon: "layers",
    empty: { title: "No files yet", description: "Publish an HTML page, PDF, sheet, deck or video and get a link that renders it.", action: "Upload a file", href: "/upload", icon: "upload" } },
};

const isFileType = (v: string | null): v is FileType => !!v && (FILE_TYPES as readonly string[]).includes(v);

/** The filter a URL means. ?type= wins; the older ?kind=document|markdown|artifact still works. */
export function readTypeFilter(params: URLSearchParams): TypeFilter {
  const t = params.get("type");
  if (isFileType(t)) return t;
  const k = params.get("kind");
  if (k === "document" || k === "markdown") return "document";
  if (k === "artifact") return "files";
  return "all";
}

/** ?type= alone (Shared with me, Recent, folders: no older ?kind= meaning to honour). */
export function readTypeParam(params: URLSearchParams): "all" | FileType {
  const t = params.get("type");
  return isFileType(t) ? t : "all";
}

/** What the list endpoint is asked for. */
export function typeQuery(f: TypeFilter): { type?: FileType; kind?: "artifact" } {
  if (f === "all") return {};
  if (f === "files") return { kind: "artifact" };
  return { type: f };
}

/** The query-string change that selects `f` (the old ?kind= is always dropped). */
export function typeUrlPatch(f: TypeFilter): Record<string, string | null> {
  if (f === "files") return { type: null, kind: "artifact" };
  return { type: f === "all" ? null : f, kind: null };
}

/** The count a chip shows (undefined until the counts arrive). */
export function countFor(
  f: TypeFilter,
  counts: { all: number; artifact: number; byType: Partial<Record<FileType, number>> } | null,
): number | undefined {
  if (!counts) return undefined;
  if (f === "all") return counts.all;
  if (f === "files") return counts.artifact;
  return counts.byType[f] ?? 0;
}

/**
 * The chips to show, in order. All and Documents always; a file type once you have one of it (ten
 * chips for a library of three PDFs is noise); the selected one always, so an empty type still has
 * its chip (and its empty state). Before the counts arrive: All, Documents and the selected one.
 * `byType` "unknown" (an older backend that sends no per-type counts): every type.
 */
export function visibleTypeChips(
  selected: TypeFilter,
  byType: Partial<Record<FileType, number>> | null | "unknown",
): TypeFilter[] {
  const out: TypeFilter[] = ["all"];
  if (selected === "files") out.push("files");
  for (const t of FILE_TYPES) {
    if (t === "document" || t === selected || byType === "unknown" || (byType && (byType[t] ?? 0) > 0)) out.push(t);
  }
  return out;
}

/**
 * Whether a list whose own type filter isn't in use is worth a chip row at all: on Shared with me,
 * Recent and a folder, a row reading "All 6 · Documents 6" is noise. Shown once the list holds two
 * types or more, and always while a type is selected (so it can be cleared).
 */
export function typeChipsWorthShowing(
  selected: TypeFilter,
  byType: Partial<Record<FileType, number>> | null | "unknown",
): boolean {
  if (selected !== "all") return true;
  if (!byType || byType === "unknown") return false;
  return Object.values(byType).filter((n) => (n ?? 0) > 0).length >= 2;
}

/* ── Remembered per view (this device) ──────────────────────────────────── */

/** `view`: "files" (My files), "shared", "recent", or "folder:<workspace>:<folder|root>". */
export const typeRememberKey = (view = "files") => `md:${view}:type`;
export const TYPE_REMEMBER_KEY = typeRememberKey("files");

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readRememberedType(store: Store | null | undefined, view = "files"): FileType | null {
  try {
    const v = store?.getItem(typeRememberKey(view)) ?? null;
    return isFileType(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remembers a type; All (and the old "every file" link) forget it. */
export function rememberType(store: Store | null | undefined, f: TypeFilter, view = "files"): void {
  try {
    if (isFileType(f)) store?.setItem(typeRememberKey(view), f);
    else store?.removeItem(typeRememberKey(view));
  } catch {
    /* private mode, blocked storage: the filter just isn't remembered */
  }
}

/**
 * Whether opening a list at `params` should bring back the remembered type: only a bare visit (no
 * type, kind, search, page, view or preview in the link), so a shared or bookmarked link always
 * means what it says.
 */
export function shouldRestoreType(params: URLSearchParams): boolean {
  return !["type", "kind", "q", "page", "view", "preview", "filter"].some((k) => params.has(k));
}
