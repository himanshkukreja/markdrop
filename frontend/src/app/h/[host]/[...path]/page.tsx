import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { ogImageUrl, type DocumentResponse } from "@/lib/api";
import ArtifactView from "@/app/[slug]/ArtifactView";
import DocumentView from "@/app/[slug]/DocumentView";
import { signInUrlFor } from "@/lib/hosts";
import { assertTenantHost, tenantHostOf } from "@/components/tenant/assertHost";
import {
  FOLDER_SIGNIN,
  fetchTenantDocument,
  fetchTenantFolder,
  fetchTenantFolderQuietly,
  resolveTenantHost,
  resolveTenantHostQuietly,
  type TenantDocResult,
} from "@/components/tenant/server";
import { TenantFolderPage } from "@/components/tenant/TenantFolderPage";
import { TenantLoading } from "@/components/tenant/TenantLoading";

/**
 * A document — or a folder — as served on a workspace's own domain.
 *
 * Reached only by rewrite from middleware, never linked: `/h/<host>/<path>` is
 * what `docs.acme.com/<path>` becomes, and the host is checked against the
 * request's own Host header (`assertTenantHost`), never trusted from the path.
 *
 * A catch-all rather than a single segment, because folders are part of the
 * address here: a document filed under Data/Reports answers at
 * `/data/reports/<slug>`. The last segment is always the slug — it is the
 * document's identity and is globally unique — and the segments before it must
 * match the folder path the document is actually filed under.
 *
 * A mismatch redirects (307) to the canonical path rather than 404-ing. Filing
 * a document changes its address, and links to the old one are already out in
 * the world. So the slug remains the identity and always resolves; the folder
 * path is how the document is *addressed*, and any other spelling of it is a
 * redirect to the real one.
 *
 * A path whose last segment is not a document may be a folder: it renders the
 * folder index when the API lists that folder (`GET /api/v1/host/folder`, only
 * what the reader may open; a signed-in reader's browser re-asks with their
 * token), and is a 404 otherwise (in tenant chrome, via `../not-found.tsx`).
 *
 * A failure to *ask* the API (network, 429, 5xx) throws, and the route's
 * error boundary shows a retryable error — it is never reported as "Nothing at
 * this address" for a document that exists.
 */

interface Props {
  params: Promise<{ host: string; path: string[] }>;
}

/** Custom hosts are per-tenant and low volume, so they render on demand. */
export const dynamic = "force-dynamic";

/** Split a tenant URL into its folder path and the document slug. */
function splitPath(path: string[]): { folders: string[]; slug: string } {
  const segments = (path || []).filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { folders: segments.slice(0, -1), slug: segments[segments.length - 1] || "" };
}

/** Does this document actually live where the URL says it does? */
function pathMatches(doc: { folder_path?: string[] } | null, folders: string[]): boolean {
  const actual = doc?.folder_path ?? [];
  return actual.length === folders.length && actual.every((seg, i) => seg === folders[i]);
}

/**
 * A raw-bytes URL anyone may fetch: the Worker's `/r/` URL of a public object (no `?t=` token).
 * Only link-level documents have one; a guarded document's URL is signed and expires, and must
 * never be advertised in a card.
 */
