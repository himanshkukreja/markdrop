import { getDocument, API_BASE } from "@/lib/api";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ArtifactView from "./ArtifactView";
import DocumentView from "./DocumentView";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ new?: string; edit?: string; copy?: string; gsync?: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  // Dynamic link-preview card, rendered server-side by the backend. The endpoint
  // is content-safe (generic card for password-protected / unknown slugs), so we
  // advertise it in both metadata branches.
  const ogImage = `${API_BASE}/api/v1/og/${slug}.png`;
  const images = [{ url: ogImage, width: 1200, height: 630, alt: "Markdrop" }];
  try {
    const doc = await getDocument(slug);
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

export default async function SlugPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { new: isNew, edit, copy, gsync } = await searchParams;

  let doc = null;
  let isPasswordProtected = false;

  try {
    doc = await getDocument(slug);
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
      <ArtifactView
        slug={slug}
        title={doc.title}
        url={`https://markdrop.in/${slug}`}
        createdAt={doc.created_at}
        views={doc.views}
        isNew={isNew === "1"}
        isPasswordProtected={false}
        mime={doc.mime ?? "application/octet-stream"}
        renderer={doc.renderer ?? "download"}
        typeLabel={doc.type_label ?? "File"}
        sizeBytes={doc.size_bytes ?? 0}
        originalFilename={doc.original_filename ?? null}
        artifactUrl={doc.artifact_url ?? null}
      />
    );
  }

  // A protected document 401s on the anonymous SSR fetch, so we can't yet tell
  // markdown from artifact. DocumentView handles the gate and re-renders once
  // it knows — see its `kind` check after unlock.
  return (
    <DocumentView
      slug={slug}
      title={doc?.title ?? null}
      content={doc?.content ?? ""}
      url={`https://markdrop.in/${slug}`}
      createdAt={doc?.created_at ?? new Date().toISOString()}
      expiresAt={doc?.expires_at ?? null}
      views={doc?.views}
      isNew={isNew === "1"}
      isPasswordProtected={isPasswordProtected}
      isOwned={doc?.is_owned ?? false}
      syncedWithVscode={doc?.vscode_synced ?? false}
      startInEdit={edit === "1"}
      startCopy={copy === "1"}
      startGoogleSync={gsync === "1"}
    />
  );
}
