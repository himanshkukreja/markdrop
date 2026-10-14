"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useMounted } from "@/components/shell/useLocation";
import { getToken } from "@/lib/api";

const TARGET = "/settings/workspaces";
const SIGN_IN_HREF = `/login?next=${encodeURIComponent(TARGET)}`;

/**
 * The page's primary action (REVAMP_PLAN 7.2). Signed in: "Create a workspace" → /settings/workspaces.
 * Signed out: "Sign in to create a workspace", which opens the in-place sign-in dialog with
 * next=/settings/workspaces (and is a plain /login?next=… link without JS).
 *
 * The server and the first client render are the signed-out link (the page stays static). After
 * mount, a stored token counts as signed in while /me loads, so a returning user doesn't see the label
 * flip twice.
 */
export function WorkspaceCta({ className }: { className?: string }) {
  const { user, loading, openAuthModal } = useAuth();
  const mounted = useMounted();
  const router = useRouter();
  const signedIn = mounted && (!!user || (loading && !!getToken()));

  if (signedIn) {
    return (
      <Button href={TARGET} size="lg" iconRight="arrowRight" className={className}>
        Create a workspace
      </Button>
    );
  }
  return (
    <Button
      href={SIGN_IN_HREF}
      size="lg"
      iconRight="arrowRight"
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab: the /login page
        e.preventDefault();
        openAuthModal({
          next: TARGET,
          message: "Sign in to create a workspace.",
          onSuccess: () => router.push(TARGET),
        });
      }}
    >
      Sign in to create a workspace
    </Button>
  );
}

export default WorkspaceCta;
