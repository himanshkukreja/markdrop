import { Suspense } from "react";
import type { Metadata } from "next";
import SlackLinkClient from "./SlackLinkClient";

export const metadata: Metadata = {
  title: "Link Slack · Markdrop",
  robots: { index: false, follow: false },
};

/** The "Link my Markdrop account" button in Slack opens this (?team=<Slack team id>). */
export default function SlackLinkPage() {
  return (
    <div className="flex flex-1 items-center justify-center py-6 sm:py-10">
      <Suspense fallback={null}>
        <SlackLinkClient />
      </Suspense>
    </div>
  );
}
