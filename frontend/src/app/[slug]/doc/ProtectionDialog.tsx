"use client";

import { Button, Dialog, Icon } from "@/components/ui";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { PBKDF2_ITERATIONS, inspect } from "@/lib/e2e";
import type { KeySource } from "./useDocumentViewer";

/**
 * "How this is protected" (the encrypted reader's menu, the E2E badge, the Details card): what this
 * document's envelope actually is, read from the envelope itself — format, algorithms, where the key
 * came from — and the first bytes of what our servers store, so the claim can be checked against
 * the network tab. Nothing here is sent anywhere.
 */
export function ProtectionDialog({
  open, onClose, sealed, keySource, deviceKeySaved, onRemember, onForget,
}: {
  open: boolean;
  onClose: () => void;
  sealed: string | null;
  keySource: KeySource | null;
  deviceKeySaved: boolean;
  onRemember?: () => void;
  onForget?: () => void;
}) {
  const info = sealed ? inspect(sealed) : null;
  const v2 = info?.version === 2;
  const withPassword = info?.mode === "password";
  const stored = sealed ? `${sealed.slice(0, 44)}…` : "";
  const keyFrom =
    keySource === "device" ? "the copy saved in this browser"
    : keySource === "pasted" ? "the link you pasted"
    : "the link (the part after #)";

  const rows: Array<{ icon: string; title: string; body: React.ReactNode }> = [
    {
      icon: "key",
      title: "The key never left this browser",
      body: (
        <>
          It came from {keyFrom}. Browsers don&apos;t send that part of a link to servers, and this page never does.
          {withPassword && " The password was checked here too; our servers never saw it."}
        </>
      ),
    },
    {
      icon: "lock",
      title: "Encryption",
      body: v2 ? (
        <>
          AES-256-GCM, with the header authenticated too. Keys derived with HKDF-SHA256 and a fresh random salt on every save;
          a key commitment (HMAC-SHA256) is checked before decrypting.
          {withPassword && ` The password goes through PBKDF2-SHA256, ${PBKDF2_ITERATIONS.toLocaleString("en-US")} rounds.`}
          {" "}The text is padded to 512-byte steps, so its exact length doesn&apos;t show.
        </>
      ) : (
        <>
          AES-256-GCM with the link&apos;s key (the original format). The next save upgrades it to the current format under
          the same link.
        </>
      ),
    },
    {
      icon: "server",
      title: "What our servers store",
      body: (
        <>
          Only the encrypted text{info ? ` (${info.storedLength.toLocaleString("en-US")} characters)` : ""}, which starts:
          <code className="mt-1.5 block break-all rounded-md border border-border bg-surface-inset px-2 py-1.5 font-mono text-code text-text">
            {stored}
          </code>
        </>
      ),
    },
    {
      icon: "info",
      title: "Not encrypted",
      body: "The link name, the size, the dates and the view count. And this page's code comes from Markdrop, so you're trusting that code to do what this says.",
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="How this document is protected"
      description={info ? `Format ${v2 ? "mdx2" : "mdx1"}${withPassword ? " · link + password" : " · link key"}` : undefined}
      footer={
        <>
          <Button variant="ghost" href={docsUrl(DOCS_PAGES.encryption)} iconRight="external" target="_blank" rel="noopener">
            How encryption works
          </Button>
          <Button variant="secondary" onClick={onClose}>Done</Button>
        </>
      }
    >
      <ul className="flex flex-col gap-4">
        {rows.map((r) => (
          <li key={r.title} className="flex gap-3">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text" aria-hidden>
              <Icon name={r.icon} />
            </span>
            <div className="min-w-0">
              <p className="text-body-strong text-text">{r.title}</p>
              <div className="text-caption text-text-secondary">{r.body}</div>
            </div>
          </li>
        ))}
      </ul>
      {(onRemember || onForget) && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
          <p className="text-caption text-text-secondary">
            {deviceKeySaved ? "This browser keeps the key, so the document opens here without the link." : "This browser doesn't keep the key."}
          </p>
          {deviceKeySaved
            ? onForget && <Button size="sm" variant="secondary" onClick={onForget}>Forget on this device</Button>
            : onRemember && <Button size="sm" variant="secondary" onClick={onRemember}>Remember on this device</Button>}
        </div>
      )}
    </Dialog>
  );
}
