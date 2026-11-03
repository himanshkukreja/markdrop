"use client";

/**
 * "Duplicate": a copy of a page beside it, like Notion's: the same Markdown and page properties
 * (front matter), titled "<title> (1)" (then (2), …), in the same parent, workspace and folder,
 * with its sub-pages copied too. A sub-page that has its own access is left out (its copy would
 * inherit the copy's access, which can be wider), and the toast says how many were left out.
 *
 * Page images belong to the page they were uploaded to, so each one (`asset:<id>` in the
 * Markdown, the icon and the cover) is fetched from this reader's link and uploaded to the copy,
 * and the copy's Markdown is rewritten to the new ids. The copy is created first with the
 * original Markdown (nothing typed is ever lost), then saved once with the new ids and with its
 * sub-page links (`::page{src=…}`) pointing at the copied sub-pages. An image that can't be
 * fetched stays as it was (it shows as missing in the copy) and the toast names it.
 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, Progress, useToast } from "@/components/ui";
import { createPage, getPage, listChildren, refreshAssetUrls, savePage, uploadPageAsset, type AssetUrl } from "@/lib/pages";
import { assetIdsIn, copyTitle, imageName, rewriteAssets, rewritePageLinks } from "@/lib/pageTree.mjs";
import { workspaceChanged } from "@/lib/workspaceStore";
import { rememberSecret } from "./TemplateGallery";
import "./pageTree.css";

/** At most this many pages in one duplicate (the top page and every sub-page below it). */
const MAX_PAGES = 50;

export interface DuplicateSource {
  slug: string;
  title: string | null;
}

export interface Duplicated {
  slug: string;
  title: string;
  /** Images that couldn't be copied, in words ("“Team photo”", "the cover"). */
  missing: string[];
  /** Sub-pages left out because they have their own access (their titles). */
  ownAccess: string[];
  /** Sub-pages left out because the copy reached MAX_PAGES, or whose copy failed. */
  overLimit: number;
  failed: number;
  /** Pages created, the top one included. */
  pages: number;
}

interface Step {
  text: string;
  value?: number;
  max?: number;
}

/** What an image is called in the page: its alt text, or "the icon" / "the cover". */
function describe(md: string, id: string): string {
  const esc = id.replace(/[-]/g, "\\-");
  const alt = new RegExp(`!\\[([^\\]]*)\\]\\(asset\\\\?:${esc}(?![A-Za-z0-9_-])`).exec(md)?.[1]?.trim();
  if (alt) return `“${alt}”`;
  if (new RegExp(`^icon:\\s*["']?asset:${esc}`, "m").test(md)) return "the icon";
  if (new RegExp(`^cover:\\s*["']?asset:${esc}`, "m").test(md)) return "the cover";
  return "an image";
}

async function copyImage(url: string, id: string, toSlug: string): Promise<string> {
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  const file = new File([blob], imageName(id, blob.type), { type: blob.type || "image/png" });
  const up = await uploadPageAsset(toSlug, file);
  return up.id;
}

/** The page's image links: `assets`, plus the icon and cover (sent separately as `page.icon_url` / `cover_url`). */
function linksOf(doc: { assets?: Record<string, AssetUrl> | null; page?: Record<string, unknown> | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, a] of Object.entries(doc.assets ?? {})) if (a?.url) out[id] = a.url;
  const p = doc.page ?? {};
  for (const [key, url] of [["icon", "icon_url"], ["cover", "cover_url"]] as const) {
    const id = /^asset:([A-Za-z0-9_-]+)$/.exec(String(p[key] ?? ""))?.[1];
    if (id && typeof p[url] === "string" && !out[id]) out[id] = p[url] as string;
  }
  return out;
}

