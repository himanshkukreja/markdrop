import { Suspense } from "react";
import type { Metadata } from "next";
import ZoomCallbackClient from "./ZoomCallbackClient";

export const metadata: Metadata = {
  title: "Connecting Zoom · Markdrop",
  robots: { index: false, follow: false },
};

/** Where Zoom sends people back after its consent screen (the Marketplace app's OAuth redirect URL). */
export default function ZoomCallbackPage() {
  return (
    <div className="flex flex-1 items-center justify-center py-6 sm:py-10">
      <Suspense fallback={null}>
        <ZoomCallbackClient />
      </Suspense>
    </div>
  );
}