function publicRawUrl(doc: DocumentResponse): string | null {
  const u = doc.download_url;
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.searchParams.has("t") || !parsed.pathname.startsWith("/r/")) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host: param, path } = await params;
  const host = await tenantHostOf(param);
  if (!host) return {};
  const { folders, slug } = splitPath(path);
  // Applies the kind check itself (null for cdn hosts): this runs independently of the page
  // component, and must not describe a document the page is about to refuse to serve.
  const resolved = await resolveTenantHostQuietly(host);
  // Unbranded fallback rather than leaking "Markdrop" onto a host that has
  // explicitly asked not to show it.
  const siteName = resolved?.site_name || (resolved?.hide_markdrop_branding ? "" : host);

  let pageTitle = slug;
  let description = siteName ? `A document on ${siteName}` : "Shared document";
  let isFolder = false;
  let video: { url: string; type: string } | null = null;
  // The readable document behind the card (its access epoch goes on the image URL).
  let ogDoc: DocumentResponse | null = null;
  if (resolved) {
    let result: TenantDocResult | null = null;
    try {
      result = await fetchTenantDocument(slug, resolved.workspace_id, folders);
    } catch {
      result = null; // transient: generic card; the page shows the error
    }
    if (result?.status === "ok") {
      const doc = result.doc;
      ogDoc = doc;
      if (!doc.encrypted) {
        pageTitle = doc.title || doc.original_filename || slug;
        const preview = doc.kind === "artifact" ? "" : (doc.content || "").slice(0, 150).replace(/[#*_`]/g, "");
        if (preview) description = preview;
      }
      // og:video only for link-level videos: their raw URL is public and permanent.
      const raw = doc.kind === "artifact" && doc.renderer === "video" ? publicRawUrl(doc) : null;
      if (raw) video = { url: raw, type: doc.mime || "video/mp4" };
    } else if (result?.status === "missing") {
      // Maybe a folder, which is named by its display name and has no OG card.
      const listing = await fetchTenantFolderQuietly(host, [...folders, slug], resolved.workspace_id);
      if (listing?.folder) {
        isFolder = true;
        pageTitle = listing.folder.name;
        description = siteName ? `Documents in ${listing.folder.name} on ${siteName}` : `Documents in ${listing.folder.name}`;
      }
    }
  }

  // Named with the host this card was unfurled from, not the workspace's
  // default one. The server validates the host against that workspace's live
  // domains before drawing it. A link-level video's card carries its poster.
  const ogImage = ogImageUrl(slug, ogDoc, host);
  const title = siteName ? `${pageTitle} — ${siteName}` : pageTitle;
  const url = `https://${host}/${[...folders, slug].map(encodeURIComponent).join("/")}`;
  return {
    title,
    description,
    icons: resolved?.favicon_url ? [{ rel: "icon", url: resolved.favicon_url }] : undefined,
    openGraph: {
      title,
      description,
      type: isFolder ? "website" : video ? "video.other" : "article",
      url,
      ...(siteName ? { siteName } : {}),
      ...(isFolder ? {} : { images: [{ url: ogImage, width: 1200, height: 630, alt: pageTitle }] }),
      ...(video ? { videos: [{ url: video.url, secureUrl: video.url, type: video.type }] } : {}),
    },
    twitter: isFolder
      ? { card: "summary", title, description }
      : { card: "summary_large_image", title, description, images: [ogImage] },
  };
}

export default async function TenantDocumentPage({ params }: Props) {
  const { host: param, path } = await params;
  const host = await assertTenantHost(param);
  const { folders, slug } = splitPath(path);
  if (!slug) notFound();

  // Null for an unknown host, an unverified or lapsed one, or one declared for
  // artifacts. Unknown or unverified must serve nothing, or pointing a CNAME at
  // us would be enough to browse the platform. A cdn-kind host has no document
  // surface at all: serving the app there would put the session on an origin
  // that also serves user-authored HTML. Throws (error page) when the API can't
  // be asked.
  const resolved = await resolveTenantHost(host);
  if (!resolved) notFound();
  const siteName = resolved.site_name?.trim() || host;

  // The whole path goes along: when a folder lives at exactly this address the API answers as for
  // a missing document, so a document filed elsewhere (or an old slug) can't redirect it away (B-N2).
  const result = await fetchTenantDocument(slug, resolved.workspace_id, folders);

  // A folder at exactly this path wins over a redirect to a document filed
  // elsewhere (B5): a document — or a former slug of one — named like a
  // folder must not take that folder's address over.
  const folderHere = async () => {
    const listing = await fetchTenantFolder(host, [...folders, slug], resolved.workspace_id);
    return listing && listing !== FOLDER_SIGNIN && listing.folder ? listing : null;
  };

  // A renamed slug: the old address keeps working by sending the reader to the
  // current one (307, like every canonical redirect here).
  if (result.status === "moved") {
    const listing = await folderHere();
    if (listing) {
      return <TenantFolderPage host={host} siteName={siteName} path={[...folders, slug]} initial={listing} />;
    }
    redirect(`/${[...result.folder_path, result.slug].map(encodeURIComponent).join("/")}`);
  }

  // Not a document: the whole path may name a folder. Only a listing the API
  // actually returns is shown; anything else is the tenant 404 (where a
  // signed-in reader's browser asks once more with their token).
  if (result.status === "missing") {
    const listing = await fetchTenantFolder(host, [...folders, slug], resolved.workspace_id);
    if (listing === FOLDER_SIGNIN) {
      const here = `/${[...folders, slug].map(encodeURIComponent).join("/")}`;
      return (
        <TenantFolderPage host={host} siteName={siteName} path={[...folders, slug]} initial={null} signInHref={signInUrlFor(host, here)} />
      );
    }
    if (!listing?.folder) notFound();
    return <TenantFolderPage host={host} siteName={siteName} path={[...folders, slug]} initial={listing} />;
  }

  const doc = result.status === "ok" ? result.doc : null;
  // Which gate the anonymous render hit. A private document with no password
  // must not be presented as "password protected" — there is no password to
  // type, and the reader is left with a box that can never open.
  const gate = result.status === "password" ? "password" : result.status === "signin" ? "signin" : null;

  // A gate reveals nothing about filing, so it is allowed through on any path.
  // Everything else is served only at its canonical address, and any other
  // spelling is redirected there — temporarily (307): refiling moves it, and a
  // cached permanent redirect would pin the old path in readers' browsers.
  if (doc && !pathMatches(doc, folders)) {
    const listing = await folderHere();
    if (listing) {
      return <TenantFolderPage host={host} siteName={siteName} path={[...folders, slug]} initial={listing} />;
    }
    const canonical = [...(doc.folder_path ?? []), slug].map(encodeURIComponent).join("/");
    redirect(`/${canonical}`);
  }

  // D24: "minimal" is no longer offered and behaves like "full". "none" keeps
  // hiding ImmersiveExit for anonymous readers (on this domain only).
  const viewerChrome = resolved.viewer_chrome === "none" ? "none" : "full";
  const here = `/${[...folders, slug].map(encodeURIComponent).join("/")}`;

  if (doc?.kind === "artifact") {
    return (
      <Suspense fallback={<TenantFallback />}>
        <ArtifactView
          slug={slug}
          title={doc.title}
          url={`https://${host}${here}`}
          createdAt={doc.created_at}
          views={doc.views}
          isPasswordProtected={false}
          mime={doc.mime ?? "application/octet-stream"}
          renderer={doc.renderer ?? "download"}
          typeLabel={doc.type_label ?? "File"}
          sizeBytes={doc.size_bytes ?? 0}
          originalFilename={doc.original_filename ?? null}
          artifactUrl={doc.artifact_url ?? null}
          downloadUrl={doc.download_url ?? null}
          posterUrl={doc.poster_url ?? null}
          readTicket={doc.read_ticket ?? null}
          fileVersion={doc.file_version ?? null}
          viewerChrome={viewerChrome}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<TenantFallback />}>
      <DocumentView
        slug={slug}
        title={doc?.title ?? null}
        content={doc?.content ?? ""}
        url={`https://${host}${here}`}
        createdAt={doc?.created_at ?? new Date().toISOString()}
        expiresAt={doc?.expires_at ?? null}
        views={doc?.views}
        isPasswordProtected={!!gate}
        gate={gate}
        signInUrl={signInUrlFor(host, here)}
        isOwned={doc?.is_owned ?? false}
        syncedWithVscode={doc?.vscode_synced ?? false}
        encrypted={doc?.encrypted ?? false}
        readTicket={doc?.read_ticket ?? null}
        viewerChrome={viewerChrome}
      />
    </Suspense>
  );
}

/** Neutral on purpose: the Markdrop loader would put our mark on the customer's site. */
function TenantFallback() {
  return <TenantLoading label="Opening document" />;
}
