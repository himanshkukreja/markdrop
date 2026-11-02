import type { Metadata } from "next";
import StudioHome from "@/components/docs-sites/StudioHome";

export const metadata: Metadata = { title: { absolute: "Your guides · Markdrop Guides" } };

/**
 * The studio home: guides.markdrop.in/ (the middleware rewrites "/" there to this route), and
 * /guides/home on localhost and previews. /guides itself is the landing page.
 */
export default function Page() {
  return <StudioHome />;
}
