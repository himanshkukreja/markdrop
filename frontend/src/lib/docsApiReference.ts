/**
 * A guide's API reference, generated from an OpenAPI file (backend routers/docs_site_api.py).
 *
 * Everyone on the guide reads the status; editors and admins upload, fetch, restore and remove the
 * description; the options (label, placement, Try it, re-fetch on publish) are settings, changed by
 * admins with updateSite({settings: {api: …}}). Changes reach readers at the next publish.
 */
import { DocsApiError, docsRequest, type ApiReferenceSettings } from "@/lib/docsSites";

export const API_SPEC_MAX_BYTES = 5 * 1024 * 1024;

export interface ApiSpecVersion {
  id: string;
  current: boolean;
  source: { kind: "upload" | "url" | "sample"; filename?: string | null; url?: string };
  openapi: string;
  title: string;
  version: string;
  operations: number;
  tags: number;
  servers: string[];
  warnings: string[];
  size: number;
  sha256: string;
  created_by?: string | null;
  created_by_name?: string | null;
  created_at: string;
  /** URL sources: the last fetch (at publish, with re-fetch on). */
  last_fetch: { at: string; ok: boolean; error: string | null } | null;
}

export interface ApiNavGroup {
  group: string;
  items: Array<{ method: string | null; path: string | null; title: string; page: string }>;
}

export interface ApiReferenceStatus {
  settings: ApiReferenceSettings;
  current: ApiSpecVersion | null;
  /** The sidebar the current version makes (an Overview first, then a group per tag). */
  nav: ApiNavGroup[];
  versions: ApiSpecVersion[];
  /** Where the pages live on the guide: /api-reference. */
  base: string;
  limits: { max_bytes: number; max_operations: number };
}

const enc = encodeURIComponent;

export function getApiReference(siteId: string): Promise<ApiReferenceStatus> {
  return docsRequest(`/${enc(siteId)}/api-reference`);
}

export function uploadApiSpec(siteId: string, file: File): Promise<ApiReferenceStatus> {
  if (file.size > API_SPEC_MAX_BYTES) return Promise.reject(new DocsApiError("OpenAPI files can be at most 5 MB.", 413));
  const form = new FormData();
  form.append("file", file);
  return docsRequest(`/${enc(siteId)}/api-reference/upload`, { method: "POST", body: form });
}

/** `refetch` is kept only for admins (it's a setting). */
export function fetchApiSpec(siteId: string, url: string, refetch?: boolean): Promise<ApiReferenceStatus> {
  return docsRequest(`/${enc(siteId)}/api-reference/url`, { method: "POST", json: { url, ...(refetch === undefined ? {} : { refetch }) } });
}

export function restoreApiSpec(siteId: string, versionId: string): Promise<ApiReferenceStatus> {
  return docsRequest(`/${enc(siteId)}/api-reference/versions/${enc(versionId)}/restore`, { method: "POST" });
}

export function removeApiSpec(siteId: string): Promise<ApiReferenceStatus> {
  return docsRequest(`/${enc(siteId)}/api-reference`, { method: "DELETE" });
}
