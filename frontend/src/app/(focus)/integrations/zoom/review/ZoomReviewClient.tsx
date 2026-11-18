"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Skeleton } from "@/components/ui";
import { ZoomReviewList } from "@/components/zoom/ZoomReviewList";

/**
 * Your recorded Zoom meetings that wait for your decision (backend services/zoom_review.py): held because everyone
 * on the call is from the company, or because you chose "Ask me first". Only metadata is kept until you decide
 * (nothing downloaded) and only you see them. Share with the team, keep it just for you, or skip it. They expire
 * after 30 days. `?workspace=` narrows to one workspace (the inbox and Slack links pass it).
 */
export default function ZoomReviewClient() {
  const params = useSearchParams();
  const ws = params.get("workspace");
  const { user, loading } = useAuth();
  const redirected = useRef(false);

  useEffect(() => {
    if (loading || user || redirected.current) return;
    redirected.current = true;
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }, [loading, user]);

  return (
    <div className="flex w-full max-w-[680px] min-w-0 flex-col gap-4" data-testid="zoom-review">
      <div>
        <h1 className="text-h2 text-text">Zoom meetings to review</h1>
        <p className="mt-1 text-[13px] leading-5 text-text-secondary">
          These recorded meetings wait for you. Until you decide, Markdrop keeps only their topic, time and who joined,
          and only you see them. They expire after 30 days (Zoom keeps the recording).{" "}
          <Link href="/settings/account#zoom" className="text-accent-text hover:underline">Change when Markdrop asks</Link>
        </p>
      </div>
      {user ? <ZoomReviewList workspace={ws} /> : <Skeleton width="70%" height={16} />}
    </div>
  );
}
