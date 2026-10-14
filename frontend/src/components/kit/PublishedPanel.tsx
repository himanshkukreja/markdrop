"use client";
/**
 * PublishedPanel (REVAMP_PLAN 7.6 "Post-publish", 7.7, 6.2 "Publish" signature moment).
 *
 * Full (documents, `?new=1`, above the reading column):
 * - head: success tile, h3-size "Published" + Badge success dot "Live"; subhead "End-to-end
 *   encrypted. The key is in this link." for encrypted documents, else the access sentence;
 * - the link tile: the drop target, LinkPill with the full share URL (fragment kept), and
 *   CopyButton primary "Copy link" (the only primary; it copies `shareUrl`);
 * - secondary "Open full screen" and "Show QR code" (an inline QRFrame; D21);
 * - Alerts: encrypted "The link is the key", workspace-share failure;
 * - SecretReveal for an anonymous author's edit secret.
 *
 * Compact (artifacts over the immersive frame): floating bottom-left, 360px, surface-raised,
 * shadow-xl, above the immersive layer; a non-modal sheet docked to the bottom on phones. "Published",
 * the LinkPill, "Copy link", "Show details", and the access sentence.
 *
 * Motion: on mount the drop falls into the link tile (drop-fall → absorb → ripple, ~900ms, once),
 * then the SecretReveal rises 120ms later. Reduced motion: no drop; a static check in the tile.
 *
 * The surfaces own the leave guard (D22) and routing; this only reports copies through
 * `onLinkCopied` / `onSecretCopied`.
 */
import React, { useEffect, useId, useState } from "react";
import { Alert, Badge, Button, CopyButton, Icon, IconButton, announce } from "@/components/ui";
import { KeyChip, LinkPill } from "@/components/kit/LinkPill";
import { QRFrame } from "@/components/kit/QRFrame";
import { SecretReveal } from "./SecretReveal";
import { linkParts } from "./publish-utils";
import s from "./publish.module.css";

export type PublishedAccess = "link" | "private" | "workspace" | "password";

export interface PublishedPanelProps {
  /** The document URL without a fragment (what a server sees). */
  url: string;
  /** What "Copy link" copies and the QR encodes: `url` plus `#k=…` for encrypted documents. */
  shareUrl: string;
  access: PublishedAccess;
  encrypted: boolean;
  /** An anonymous author's edit secret (from sessionStorage `secret:<slug>`). */
  secret?: string | null;
  signedIn: boolean;
  isOwner: boolean;
  /** Names the workspace in the access sentence for `access="workspace"`. */
  workspaceName?: string | null;
  onOpenFullScreen?: () => void;
  /** Compact: "Show details" (exits immersive). */
  onShowDetails?: () => void;
  /** Signed in: SecretReveal's "Save to my account". */
  onSaveToAccount?: () => void | Promise<unknown>;
  secretSaved?: boolean;
  /** Signed out: SecretReveal's "Sign in to keep it in your account". */
  signInHref?: string;
  onSignIn?: () => void;
  compact?: boolean;
  /** Shows a Dismiss button. */
  onDismiss?: () => void;
  workspaceShareFailed?: boolean;
  onLinkCopied?: () => void;
  onSecretCopied?: () => void;
  /** Play the publish moment on mount (default true). */
  animate?: boolean;
  /** Heading level of "Published" (default 2; it is styled as h3 either way). */
  headingLevel?: 2 | 3;
  className?: string;
}

/** The sentence under the link, by real access level. */
export function accessSentence(access: PublishedAccess, opts: { compact?: boolean; workspaceName?: string | null } = {}): string {
  switch (access) {
    case "private": return "Only you can open it. Add people from Share.";
    case "password": return "Readers need the password.";
    case "workspace": return `Only people in ${opts.workspaceName || "the workspace"} can open it.`;
    default: return opts.compact ? "Anyone with the link can open it." : "Anyone with this link can read it. Readers never need an account.";
  }
}

function DropTile({ animate, small }: { animate: boolean; small?: boolean }) {
  return (
    <span className={[s.dropTile, small && s.dropTileSm, animate && s.dropPlay].filter(Boolean).join(" ")} aria-hidden>
      <span className={s.dropWell}>
        <Icon name="link" className={s.dropIconLink} />
        <Icon name="check" className={s.dropIconCheck} />
      </span>
      <span className={s.dropRipple} />
      <svg className={s.dropFall} viewBox="0 0 24 24"><path d="M12 2.5c3.6 4.6 6 8 6 11a6 6 0 0 1-12 0c0-3 2.4-6.4 6-11z" /></svg>
    </span>
  );
}

