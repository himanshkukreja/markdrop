/**
 * The studio's half of `::markdrop` blocks (the API's routers/docs_embeds.py): the picker's
 * library, link checks, "anyone with the link", version pins, uploads, and the Insights tab's
 * per-block numbers. `markdropHost` builds the editor's MarkdropFilesHost for one guide.
 */
import type { MarkdropFileInfo, MarkdropFilesHost, MarkdropLibraryPage, MarkdropLibraryType } from "@/components/docs-editor/types";
import { API_BASE, uploadArtifact } from "@/lib/api";
import { docsRequest } from "@/lib/docsSites";
import { track } from "@/lib/track";

const enc = encodeURIComponent;
const base = (siteId: string) => `/${enc(siteId)}/embeds`;

export function embedLibrary(siteId: string, p: { scope: "mine" | "workspace"; q?: string; type?: MarkdropLibraryType; page?: number }): Promise<MarkdropLibraryPage> {
  const s = new URLSearchParams({ scope: p.scope, page: String(p.page ?? 1) });
  if (p.q) s.set("q", p.q);
  if (p.type && p.type !== "all") s.set("type", p.type);
  return docsRequest<MarkdropLibraryPage>(`${base(siteId)}/library?${s}`);
}

export const embedCheck = (siteId: string, src: string) => docsRequest<MarkdropFileInfo>(`${base(siteId)}/check`, { method: "POST", json: { src } });
export const embedShare = (siteId: string, src: string) => docsRequest<MarkdropFileInfo>(`${base(siteId)}/share`, { method: "POST", json: { src } });
export const embedPin = (siteId: string, src: string, version: number) =>
  docsRequest<{ version: number; current_version: number }>(`${base(siteId)}/pins`, { method: "POST", json: { src, version } });

/** GET …/insights/embeds: per block (page + embed id). */
export interface EmbedBlockStats {
  page: string;
  embed: string;
  slug: string;
  url: string;
  title: string | null;
  renderer: string | null;
  public: boolean;
  views: number;
  interactions: number;
  interaction_rate: number | null;
  fullscreen: number;
  opens: number;
  plays: number;
  quartiles: Record<"25" | "50" | "75" | "100", number>;
  watch_s: number;
  watched_share: number | null;
  drop_off: { at: number; stopped: number; of: number } | null;
  pdf: { median_page: number | null; pages: number | null; readers: number } | null;
}
export interface EmbedStats {
  range: string;
  embeds: EmbedBlockStats[];
  totals: { views: number; interactions: number; fullscreen: number; opens: number; plays: number; watch_s: number; blocks: number; files: number };
}
export const embedStats = (siteId: string, range: string) => docsRequest<EmbedStats>(`/${enc(siteId)}/insights/embeds?range=${enc(range)}`);

const ACCEPT = ".html,.htm,.zip,.pdf,.mp4,.mov,.webm,text/html,application/zip,application/pdf,video/mp4,video/quicktime,video/webm";

/** The editor's host for one guide: previews resolve like the published guide (without analytics). */
export function markdropHost(site: { id: string; name: string; workspace_id: string | null }, workspaceName: string | null): MarkdropFilesHost {
  const api = (API_BASE || "https://api.markdrop.in").replace(/\/+$/, "");
  const appHost = typeof window !== "undefined" ? window.location.host : "markdrop.in";
  return {
    config: { api, app: typeof window !== "undefined" ? window.location.origin : "https://markdrop.in", files: null, site: site.id, guide: site.name, extraHosts: appHost === "markdrop.in" || appHost === "www.markdrop.in" ? [] : [appHost] },
    library: (p) => embedLibrary(site.id, p),
    check: (src) => embedCheck(site.id, src),
    share: (src) => embedShare(site.id, src),
    pin: (src, v) => embedPin(site.id, src, v),
    async upload(file, onProgress) {
      // Published viewable by anyone with the link (that's what a guide's readers need), filed in
      // the guide's workspace when it has one.
      const title = file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
      const made = await uploadArtifact(file, title, { accessLevel: "link", workspace: site.workspace_id, onProgress });
      return embedCheck(site.id, `https://markdrop.in/${made.slug}`);
    },
    workspaceName,
    accept: ACCEPT,
    onEvent(name, detail) {
      try {
        track(`guide_embed_${name}`, detail as Record<string, string | number | boolean> | undefined);
      } catch {
        /* never breaks the editor */
      }
    },
  };
}
