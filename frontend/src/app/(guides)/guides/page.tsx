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
 * /guides. The static HTML is the Markdrop Guides landing page (what search engines and signed-out
 * visitors get, canonical for /guides?about=1 too); a signed-in visitor gets the studio home in its
 * place (the layout's GuidesFrame). No request data here, so the page stays static.
 */
export default function Page() {
  return <GuidesLanding />;
}
