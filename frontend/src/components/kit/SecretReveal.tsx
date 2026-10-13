"use client";
/**
 * SecretReveal (REVAMP_PLAN 7.6 "Post-publish", 8.2): the edit secret of a document published
 * without an account.
 *
 * - eyebrow "Edit secret", a mono read-only input (selects itself on focus) and CopyButton
 *   "Copy secret";
 * - the caption "You'll only see this in this tab. Copy it now — it's the only way to edit or
 *   delete this document without an account." (never "Shown once": the secret stays in
 *   sessionStorage `secret:<slug>` and shows again if this tab reloads);
 * - signed out: link "Sign in to keep it in your account"; signed in: secondary
 *   "Save to my account";
 * - a signed-in owner sees it collapsed behind a link "Show edit secret".
 *
 * The warning-soft card edge marks it as the thing not to lose. `enterDelay` lets PublishedPanel
 * raise it after the publish drop (reduced motion: no rise).
 */
import React, { useEffect, useId, useRef, useState } from "react";
import { Badge, Button, CopyButton, Icon, Input } from "@/components/ui";
import s from "./publish.module.css";

export interface SecretRevealProps {
  value: string;
  signedIn: boolean;
  /** The signed-in viewer owns the document: collapse behind "Show edit secret". */
  isOwner?: boolean;
  /** Called after a successful copy. */
  onCopy?: () => void;
  /** Externally known "already copied" (e.g. remembered by the surface); shows the Copied badge. */
  copied?: boolean;
  /** Signed in: "Save to my account". May return a promise (the button shows a spinner). */
  onSaveToAccount?: () => void | Promise<unknown>;
  /** Signed in and already saved: the button becomes a quiet confirmation. */
  saved?: boolean;
  /** Signed out: where "Sign in to keep it in your account" goes. */
  signInHref?: string;
  /** Signed out: instead of a link, e.g. to open the auth dialog. */
  onSignIn?: () => void;
  /** ms before the card rises in (PublishedPanel passes ~1020). Omit for no entrance. */
  enterDelay?: number;
  className?: string;
}

export function SecretReveal({ value, signedIn, isOwner, onCopy, copied: copiedProp, onSaveToAccount, saved, signInHref, onSignIn, enterDelay, className }: SecretRevealProps) {
  const uid = useId();
  const [shown, setShown] = useState(!(signedIn && isOwner));
  const [copiedHere, setCopiedHere] = useState(false);
  const [saving, setSaving] = useState(false);
  const copied = copiedProp || copiedHere;
  const inputRef = useRef<HTMLInputElement>(null);
  const revealed = useRef(false);
  // "Show edit secret" unmounts the button: move focus to the secret it revealed.
  useEffect(() => { if (shown && revealed.current) { revealed.current = false; inputRef.current?.focus(); } }, [shown]);

  if (!shown) {
    return (
      <div className={[s.secretCollapsed, className].filter(Boolean).join(" ")}>
        <Button variant="link" size="sm" iconLeft="key" aria-expanded={false} onClick={() => { revealed.current = true; setShown(true); }}>
          Show edit secret
        </Button>
      </div>
    );
  }

  const save = async () => {
    if (!onSaveToAccount) return;
    const r = onSaveToAccount();
    if (r && typeof (r as Promise<unknown>).then === "function") {
      setSaving(true);
      try { await r; } finally { setSaving(false); }
    }
  };

  const style = enterDelay !== undefined ? ({ "--secret-delay": `${enterDelay}ms` } as React.CSSProperties) : undefined;
  return (
    <section id={`${uid}-card`} aria-labelledby={`${uid}-title`} style={style}
      className={[s.secret, enterDelay !== undefined && s.secretRise, className].filter(Boolean).join(" ")}>
      <div className={s.secretHead}>
        <h3 id={`${uid}-title`} className={s.secretEyebrow}><Icon name="key" /> Edit secret</h3>
        {copied
          ? <Badge tone="success" size="sm" icon="check">Copied</Badge>
          : <span className={s.secretAside}>Anyone holding it can edit or delete</span>}
      </div>
      <div className={s.secretRow}>
        <Input ref={inputRef} mono readOnly value={value} aria-label="Edit secret" aria-describedby={`${uid}-note`} className={s.secretInput}
          wrapClassName={s.secretInputWrap} onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={value} label="Copy secret" announceText="Edit secret copied" size="md" variant="secondary" className={s.secretCopy}
          onCopy={() => { setCopiedHere(true); onCopy?.(); }} />
      </div>
      <p id={`${uid}-note`} className={s.secretNote}>
        <Icon name="alert" className={s.secretNoteIcon} />
        <span><strong>You&apos;ll only see this in this tab.</strong> Copy it now — it&apos;s the only way to edit or delete this document without an account.</span>
      </p>
      {signedIn ? (
        onSaveToAccount || saved ? (
          <div className={s.secretFoot}>
            {saved
              ? <span className={s.secretSaved}><Icon name="check" /> Saved to your account</span>
              : <Button variant="secondary" size="md" iconLeft="folder" loading={saving} onClick={save}>Save to my account</Button>}
          </div>
        ) : null
      ) : (signInHref || onSignIn) ? (
        <div className={s.secretFoot}>
          <Button variant="link" size="sm" href={onSignIn ? undefined : signInHref} onClick={onSignIn}>Sign in to keep it in your account</Button>
        </div>
      ) : null}
    </section>
  );
}
