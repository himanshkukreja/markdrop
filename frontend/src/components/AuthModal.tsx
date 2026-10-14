"use client";

import { useCallback, useState } from "react";
import { Dialog } from "@/components/ui";
import { SignInForm, SIGN_IN_TITLE } from "@/components/auth/SignInForm";

/**
 * In-place sign-in / sign-up dialog (REVAMP_PLAN 7.14): a DS `Dialog sm` around the shared
 * `SignInForm`. Markdrop is passwordless, so the same flow both signs in and creates an account.
 * Email-code verification completes without leaving the page and fires `onSuccess`; "Continue with
 * Google" is a full OAuth redirect, so it carries `next` to resume the action on return.
 * `message` gives the context ("Sign in to publish an artifact"); it is the dialog's description.
 *
 * Mounted by AuthContext while open (it unmounts on close), so `open` is always true here.
 */
export default function AuthModal({
  onClose,
  onSuccess,
  next = "/dashboard",
  title = SIGN_IN_TITLE,
  message,
}: {
  onClose: () => void;
  onSuccess?: () => void;
  next?: string;
  title?: string;
  message?: string;
}) {
  const [busy, setBusy] = useState(false);
  const onBusyChange = useCallback((b: boolean) => setBusy(b), []);

  return (
    <Dialog
      open
      size="sm"
      title={title}
      description={message}
      dismissible={!busy}
      onClose={() => { if (!busy) onClose(); }}
    >
      <SignInForm
        variant="dialog"
        message={message}
        next={next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard"}
        onBusyChange={onBusyChange}
        onSignedIn={() => { onSuccess?.(); onClose(); }}
      />
    </Dialog>
  );
}
