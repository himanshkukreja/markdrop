import type { Metadata } from "next";
import DomainCheck from "./DomainCheck";

// Never names the domain (titles reach history and analytics) and never indexed.
export const metadata: Metadata = {
  title: "Check a domain · Markdrop Guides",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * markdrop.in/d/check/<host>: the public, read-only page a guide's admin sends to whoever runs the
 * DNS. The record to add, in their provider's words, and whether it's live yet (it re-checks while
 * open). Nothing about the guide or who set it up.
 */
export default async function Page({ params }: { params: Promise<{ host: string }> }) {
  const { host } = await params;
  return <DomainCheck host={decodeURIComponent(host).toLowerCase()} />;
}
