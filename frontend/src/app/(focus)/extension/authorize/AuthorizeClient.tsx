"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { createApiToken } from "@/lib/api";
import { Alert, Anchor, Button, Card, Icon, MarkdropLoader, Spinner, VisuallyHidden } from "@/components/ui";
import { track } from "@/lib/track";
import { ConnectGraphic, type ConnectGraphicHandle } from "./ConnectGraphic";

/**
 * Only the VS Code app schemes may receive the token (never an https URL or another app):
 * the redirect must start with exactly `<scheme>://` for one of these schemes. Written as a
 * scheme set because a past theme-variant sweep deleted the "vscode" + ":" literal from a
 * startsWith() here and silently allowed every redirect.
 */
const ALLOWED_SCHEMES = new Set(["vscode", "vscode-insiders"]);
function isAllowedRedirect(redirect: string): boolean {
  const i = redirect.indexOf("://");
  return i > 0 && ALLOWED_SCHEMES.has(redirect.slice(0, i));
}

type Phase = "idle" | "creating" | "opening" | "done";

export default function AuthorizeClient() {
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const state = params.get("state") || "";
  const redirect = params.get("redirect") || "";
  const validRedirect = isAllowedRedirect(redirect);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<"session" | "failed" | null>(null);
  const graphic = useRef<ConnectGraphicHandle>(null);
  const redirected = useRef(false);

  // Signed out: go to sign in and come back here (the whole authorize URL, state included).
  // In an effect, never during render.
  useEffect(() => {
    if (loading || user || redirected.current) return;
    redirected.current = true;
    const next = window.location.pathname + window.location.search;
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
  }, [loading, user]);

  if (loading || !user) {
    const label = loading ? "Loading" : "Taking you to sign in…";
    return (
      <>
        <VisuallyHidden as="h1">Connect VS Code</VisuallyHidden>
        <MarkdropLoader label={label} size="sm" />
      </>
    );
  }

  async function authorize() {
    if (!validRedirect || phase !== "idle") return;
    setPhase("creating"); setError(null);
    try {
      const tok = await createApiToken("VS Code");
      track("vscode_connected");
      const sep = redirect.includes("?") ? "&" : "?";
      const url = `${redirect}${sep}token=${encodeURIComponent(tok.token)}&state=${encodeURIComponent(state)}`;
      setPhase("opening");
      await graphic.current?.send();
      window.location.href = url;
      // The OS hands the link to VS Code; there is no signal back, so settle after a beat.
      window.setTimeout(() => setPhase("done"), 1200);
    } catch (e) {
      setError(e instanceof Error && e.message === "UNAUTHORIZED" ? "session" : "failed");
      setPhase("idle");
    }
  }

  const signInAgain = `/login?next=${encodeURIComponent(
    typeof window !== "undefined" ? window.location.pathname + window.location.search : "/extension/authorize",
  )}`;

  return (
    <Card className="w-full max-w-[440px] sm:p-3">
      <div className="flex flex-col gap-5">
        <ConnectGraphic ref={graphic} landed={phase === "opening" || phase === "done"} />

        <div className="flex flex-col gap-1.5 text-center">
          <h1 className="m-0 text-h3 text-text">Connect VS Code</h1>
          <p className="m-0 text-body text-text-secondary">
            Markdrop Sync will publish and sync documents as{" "}
            <strong className="font-semibold text-text break-words">{user.email}</strong>.
          </p>
        </div>

        <ul className="m-0 flex list-none flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3 sm:p-4">
          {["Publish files you choose", "Keep them in sync on save"].map((t) => (
            <li key={t} className="flex items-center gap-2.5 text-body text-text">
              <span className="grid size-5 flex-none place-items-center rounded-full bg-success-soft text-success" aria-hidden="true">
                <Icon name="check" size={12} />
              </span>
              {t}
            </li>
          ))}
        </ul>

        {!validRedirect && (
          <Alert tone="warning">Open this page from the VS Code extension: run <strong>Markdrop: Sign in</strong>.</Alert>
        )}
        {error === "session" && (
          <Alert tone="danger" title="Your session ended" actions={<Button href={signInAgain} size="sm" variant="secondary">Sign in again</Button>}>
            Sign in again, then authorize VS Code.
          </Alert>
        )}
        {error === "failed" && (
          <Alert tone="danger" title="Couldn't connect VS Code">
            Try again. If it keeps failing, create a token in{" "}
            <Anchor href="/settings/tokens" className="text-accent-text underline underline-offset-2">API tokens</Anchor>{" "}
            and use <strong>Markdrop: Sign in with API token</strong>.
          </Alert>
        )}

        {phase === "done" ? (
          <Alert tone="success" live title="Connected. You can close this tab.">
            VS Code didn&apos;t open? Switch to it and run <strong>Markdrop: Sign in</strong> again.
          </Alert>
        ) : phase === "opening" ? (
          <p className="m-0 flex min-h-11 items-center justify-center gap-2 text-body text-text-secondary" role="status">
            <Spinner size={16} /> Opening VS Code…
          </p>
        ) : (
          <Button
            variant="primary" size="lg" block
            loading={phase === "creating"}
            aria-disabled={!validRedirect || undefined}
            onClick={authorize}
          >
            {phase === "creating" ? "Authorizing…" : "Authorize VS Code"}
          </Button>
        )}

        <p className="m-0 text-center text-caption text-text-muted">
          You can revoke this anytime in{" "}
          <Anchor href="/settings/tokens" className="text-accent-text underline underline-offset-2">API tokens</Anchor>.
        </p>
      </div>
    </Card>
  );
}
