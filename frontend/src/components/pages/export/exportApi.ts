/**
 * Export a page: `GET /api/v1/documents/{slug}/export?format=md|html|zip&subpages=1` (the server
 * checks who may export and what goes in), saved with a download; and Markdown an encrypted
 * document's own browser saves (the server can't read it).
 */
import { API_BASE, getToken } from "@/lib/api";

export type ExportKind = "md" | "html" | "zip";

/** A name every OS accepts, from a page's title (the server names its files the same way). */
export function exportFileName(title: string | null | undefined, ext: "md" | "html" | "zip"): string {
  let t = String(title ?? "").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^[ .]+|[ .]+$/g, "");
  if (!t) t = "page";
  return `${t.slice(0, 80).replace(/[ .]+$/, "") || "page"}.${ext}`;
}

export class ExportFailed extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ExportFailed";
    this.status = status;
    this.code = code;
  }
}

function readPassword(slug: string): string | null {
  try {
    return sessionStorage.getItem(`pwd:${slug}`);
  } catch {
    return null;
  }
}

/** Fetches the export; `onProgress(received, total|null)` as it arrives. */
export async function fetchExport(
  slug: string,
  opts: { kind: ExportKind; subpages: boolean; secret?: string | null; signal?: AbortSignal; onProgress?: (received: number, total: number | null) => void },
): Promise<Blob> {
  const q = new URLSearchParams({ format: opts.kind, subpages: opts.subpages ? "true" : "false" });
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.secret) headers["X-Edit-Secret"] = opts.secret;
  const pw = readPassword(slug);
  if (pw) headers["X-Read-Password"] = pw;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/v1/documents/${encodeURIComponent(slug)}/export?${q}`, { headers, cache: "no-store", signal: opts.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ExportFailed("Couldn't reach Markdrop. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: unknown; code?: string } | null;
    const detail = typeof body?.detail === "string" ? body.detail : res.status === 429 ? "Too many exports at once. Wait a minute and try again." : `The export didn't work (${res.status}). Try again.`;
    throw new ExportFailed(detail, res.status, body?.code ?? null);
  }
  const total = Number(res.headers.get("content-length")) || null;
  if (!res.body || !opts.onProgress) return res.blob();
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    opts.onProgress(received, total);
  }
  return new Blob(chunks, { type: res.headers.get("content-type") ?? "application/octet-stream" });
}

/** Hands a blob to the browser as a download. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** An encrypted document's Markdown, decrypted here, saved here: it never goes back to the server. */
export function downloadMarkdown(title: string | null | undefined, markdown: string): void {
  saveBlob(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), exportFileName(title, "md"));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Does the page carry images of its own (`asset:` images, icon or cover)? */
export function hasPageImages(markdown: string): boolean {
  return /!\[[^\]\n]*\]\(\s*<?asset\\?:/.test(markdown) || /^(icon|cover):\s*asset:/m.test(markdown.slice(0, 2000));
}
