"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Dialog, Field, Input, announce } from "@/components/ui";
import { PublishSettings } from "@/components/kit/PublishSettings";
import {
  expiryInvalid,
  toApiExpiry,
  useIsClient,
  type PublishField,
  type PublishSettingsValue,
  type PublishWorkspace,
} from "@/components/kit/publish-utils";
import { useAuth } from "@/contexts/AuthContext";
import * as e2e from "@/lib/e2e";
import { MAX_CHARS } from "@/lib/limits";
import { track } from "@/lib/track";
import { useWorkspaceTargets } from "@/lib/useWorkspaceTargets";
import { shareToWorkspace } from "@/lib/workspaces";
import { failureOf, publishDocument, type PublishFailure } from "./publish";

const SLUG_PATTERN = /^[a-zA-Z0-9_-]*$/;
/**
 * Set when the document published but couldn't be filed into the chosen workspace, so the viewer
 * (which the author lands on next) can say so. Same key as /new (`components/new/NewEditor.tsx`).
 */
const WS_SHARE_FAILED_KEY = (slug: string) => `md_ws_share_failed:${slug}`;

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  onTitleChange: (title: string) => void;
  settings: PublishSettingsValue;
  onSettingsChange: (next: PublishSettingsValue) => void;
  /** The assembled README. */
  markdown: string;
  sectionCount: number;
}