export function PublishedPanel(props: PublishedPanelProps) {
  const {
    url, shareUrl, access, encrypted, secret, signedIn, isOwner, workspaceName, onOpenFullScreen, onShowDetails, onSaveToAccount,
    secretSaved, signInHref, onSignIn, compact, onDismiss, workspaceShareFailed, onLinkCopied, onSecretCopied, animate = true,
    headingLevel = 2, className,
  } = props;
  const uid = useId();
  const [qr, setQr] = useState(false);
  const parts = linkParts(shareUrl || url);
  const H = (headingLevel === 3 ? "h3" : "h2") as "h2" | "h3";

  useEffect(() => { announce(compact ? "Published. Copy link is ready." : "Published. Copy the link to share it."); }, [compact]);

  const pill = (size: "md" | "lg") => (
    <LinkPill host={parts.host} slug={parts.slug} fragment={parts.fragment || undefined} size={size} variant="address" icon={null}
      middleEllipsis fragmentLabel={false} className={s.pubPill} />
  );
  const copy = (block?: boolean) => (
    <CopyButton text={shareUrl} label="Copy link" variant="primary" size="md" block={block} className={s.pubCopy}
      announceText="Link copied" onCopy={onLinkCopied} />
  );

  if (compact) {
    return (
      <section role="region" aria-labelledby={`${uid}-t`} className={[s.compact, className].filter(Boolean).join(" ")}>
        <div className={s.compactHead}>
          <DropTile animate={animate} small />
          <H id={`${uid}-t`} className={s.compactTitle}>Published</H>
          <Badge tone="success" size="sm" dot>Live</Badge>
          {onDismiss && <IconButton icon="x" label="Dismiss" size="sm" className={s.compactX} onClick={onDismiss} />}
        </div>
        <div className={s.compactLink}>{pill("md")}</div>
        <p className={s.compactNote}>{encrypted ? "End-to-end encrypted. The key is in this link." : accessSentence(access, { compact: true, workspaceName })}</p>
        {workspaceShareFailed && <Alert tone="warning">Published, but couldn&apos;t add it to the workspace. You can share it from your dashboard.</Alert>}
        <div className={s.compactActions}>
          {copy()}
          {onShowDetails && <Button variant="secondary" size="md" iconLeft="info" onClick={onShowDetails}>Show details</Button>}
        </div>
        {secret && (
          <SecretReveal value={secret} signedIn={signedIn} isOwner={isOwner} onCopy={onSecretCopied} onSaveToAccount={onSaveToAccount}
            saved={secretSaved} signInHref={signInHref} onSignIn={onSignIn} />
        )}
      </section>
    );
  }

  const qrId = `${uid}-qr`;
  return (
    <section aria-labelledby={`${uid}-t`} className={[s.published, className].filter(Boolean).join(" ")}>
      <div className={s.pubHead}>
        <span className={s.pubGlyph} aria-hidden><Icon name="checkCircle" /></span>
        <div className={s.pubHeading}>
          <div className={s.pubTitleRow}>
            <H id={`${uid}-t`} className={s.pubTitle}>Published</H>
            <Badge tone="success" size="sm" dot>Live</Badge>
          </div>
          {encrypted && <p className={s.pubSub}>End-to-end encrypted. The key is in this link.</p>}
        </div>
        {onDismiss && <IconButton icon="x" label="Dismiss" size="sm" onClick={onDismiss} />}
      </div>

      <div className={s.pubLinkBlock}>
        <div className={s.linkTile}>
          <div className={s.linkTileMain}>
            <DropTile animate={animate} />
            {/* Wide: one line, the slug middle-ellipsised and the key chip kept. Phone-width card:
                the link wraps, the key chip on its own line (only one of the two is displayed). */}
            <div className={s.pillWide}>{pill("lg")}</div>
            <div className={s.pillNarrow}>
              <LinkPill host={parts.host} slug={parts.slug} size="md" variant="address" icon={null} middleEllipsis className={s.pubPill} />
              {parts.fragment && <KeyChip fragment={parts.fragment} size="md" />}
            </div>
          </div>
          {copy()}
        </div>
        <div className={s.linkCaption}>
          <span>{accessSentence(access, { workspaceName })}</span>
          {encrypted && <span className={s.linkCaptionKey}>The part after # never reaches a server</span>}
        </div>
      </div>

      <div className={s.pubActions}>
        {onOpenFullScreen && <Button variant="secondary" size="md" iconLeft="expand" onClick={onOpenFullScreen}>Open full screen</Button>}
        <Button variant="secondary" size="md" iconLeft="qr" aria-expanded={qr} aria-controls={qr ? qrId : undefined} onClick={() => setQr((q) => !q)}>
          {qr ? "Hide QR code" : "Show QR code"}
        </Button>
      </div>
      {qr && (
        <div id={qrId} className={s.pubQr}>
          <QRFrame value={shareUrl} size={152} label="Scan to open on a phone" caption={encrypted ? "The key is included." : "Point a phone camera at it."} expandable
            ariaLabel={encrypted ? "QR code for the full link, key included" : undefined} />
        </div>
      )}

      {(encrypted || workspaceShareFailed) && (
        <div className={s.pubAlerts}>
          {encrypted && <Alert tone="warning" title="The link is the key">Lose it and the document is gone — no recovery, by anyone.</Alert>}
          {workspaceShareFailed && <Alert tone="warning">Published, but couldn&apos;t add it to the workspace. You can share it from your dashboard.</Alert>}
        </div>
      )}

      {secret && (
        <SecretReveal value={secret} signedIn={signedIn} isOwner={isOwner} onCopy={onSecretCopied} onSaveToAccount={onSaveToAccount}
          saved={secretSaved} signInHref={signInHref} onSignIn={onSignIn} enterDelay={animate ? 1020 : undefined} />
      )}
    </section>
  );
}
