import { Suspense } from "react";
import type { Metadata } from "next";
import ZoomReviewClient from "./ZoomReviewClient";

export const metadata: Metadata = {
  title: "Zoom meetings to review · Markdrop",
  robots: { index: false, follow: false },
};

/** Your recorded Zoom meetings waiting for your decision (backend services/zoom_review.py). */
export default function ZoomReviewPage() {
  return (
    <div className="flex flex-1 justify-center px-4 py-6 sm:py-10">
      <Suspense fallback={null}>
        <ZoomReviewClient />
      </Suspense>
    </div>
  );
}
