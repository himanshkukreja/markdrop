import { Suspense } from "react";
import type { Metadata } from "next";
import SlackCallbackClient from "./SlackCallbackClient";

export const metadata: Metadata = {
  title: "Connecting Slack · Markdrop",
  robots: { index: false, follow: false },
};

/** Where Slack sends people back after Add to Slack and Sign in with Slack (the app's redirect URL). */
export default function SlackCallbackPage() {
  return (
    <div className="flex flex-1 items-center justify-center py-6 sm:py-10">
      <Suspense fallback={null}>
        <SlackCallbackClient />
      </Suspense>
    </div>
  );
}
