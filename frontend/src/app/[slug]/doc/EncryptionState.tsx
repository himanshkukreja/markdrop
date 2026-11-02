"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Card, CopyButton, Icon, Input, MarkdropLoader } from "@/components/ui";
import { KeyAnatomy } from "@/components/kit/KeyAnatomy";
import { TenantLoading, useTenant } from "@/components/tenant";
import type { DecryptReason } from "@/lib/e2e";

export type EncryptionScreen = "working" | "nokey" | "failed" | "unsupported" | "password";

export interface EncryptionStateProps {
  state: EncryptionScreen;
  url: string;
  /** "failed": why. "key" (wrong or old key), "altered" (right key, changed bytes), "malformed". */
  reason?: DecryptReason | null;
  /** "Have the full link? Paste it here." Returns an error message, or null when it took. */
  onPasteLink?: (text: string) => string | null;
  /** "password": the prompt. */
  onPassword?: (value: string) => void;
  passwordError?: string;
  passwordErrorKey?: number;
  passwordChecking?: boolean;
}

/**
 * What an encrypted document shows before — or instead of — its text (REVAMP_PLAN 7.6
 * "Gates and encryption states").
 *
 * "No key" is the interesting case and by far the most common: someone shared
 * `markdrop.in/slug` after copying it out of the address bar of a browser that
 * hid the fragment, or a chat app trimmed it. Nothing can be done server-side,
 * so the screen explains the situation and offers the one local fix: paste the
 * full link, read here and never sent.
 *
 * Nothing here ever renders the envelope: the ciphertext never reaches the DOM.
 */
