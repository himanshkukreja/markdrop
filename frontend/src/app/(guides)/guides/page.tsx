import type { Metadata } from "next";
import GuidesLanding from "@/components/guides-landing/GuidesLanding";

const TITLE = "Markdrop Guides: docs that show you what to fix next";
const DESCRIPTION =
  "Build and host your help center, product guides and API docs, free while in beta. A ranked Fix list shows what confuses readers and drafts the fix. Live demos, video and PDFs in your pages, private pages for each customer, imports from GitBook, Mintlify and GitHub.";

export const metadata: Metadata = {
  metadataBase: new URL("https://markdrop.in"),
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/guides" },
  robots: { index: true, follow: true },
  openGraph: { title: "Docs that show you what to fix next", description: DESCRIPTION, url: "/guides", type: "website", siteName: "Markdrop" },
  twitter: { card: "summary_large_image", title: "Docs that show you what to fix next", description: DESCRIPTION },
};

/**
 * markdrop.in/guides: the Markdrop Guides landing page, for everyone (signed in, its start button
 * says "Open your guides" and goes to the studio, guides.markdrop.in). Canonical and indexed; the
 * old /guides?about=1 and /guides/about redirect here (middleware). No request data, so it's static.
 */
export default function Page() {
  return <GuidesLanding />;
}
