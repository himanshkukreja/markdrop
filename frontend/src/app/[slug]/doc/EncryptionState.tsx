"use client";

import { Alert, Card, CopyButton, Icon, MarkdropLoader } from "@/components/ui";
import { KeyAnatomy } from "@/components/kit/KeyAnatomy";
import { TenantLoading, useTenant } from "@/components/tenant";

export type EncryptionScreen = "working" | "nokey" | "failed" | "unsupported";

/**
 * What an encrypted document shows before — or instead of — its text (REVAMP_PLAN 7.6
 * "Gates and encryption states").
 *
 * "No key" is the interesting case and by far the most common: someone shared
 * `markdrop.in/slug` after copying it out of the address bar of a browser that
 * hid the fragment, or a chat app trimmed it. Nothing can be done server-side,
 * so the screen has to explain the situation rather than look broken.
 *
 * Nothing here ever renders the envelope: the ciphertext never reaches the DOM.
 */
export function EncryptionState({ state, url }: { state: EncryptionScreen; url: string }) {
  const tenant = useTenant();
  if (state === "working") {
    return (
      <div className="flex justify-center py-14" role="status" aria-live="polite">
        {tenant
          ? <TenantLoading label="Decrypting in your browser…" />
          : <MarkdropLoader label="Decrypting in your browser…" size="sm" delay={250} />}
      </div>
    );
  }

  const tile = (icon: string, danger?: boolean) => (
    <span
      aria-hidden
      className={`grid h-12 w-12 place-items-center rounded-xl border text-h3 ${
        danger ? "border-danger bg-danger-soft text-danger" : "border-border bg-accent-soft text-accent-text"
      }`}
    >
      <Icon name={icon} />
    </span>
  );

  const recover = (
    <p className="text-caption text-text-muted">
      Markdrop cannot help recover it. The key has never been sent to our servers — that is the
      point of the feature, and it has no exceptions.
    </p>
  );

  if (state === "nokey") {
    return (
      <Card className="mx-auto my-8 max-w-[640px] text-center">
        <div className="flex flex-col items-center gap-4 py-2">
          {tile("key")}
          <div className="flex flex-col gap-1.5">
            <p className="text-eyebrow text-accent-text">End-to-end encrypted</p>
            <h2 className="text-h3 text-text">This document is end-to-end encrypted</h2>
          </div>
          <KeyAnatomy url={url} mode="missing" className="w-full text-left" />
          <p className="text-body text-text-secondary">Ask whoever shared it for the full link.</p>
          {recover}
        </div>
      </Card>
    );
  }

  if (state === "unsupported") {
    return (
      <Card className="mx-auto my-8 max-w-[520px] text-center">
        <div className="flex flex-col items-center gap-3 py-2">
          {tile("alert")}
          <h2 className="text-h3 text-text">This browser can&apos;t decrypt documents</h2>
          <p className="text-body text-text-secondary">Open the link in an up-to-date browser over https.</p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mx-auto my-8 max-w-[520px] text-center">
      <div className="flex flex-col items-center gap-3 py-2">
        {tile("alertCircle", true)}
        <h2 className="text-h3 text-text">That key doesn&apos;t open this document</h2>
        <p className="text-body text-text-secondary">
          The key is either wrong or the stored document was altered. Encrypted documents are
          authenticated as well as encrypted, so Markdrop refuses to show anything rather than
          show you something that may have been tampered with.
        </p>
        {recover}
      </div>
    </Card>
  );
}

/** Opened with the key this browser saved, not one in the link (REVAMP_PLAN 7.6 "Device key"). */
export function DeviceKeyNotice({ shareUrl }: { shareUrl: string }) {
  return (
    <Alert
      tone="info"
      icon="key"
      title="Opened with the key saved in this browser"
      actions={<CopyButton text={shareUrl} label="Copy full link" size="sm" variant="secondary" />}
    >
      The link in your address bar has no key in it and won&apos;t work anywhere else.
    </Alert>
  );
}

/** Rotation just changed the link: every copy of the old one is dead (REVAMP_PLAN 7.6 "Rotated"). */
export function RotatedNotice({ link }: { link: string }) {
  return (
    <Alert tone="warning" title="New key generated — this is the link now.">
      <span className="flex flex-col gap-2">
        <span>The previous one no longer opens this document.</span>
        <span className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 break-all font-mono text-code text-text">{link}</code>
          <CopyButton text={link} label="Copy link" size="sm" variant="secondary" />
        </span>
      </span>
    </Alert>
  );
}