/** "Publish README": the title + the shared PublishSettings (rows), primary "Publish" (D9). */
export default function PublishDialog({ open, onClose, title, onTitleChange, settings, onSettingsChange, markdown, sectionCount }: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const signedIn = !!user;
  const isClient = useIsClient();
  const titleId = useId();

  const [publishing, setPublishing] = useState(false);
  const [failure, setFailure] = useState<PublishFailure | null>(null);
  const [errors, setErrors] = useState<Partial<Record<PublishField, string>>>({});
  const [blockedUntil, setBlockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Workspaces load only for a signed-in author, once the dialog has been opened (this component
  // mounts with it); signed out there's nothing to ask for.
  const [workspaces, setWorkspaces] = useState<PublishWorkspace[]>([]);

  // The 429 countdown: ticks once a second while blocked.
  const secondsLeft = Math.max(0, Math.ceil((blockedUntil - now) / 1000));
  useEffect(() => {
    if (blockedUntil <= Date.now()) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= blockedUntil) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [blockedUntil]);
  useEffect(() => {
    if (failure?.kind === "rate" && blockedUntil && secondsLeft === 0) announce("You can publish again.");
  }, [failure, blockedUntil, secondsLeft]);

  const empty = !markdown.trim();
  const tooLong = markdown.length > MAX_CHARS;
  const blocked = secondsLeft > 0;

  function change(next: PublishSettingsValue, field: PublishField) {
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
    onSettingsChange(next);
  }

  function validate(): Partial<Record<PublishField, string>> {
    const out: Partial<Record<PublishField, string>> = {};
    const slug = settings.slug.trim();
    if (slug && !SLUG_PATTERN.test(slug)) out.slug = "Use letters, numbers, hyphens and underscores only.";
    else if (slug && slug.length < 3) out.slug = "Use at least 3 characters, or leave it blank for a random link.";
    if (expiryInvalid(settings.expires)) out.expires = "That time has passed. Pick a time in the future.";
    return out;
  }

  async function publish() {
    if (publishing || blocked || empty || tooLong) return;
    const v = validate();
    setErrors(v);
    if (Object.keys(v).length) {
      announce("Check the highlighted settings.");
      return;
    }
    setPublishing(true);
    setFailure(null);
    try {
      // Seal before anything leaves the tab; the key only ever travels in the link's fragment.
      let body = markdown;
      let keyFragment = "";
      let encodedKey = "";
      if (settings.encrypt) {
        const key = await e2e.generateKey();
        body = await e2e.seal(key, { title: title.trim() || null, content: markdown });
        encodedKey = await e2e.exportKey(key);
        keyFragment = `#k=${encodedKey}`;
      }
      const { expiresIn, customExpiresAt } = toApiExpiry(settings.expires);
      const doc = await publishDocument(title, body, {
        customSlug: settings.slug.trim() || undefined,
        expiresIn,
        customExpiresAt,
        readPassword: settings.password || undefined,
        encrypted: settings.encrypt || undefined,
        accessLevel: settings.access,
      });
      track("builder_published", { sections: sectionCount });
      // The edit secret lives in this tab only, never in the URL.
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);
      // Filing into a workspace is a second step (the library enforces its own rules); a failure
      // must not lose the published document, so it's carried to the page the author lands on.
      if (settings.target.workspaceId && doc.id) {
        try {
          await shareToWorkspace(settings.target.workspaceId, doc.id, settings.target.folderId);
        } catch {
          try {
            sessionStorage.setItem(WS_SHARE_FAILED_KEY(doc.slug), "1");
          } catch {
            /* ignore */
          }
        }
      }
      if (encodedKey) e2e.rememberKey(doc.slug, encodedKey);
      // The fragment survives a client-side push and never reaches a server.
      router.push(`/${doc.slug}?new=1${keyFragment}`);
      // Stay in the publishing state until the route changes.
    } catch (err) {
      const f: PublishFailure =
        err instanceof e2e.TooLargeError
          ? { kind: "other", message: "This README is too large to encrypt. Remove a section or turn encryption off." }
          : failureOf(err);
      setPublishing(false);
      if (f.kind === "slug") {
        setErrors((e) => ({ ...e, slug: f.message }));
        announce(f.message);
        return;
      }
      if (f.kind === "rate") {
        const n = Date.now();
        setNow(n);
        setBlockedUntil(n + (f.retryAfter ?? 60) * 1000);
        announce(f.retryAfter ? `Too many tries in a short time. Wait ${f.retryAfter} seconds and try again.` : "Too many tries in a short time. Wait a minute and try again.");
      }
      setFailure(f);
    }
  }

  const busyLabel = settings.encrypt ? "Encrypting in your browser…" : "Publishing…";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!publishing}
      title="Publish README"
      description={`${sectionCount} ${sectionCount === 1 ? "section" : "sections"}, published as one document.`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={publishing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            iconLeft={publishing ? undefined : "globe"}
            loading={publishing}
            onClick={publish}
            aria-disabled={blocked || empty || tooLong || undefined}
          >
            {publishing ? busyLabel : blocked ? `Publish in ${secondsLeft}s` : "Publish"}
          </Button>
        </>
      }
    >
      <form
        className="flex min-w-0 flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void publish();
        }}
      >
        <Field label="Title" htmlFor={titleId} hint={settings.encrypt ? "Encrypted with the README, so only people with the link can read it." : "Readers see it as the page title."}>
          <Input
            id={titleId}
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="README title (optional)"
            maxLength={200}
            disabled={publishing}
            dir="auto"
          />
        </Field>

        {signedIn && <WorkspaceTargets target={settings.target} onChange={setWorkspaces} />}
        <PublishSettings
          layout="rows"
          eyebrow={null}
          value={settings}
          onChange={change}
          signedIn={signedIn}
          workspaces={signedIn ? workspaces : []}
          e2eSupported={!isClient || e2e.isSupported()}
          errors={errors}
          disabled={publishing}
        />

        {/* Enter in a text field publishes. */}
        <button type="submit" hidden tabIndex={-1} aria-hidden />

        {empty && (
          <Alert tone="info" title="Nothing to publish yet">
            Add a section, or write something in one, first.
          </Alert>
        )}
        {tooLong && (
          <Alert tone="danger" title="This README is too long to publish">
            It&apos;s {markdown.length.toLocaleString()} characters; the limit is {MAX_CHARS.toLocaleString()}. Remove a section or shorten one.
          </Alert>
        )}
        {failure?.kind === "rate" && (
          <Alert tone="warning" title="Too many tries in a short time" live>
            {blocked
              ? failure.retryAfter
                ? `Wait ${secondsLeft} seconds and try again.`
                : `Wait a minute and try again (${secondsLeft}s).`
              : "You can try again now."}
          </Alert>
        )}
        {failure?.kind === "offline" && (
          <Alert tone="danger" title="Couldn't publish">
            You seem to be offline. Your text is still here.
          </Alert>
        )}
        {failure?.kind === "other" && (
          <Alert tone="danger" title="Couldn't publish">
            {failure.message}
          </Alert>
        )}
      </form>
    </Dialog>
  );
}

/** Loads the workspaces this person may publish into (and the chosen one's folders). Renders nothing. */
function WorkspaceTargets({ target, onChange }: { target: PublishSettingsValue["target"]; onChange: (w: PublishWorkspace[]) => void }) {
  const ws = useWorkspaceTargets(target);
  useEffect(() => {
    onChange(
      ws.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        host: w.primary_host,
        folders: w.id === target.workspaceId ? ws.folders.map((f) => ({ id: f.id, name: f.name, path: f.path })) : undefined,
      })),
    );
  }, [ws.workspaces, ws.folders, target.workspaceId, onChange]);
  return null;
}
