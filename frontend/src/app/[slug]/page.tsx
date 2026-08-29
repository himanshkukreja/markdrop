import { Suspense } from "react";
import { getDocument, API_BASE } from "@/lib/api";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ArtifactView from "./ArtifactView";
import DocumentView from "./DocumentView";

interface Props {
  params: Promise<{ slug: string }>;
}

// Serve the anonymous render from the edge and refresh it in the background.
// Safe because this render is always anonymous (localStorage — and therefore
// the auth header — doesn't exist server-side), the client re-fetches through
// the authorized path on mount, and open pages live-update over the socket.
// The ?new/?edit/?copy/?gsync flags are read client-side via useSearchParams:
// reading searchParams here would force every request to render dynamically.
export const revalidate = 60;

// A dynamic segment only joins the full route cache when it declares
// generateStaticParams. Returning [] prerenders nothing at build time (slugs
// are created at runtime) while still letting each on-demand render be cached
// and background-revalidated, instead of re-rendering for every visitor.
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  // Dynamic link-preview card, rendered server-side by the backend. The endpoint
  // is content-safe (generic card for password-protected / unknown slugs), so we
  // advertise it in both metadata branches.
  const ogImage = `${API_BASE}/api/v1/og/${slug}.png`;
  const images = [{ url: ogImage, width: 1200, height: 630, alt: "Markdrop" }];
  try {
    const doc = await getDocument(slug, undefined, undefined, { revalidate: 60 });
    const pageTitle = doc.title || slug;
    const preview = doc.content.slice(0, 150).replace(/[#*_`]/g, "");
    const title = `${pageTitle} — Markdrop`;
    const description = preview || "A document on Markdrop";
    return {
      title,
      description,
      openGraph: { title, description, type: "article", images },
      twitter: { card: "summary_large_image", title, description, images: [ogImage] },
    };
  } catch {
    // Password-protected or not found — generic metadata, still a rich card.
    const title = `${slug} — Markdrop`;
    const description = "A document on Markdrop";
    return {
      title,
      description,
      openGraph: { title, description, type: "article", images },
      twitter: { card: "summary_large_image", title, description, images: [ogImage] },
    };
  }
}

export default async function SlugPage({ params }: Props) {
  const { slug } = await params;

  let doc = null;
  let isPasswordProtected = false;

  try {
    doc = await getDocument(slug, undefined, undefined, { revalidate: 60 });
  } catch (e) {
    if (e instanceof Error && e.message === "PASSWORD_REQUIRED") {
      isPasswordProtected = true;
    } else {
      notFound();
    }
  }

  // Artifacts render their file in a sandboxed iframe on the artifact origin
  // rather than as markdown, so they get their own viewer entirely.
  if (doc?.kind === "artifact") {
    return (
      <Suspense fallback={null}>
      <ArtifactView
        slug={slug}
        title={doc.title}
        url={`https://markdrop.in/${slug}`}
        createdAt={doc.created_at}
        views={doc.views}
        isPasswordProtected={false}
        mime={doc.mime ?? "application/octet-stream"}
        renderer={doc.renderer ?? "download"}
        typeLabel={doc.type_label ?? "File"}
        sizeBytes={doc.size_bytes ?? 0}
        originalFilename={doc.original_filename ?? null}
        artifactUrl={doc.artifact_url ?? null}
      />
      </Suspense>
    );
  }

  // A protected document 401s on the anonymous SSR fetch, so we can't yet tell
  // markdown from artifact. DocumentView handles the gate and re-renders once
  // it knows — see its `kind` check after unlock.
  return (
    <Suspense fallback={null}>
    <DocumentView
      slug={slug}
      title={doc?.title ?? null}
      content={doc?.content ?? ""}
      url={`https://markdrop.in/${slug}`}
      createdAt={doc?.created_at ?? new Date().toISOString()}
      expiresAt={doc?.expires_at ?? null}
      views={doc?.views}
      isPasswordProtected={isPasswordProtected}
      isOwned={doc?.is_owned ?? false}
      syncedWithVscode={doc?.vscode_synced ?? false}
    />
    </Suspense>
  );
}