export function EncryptionState(props: EncryptionStateProps) {
  const { state, url, reason, onPasteLink } = props;
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

  if (state === "password") return <PasswordPrompt {...props} />;

  const recover = (
    <p className="text-caption text-text-muted">
      We can&apos;t recover it for you: the key — the part of the link after # — is never sent to our servers.
    </p>
  );

  if (state === "nokey") {
    return (
      <Card className="mx-auto my-8 max-w-[640px] text-center">
        <div className="flex flex-col items-center gap-4 py-2">
          <Tile icon="key" />
          <div className="flex flex-col gap-1.5">
            <p className="text-eyebrow text-accent-text">End-to-end encrypted</p>
            <h1 className="text-h3 text-text">This document is end-to-end encrypted</h1>
          </div>
          <KeyAnatomy url={url} mode="missing" className="w-full text-left" />
          <p className="text-body text-text-secondary">Ask whoever shared it for the full link.</p>
          {onPasteLink && <PasteLink onPaste={onPasteLink} />}
          {recover}
        </div>
      </Card>
    );
  }

  if (state === "unsupported") {
    return (
      <Card className="mx-auto my-8 max-w-[520px] text-center">
        <div className="flex flex-col items-center gap-3 py-2">
          <Tile icon="alert" />
          <h1 className="text-h3 text-text">This browser can&apos;t decrypt this document</h1>
          <p className="text-body text-text-secondary">
            Open the link in an up-to-date browser over https. If you&apos;re already using one, reload the page — this
            document may have been made by a newer version of Markdrop.
          </p>
        </div>
      </Card>
    );
  }

  // "failed": say only what is actually known.
  if (reason === "altered") {
    return (
      <Card className="mx-auto my-8 max-w-[560px] text-center">
        <div className="flex flex-col items-center gap-3 py-2">
          <Tile icon="alertCircle" danger />
          <h1 className="text-h3 text-text">This document may have been altered</h1>
          <p className="text-body text-text-secondary">
            The key is right, but the stored text doesn&apos;t match what was encrypted with it, so it isn&apos;t shown.
            Ask the owner to open it and save it again.
          </p>
        </div>
      </Card>
    );
  }
  if (reason === "malformed") {
    return (
      <Card className="mx-auto my-8 max-w-[560px] text-center">
        <div className="flex flex-col items-center gap-3 py-2">
          <Tile icon="alertCircle" danger />
          <h1 className="text-h3 text-text">This document couldn&apos;t be read</h1>
          <p className="text-body text-text-secondary">
            What&apos;s stored isn&apos;t something this browser can decrypt. Reload the page; if it keeps happening, ask the owner.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card className="mx-auto my-8 max-w-[560px] text-center">
      <div className="flex flex-col items-center gap-4 py-2">
        <Tile icon="key" danger />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-h3 text-text">This key doesn&apos;t open the current version</h1>
          <p className="text-body text-text-secondary">
            If the owner issued a new key, ask them for the new link.
          </p>
        </div>
        {onPasteLink && <PasteLink onPaste={onPasteLink} />}
        {recover}
      </div>
    </Card>
  );
}

function Tile({ icon, danger }: { icon: string; danger?: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid h-12 w-12 place-items-center rounded-xl border text-h3 ${
        danger ? "border-danger bg-danger-soft text-danger" : "border-border bg-accent-soft text-accent-text"
      }`}
    >
      <Icon name={icon} />
    </span>
  );
}

/** "Have the full link? Paste it here": parsed in this browser, never sent. */
function PasteLink({ onPaste }: { onPaste: (text: string) => string | null }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" iconLeft="link" onClick={() => setOpen(true)}>
        Have the full link? Paste it here
      </Button>
    );
  }
  return (
    <form
      className="flex w-full max-w-[460px] flex-col gap-2 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        const problem = onPaste(value);
        setError(problem ?? "");
        if (!problem) setValue("");
      }}
    >
      <label htmlFor={`${uid}-link`} className="text-caption-strong text-text">Full link</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          ref={inputRef}
          id={`${uid}-link`}
          mono
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(""); }}
          placeholder="markdrop.in/…#k=…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          invalid={!!error}
          aria-describedby={`${uid}-hint${error ? ` ${uid}-err` : ""}`}
          wrapClassName="min-w-0 flex-1"
        />
        <Button type="submit" disabled={!value.trim()}>Open</Button>
      </div>
      <p id={`${uid}-hint`} className="flex items-center gap-1.5 text-caption text-text-muted">
        <Icon name="eyeOff" /> Read in this browser. The key is never sent anywhere.
      </p>
      {error && <p id={`${uid}-err`} role="alert" className="text-caption text-danger">{error}</p>}
    </form>
  );
}

/** Link + password documents: the password is checked here, never by our servers. */
function PasswordPrompt({ onPassword, passwordError, passwordErrorKey = 0, passwordChecking }: EncryptionStateProps) {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  useEffect(() => {
    if (!passwordError) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [passwordError, passwordErrorKey]);

  return (
    <Card className="mx-auto my-8 max-w-[520px]">
      <form
        className="flex flex-col items-center gap-4 py-2 text-center"
        aria-busy={passwordChecking || undefined}
        onSubmit={(e) => {
          e.preventDefault();
          if (value) onPassword?.(value);
        }}
      >
        <Tile icon="lock" />
        <div className="flex flex-col gap-1.5">
          <p className="text-eyebrow text-accent-text">End-to-end encrypted</p>
          <h1 className="text-h3 text-text">This document also needs a password</h1>
          <p className="text-body text-text-secondary">
            Enter the password you were given. It&apos;s checked in this browser and never sent to our servers.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 text-left">
          <label htmlFor={`${uid}-pw`} className="md-visually-hidden">Password</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              ref={inputRef}
              id={`${uid}-pw`}
              type={visible ? "text" : "password"}
              placeholder="Password"
              autoComplete="current-password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              invalid={!!passwordError}
              aria-describedby={passwordError ? `${uid}-err` : undefined}
              wrapClassName="min-w-0 flex-1"
              suffix={
                <button
                  type="button"
                  className="md-focus grid h-8 w-8 place-items-center rounded-md text-text-muted hover:text-text"
                  aria-label={visible ? "Hide password" : "Show password"}
                  aria-pressed={visible}
                  onClick={() => setVisible((v) => !v)}
                >
                  <Icon name={visible ? "eyeOff" : "eye"} />
                </button>
              }
            />
            <Button type="submit" loading={passwordChecking} disabled={!value}>Open</Button>
          </div>
          {passwordChecking && <p role="status" className="text-caption text-text-muted">Checking in your browser…</p>}
          {passwordError && !passwordChecking && (
            <p id={`${uid}-err`} role="alert" className="flex items-start gap-1.5 text-caption text-danger">
              <Icon name="alertCircle" className="mt-0.5 shrink-0" />
              {passwordError}
            </p>
          )}
        </div>
        <p className="text-caption text-text-muted">
          Forgot it? Only the person who set it can help — we can&apos;t reset it.
        </p>
      </form>
    </Card>
  );
}

/** Opened with the key this browser kept, not one in the link (REVAMP_PLAN 7.6 "Device key"). */
export function DeviceKeyNotice({ shareUrl, linkStale }: { shareUrl: string; linkStale?: boolean }) {
  return (
    <Alert
      tone="info"
      icon="key"
      title="Opened with the key saved in this browser"
      actions={<CopyButton text={shareUrl} label="Copy full link" size="sm" variant="secondary" />}
    >
      {linkStale
        ? "The key in your address bar doesn't open the current version — the owner may have issued a new one. This is the link that works now."
        : "The link in your address bar has no key in it and won't work anywhere else."}
    </Alert>
  );
}

/** A new key or password just changed what opens the document (REVAMP_PLAN 7.6 "Rotated"). */
export function RotatedNotice({ link }: { link: string }) {
  return (
    <Alert tone="warning" title="New key issued — this is the link now">
      <span className="flex flex-col gap-2">
        <span>
          Old links stop opening the current version. Anyone who saved an old copy can still read that copy.
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <code className="ph-sensitive ph-mask min-w-0 break-all font-mono text-code text-text">{link}</code>
          <CopyButton text={link} label="Copy link" size="sm" variant="secondary" />
        </span>
      </span>
    </Alert>
  );
}
