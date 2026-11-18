import { Suspense } from "react";
import type { Metadata } from "next";
import NotionCallbackClient from "./NotionCallbackClient";

export const metadata: Metadata = {
  title: "Connecting Notion · Markdrop",
  robots: { index: false, follow: false },
};

/** Where Notion sends people back after its consent screen (the public integration's redirect URI). */
export default function NotionCallbackPage() {
  return (
    <div className="flex flex-1 items-center justify-center py-6 sm:py-10">
      <Suspense fallback={null}>
        <NotionCallbackClient />
      </Suspense>
    </div>
  );
}
