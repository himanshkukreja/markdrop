"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Alert, Button, Card, MarkdropLoader, VisuallyHidden } from "@/components/ui";
import { BrandMark } from "@/components/integrations/BrandMark";
import { finishNotion, readNotionState } from "@/lib/notionConnect";

/**
 * Notion's callback: the server checks the state (signed, for this account, recent, used once), exchanges the
 * code and stores the token encrypted; then back where the person started (default: Settings › Integrations ›
 * Notion) with ?notion=connected, which opens the import picker.
 */
export default function NotionCallbackClient() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const code = params.get("code") || "";
  const state = params.get("state") || "";
  const denied = params.get("error");
  const { back } = readNotionState(state);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (loading || started.current) return;
    if (!user) {
      started.current = true;
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    if (denied || !code || !state) return;
    started.current = true;
    (async () => {
      try {
        const out = await finishNotion(code, state);
        const to = out.back || "/settings/integrations/notion";
        router.replace(to + (to.includes("?") ? "&" : "?") + "notion=connected");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Notion didn't finish connecting. Try again.");
      }
    })();
  }, [loading, user, denied, code, state, router]);

  const backTo = back || "/settings/integrations/notion";
  const problem = denied
    ? (denied === "access_denied" ? "You cancelled on Notion's page. Nothing changed." : "Notion didn't finish connecting.")
    : (!code || !state) ? "This page finishes connecting Notion. Start from Settings › Integrations › Notion." : error;

  if (!problem) {
    return (
      <>
        <VisuallyHidden as="h1">Connecting Notion</VisuallyHidden>
        <MarkdropLoader label="Connecting Notion…" size="sm" />
      </>
    );
  }
  return (
    <Card className="w-full max-w-[440px] sm:p-3">
      <div className="flex flex-col items-center gap-4 text-center" data-testid="notion-callback-problem">
        <BrandMark brand="notion" size={40} />
        <h1 className="m-0 text-h3 text-text">Notion isn&apos;t connected</h1>
        <Alert tone={denied === "access_denied" ? "info" : "danger"} className="w-full text-left">{problem}</Alert>
        <Button href={backTo} variant="secondary">Back</Button>
      </div>
    </Card>
  );
}
