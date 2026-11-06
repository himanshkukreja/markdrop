import { Suspense } from "react";
import type { Metadata } from "next";
import JiraCallbackClient from "./JiraCallbackClient";

export const metadata: Metadata = {
  title: "Connecting Jira · Markdrop",
  robots: { index: false, follow: false },
};

/** Where Atlassian sends people back after its consent screen (the OAuth app's callback URL). */
export default function JiraCallbackPage() {
  return (
    <div className="flex flex-1 items-center justify-center py-6 sm:py-10">
      <Suspense fallback={null}>
        <JiraCallbackClient />
      </Suspense>
    </div>
  );
}
