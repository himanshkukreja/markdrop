"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, MarkdropLoader } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { listWorkspaces } from "@/lib/workspaces";
import { meetingsStartLogin, meetingsStartTarget } from "@/lib/meetingsStart";

/** Resolves where "Start with your team" goes, then replaces the URL (no history entry for this). */
export default function MeetingsStart() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace(meetingsStartLogin());
      return;
    }
    let live = true;
    listWorkspaces()
      .then((ws) => live && router.replace(meetingsStartTarget(ws)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [loading, user, router]);

  if (failed)
    return (
      <div className="mx-auto flex max-w-md flex-col items-start gap-3 px-4 py-16">
        <Alert tone="danger">Couldn&apos;t load your workspaces.</Alert>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    );
  return (
    <div className="flex min-h-[50vh] items-center justify-center" aria-busy="true">
      <MarkdropLoader label="Opening your meetings" />
    </div>
  );
}
