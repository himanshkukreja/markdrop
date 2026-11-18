/**
 * Import from Notion (backend routers/imports; .work/notion-import/CONTRACT.md). Prefix /api/v1:
 *
 *   GET  /imports/notion/destinations      where the caller can import to (My files, teams, General)
 *   POST /imports/notion                   create → {import, upload: {url, method: PUT, headers, expires_at}}
 *   (PUT the raw .zip to upload.url — XHR, for upload progress)
 *   POST /imports/notion/{id}/start        → ImportOut (queued; 409 if the object isn't there / wrong size)
 *   GET  /imports/notion/{id}              → ImportOut (poll ~1.5 s while queued/running)
 *   GET  /imports/notion                   → {imports: ImportOut[]} (the caller's last 20, newest first)
 *   POST /imports/notion/{id}/cancel       → ImportOut
 *
 * Errors are FastAPI {"detail": str}: 413 too big (2 GB), 415 not a zip, 422 bad destination, 403 not a member.
 */
import { request, WsApiError } from "@/lib/workspaces";

export const NOTION_MAX_BYTES = 2 * 1024 ** 3;

export interface NotionPlace {
  workspace_id: string;
  workspace_name: string;
  /** null + general: the workspace's General (company-wide) space. */
  team_id: string | null;
  team_name: string;
  general: boolean;
}
export interface NotionDestinations { personal: boolean; places: NotionPlace[] }

export interface NotionDestinationIn {
  /** null: My files (personal pages, no folders). */
  workspace: string | null;
  team: string | null;
  /** An existing folder id to merge into. */
  folder?: string | null;
  new_folder?: boolean;
  folder_name?: string | null;
}

export type NotionImportState = "uploading" | "queued" | "running" | "done" | "failed" | "cancelled";
export type NotionPhase = "upload" | "reading" | "pages" | "content" | "done";

export interface NotionImportCounts {
  pages: number; databases: number; rows: number; images: number; files: number;
  updated: number; unchanged: number; kept_edited: number; skipped: number; errors: number;
}
export interface NotionImport {
  id: string;
  state: NotionImportState;
  /** For a Connect Notion import ("api"): the chosen pages' titles. */
  file_name: string;
  size_bytes: number;
  /** "zip": an export file; "api": straight from Notion (Connect Notion). */
  source?: "zip" | "api";
  /** A scheduled Keep in sync run. */
  sync?: boolean;
  destination: {
    kind: "team" | "personal";
    workspace_id: string | null; workspace_name: string | null;
    team_id: string | null; team_name: string | null;
    folder_id: string | null; folder_name: string | null;
  };
  progress: { phase: NotionPhase; done: number; total: number; current: string | null };
  counts: NotionImportCounts;
  skipped: { path: string; title: string | null; reason: string }[];
  errors: { path: string; title: string | null; error: string }[];
  result: {
    folder_id: string | null; folder_url: string | null;
    /** Where to open: the folder, or the root page. */
    url: string | null;
    pages: { title: string; slug: string; url: string }[];
  } | null;
  error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}
export interface NotionUpload { url: string; method: "PUT"; headers: Record<string, string>; expires_at: string }

/** Still working on the server (keep polling). */
export const isActive = (s: NotionImportState) => s === "uploading" || s === "queued" || s === "running";

export const getNotionDestinations = () => request<NotionDestinations>("/api/v1/imports/notion/destinations");

export const createNotionImport = (body: { file_name: string; size_bytes: number; destination: NotionDestinationIn }) =>
  request<{ import: NotionImport; upload: NotionUpload }>("/api/v1/imports/notion", { method: "POST", body: JSON.stringify(body) });

export const startNotionImport = (id: string) =>
  request<NotionImport>(`/api/v1/imports/notion/${encodeURIComponent(id)}/start`, { method: "POST" });

export const getNotionImport = (id: string) => request<NotionImport>(`/api/v1/imports/notion/${encodeURIComponent(id)}`);

export const listNotionImports = () => request<{ imports: NotionImport[] }>("/api/v1/imports/notion");

export const cancelNotionImport = (id: string) =>
  request<NotionImport>(`/api/v1/imports/notion/${encodeURIComponent(id)}/cancel`, { method: "POST" });

/**
 * PUT the zip to the presigned URL with XHR (fetch can't report upload progress). `onProgress` gets 0–1.
 * Abort with `signal`; the promise then rejects with an AbortError.
 */
export function uploadNotionZip(upload: NotionUpload, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Upload cancelled", "AbortError")); return; }
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method || "PUT", upload.url, true);
    // The presigned signature binds these headers: send them exactly.
    for (const [k, v] of Object.entries(upload.headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new WsApiError(`The upload didn't go through (${xhr.status}). Try again.`, xhr.status)));
    xhr.onerror = () => reject(new WsApiError("The upload stopped. Check your connection and try again.", 0));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/**
 * The folder name an export suggests: the file name without ".zip" and without Notion's export noise
 * ("Export-<uuid>", "-Part-1", a trailing 32-hex id). Nothing meaningful left → "Notion import".
 */
export function folderNameFromFile(name: string): string {
  let s = name.replace(/\.zip$/i, "");
  s = s.replace(/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi, " ");
  s = s.replace(/\b[0-9a-f]{32}\b/gi, " ");
  s = s.replace(/\bExport\b/gi, " ").replace(/\bPart[-_ ]?\d+\b/gi, " ");
  s = s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return s && /[a-z]/i.test(s) ? s : "Notion import";
}