export async function duplicatePage(src: DuplicateSource, onStep: (s: Step) => void): Promise<Duplicated> {
  const budget = { pages: 0, ownAccess: [] as string[], overLimit: 0, failed: 0 };
  const missing: string[] = [];

  async function one(slug: string, place: { parent?: string | null; workspace?: string | null; folder?: string | null; after?: string | null }, top: boolean): Promise<{ slug: string; title: string }> {
    const doc = await getPage(slug);
    const content = doc.content ?? "";
    let title = doc.title?.trim() || "Untitled";
    if (top) {
      const taken = place.parent ? (await listChildren(place.parent).catch(() => [])).map((k) => k.title) : [];
      title = copyTitle(title, taken);
    }
    onStep({ text: top ? "Creating the copy…" : `Copying sub-pages… ${budget.pages} copied` });
    const created = await createPage({ title, content: content.trim() ? content : null, ...place });
    rememberSecret(created);
    budget.pages++;
    const newSlug = created.document.slug;

    // Sub-pages, in their order, under the copy.
    const pageMap: Record<string, string> = {};
    if ((doc.children_count ?? 0) > 0) {
      const kids = await listChildren(slug).catch(() => []);
      for (const k of kids) {
        if (k.access_inherit === false) {
          budget.ownAccess.push(k.title?.trim() || "Untitled");
          continue;
        }
        if (budget.pages >= MAX_PAGES) {
          budget.overLimit++;
          continue;
        }
        try {
          const c = await one(k.slug, { parent: newSlug }, false);
          pageMap[k.slug] = c.slug;
        } catch {
          budget.failed++;
        }
      }
    }

    // Images: fetched with this reader's links, uploaded to the copy.
    const ids = assetIdsIn(content);
    const assetMap: Record<string, string> = {};
    if (ids.length) {
      let links = linksOf(doc);
      if (ids.some((id) => !links[id])) {
        const fresh = await refreshAssetUrls(slug).catch(() => null);
        if (fresh) links = { ...links, ...Object.fromEntries(Object.entries(fresh.assets ?? {}).map(([k, v]) => [k, v.url])) };
      }
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        onStep({ text: `Copying images… ${i + 1} of ${ids.length}`, value: i, max: ids.length });
        const url = links[id];
        try {
          if (!url) throw new Error("no link");
          assetMap[id] = await copyImage(url, id, newSlug);
        } catch {
          missing.push(describe(content, id));
        }
      }
      onStep({ text: `Copying images… ${ids.length} of ${ids.length}`, value: ids.length, max: ids.length });
    }

    const next = rewritePageLinks(rewriteAssets(content, assetMap), pageMap);
    if (next !== content) {
      onStep({ text: "Saving the copy…" });
      await savePage(newSlug, { title, content: next, baseRev: created.document.rev ?? null }, created.edit_secret ?? null);
    }
    return { slug: newSlug, title };
  }

  // Beside the original: the same parent, else the same workspace and folder.
  const doc = await getPage(src.slug);
  const parent = doc.parent?.slug ?? null;
  const folders = (doc.folder_path ?? []).slice(0, Math.max(0, (doc.folder_path ?? []).length - (doc.page_path?.length ?? 0)));
  const place = parent
    ? { parent, after: src.slug }
    : { workspace: doc.workspace_id ?? null, folder: doc.workspace_id && folders.length ? folders.join("/") : null, after: src.slug };
  const top = await one(src.slug, place, true);
  if (doc.workspace_id) workspaceChanged(doc.workspace_id);
  return { ...top, missing, ownAccess: budget.ownAccess, overLimit: budget.overLimit, failed: budget.failed, pages: budget.pages };
}

/** Duplicate with a progress dialog; then open the copy (in the editor), or just say so. */
export function useDuplicatePage() {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<{ title: string; step: Step } | null>(null);

  const run = useCallback(
    async (src: DuplicateSource, opts: { open?: boolean; onDone?: (d: Duplicated) => void } = {}): Promise<Duplicated | null> => {
      const name = src.title?.trim() || "Untitled";
      setBusy({ title: name, step: { text: "Reading the page…" } });
      try {
        const d = await duplicatePage(src, (step) => setBusy({ title: name, step }));
        const subs = d.pages - 1;
        toast.success(`Duplicated as “${d.title}”${subs > 0 ? `, with ${subs === 1 ? "1 sub-page" : `${subs} sub-pages`}` : ""}.`, {
          action: opts.open ? undefined : { label: "Open", onClick: () => router.push(`/${encodeURIComponent(d.slug)}`) },
        });
        if (d.missing.length) {
          const list = d.missing.slice(0, 3).join(", ") + (d.missing.length > 3 ? ` and ${d.missing.length - 3} more` : "");
          toast.error(`${d.missing.length === 1 ? "1 image" : `${d.missing.length} images`} couldn't be copied (${list}). The copy shows ${d.missing.length === 1 ? "it" : "them"} as missing; upload ${d.missing.length === 1 ? "it" : "them"} again there.`, { duration: 12000 });
        }
        const notes: string[] = [];
        const quoted = (names: string[]) => names.slice(0, 3).map((n) => `“${n}”`).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
        if (d.ownAccess.length === 1) notes.push(`${quoted(d.ownAccess)} wasn't copied: it has its own access, and its copy would follow the copy's.`);
        else if (d.ownAccess.length) notes.push(`${d.ownAccess.length} sub-pages weren't copied (${quoted(d.ownAccess)}): they have their own access, and their copies would follow the copy's.`);
        if (d.overLimit) notes.push(`The copy stops at ${MAX_PAGES} pages, so ${d.overLimit === 1 ? "1 sub-page wasn't" : `${d.overLimit} sub-pages weren't`} copied.`);
        if (d.failed) notes.push(`${d.failed === 1 ? "1 sub-page" : `${d.failed} sub-pages`} couldn't be copied.`);
        if (notes.length) toast.info(notes.join(" "), { duration: 10000 });
        opts.onDone?.(d);
        if (opts.open) router.push(`/${encodeURIComponent(d.slug)}?edit=1`);
        return d;
      } catch (e) {
        toast.error(e instanceof Error && e.message && !/^Request failed/.test(e.message) ? e.message : "Couldn't duplicate the page. Try again.");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [toast, router],
  );

  const dialog = (
    <Dialog open={!!busy} onClose={() => {}} dismissible={false} hideClose size="sm" title={<>Duplicating “<span className="ph-sensitive ph-mask">{busy?.title}</span>”</>}>
      <div className="pt-dup" role="status" aria-live="polite">
        <p className="pt-dup__step">{busy?.step.text}</p>
        <Progress
          label="Progress"
          value={busy?.step.value ?? 0}
          max={busy?.step.max ?? 1}
          indeterminate={busy?.step.max === undefined}
          valueText={busy?.step.text}
          size="sm"
        />
      </div>
    </Dialog>
  );
  return { duplicate: run, dialog, busy: !!busy };
}
