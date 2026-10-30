"use client";

import { useRef } from "react";
import { Alert, Button, Checkbox, Drawer, Field, FileIcon, Input, Progress, Select, type FileRenderer } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { DateTimePicker } from "@/components/kit/DateTimePicker";
import { formatBytes } from "@/components/ArtifactBadge";
import type { ExpiresIn } from "@/lib/api";

export interface ArtifactSettingsState {
  title: string;
  slug: string;
  password: string;
  removePassword: boolean;
  expiry: ExpiresIn | "";
  customExpiresAt: string | null;
  file: File | null;
}

/**
 * Owner settings for an artifact (REVAMP_PLAN 7.7): a right Drawer with File (replace tile +
 * real upload Progress), Title, Link (prefix from the actual host), Password, Expiry and a danger
 * zone. Purely presentational: the view owns the state and the save order (file, settings, slug).
 *
 * `fileOnly` is the same drawer for someone who may replace the file but isn't the owner (an
 * editor, or a workspace member on a non-private file — `can.replace`): just the File tile.
 * Title, link, password, expiry and delete stay the owner's.
 */
export function ArtifactSettingsDrawer({
  open,
  onClose,
  value,
  onChange,
  currentSlug,
  linkPrefix,
  protectedNow,
  originalFilename,
  mime,
  fileRenderer,
  sizeBytes,
  busy,
  progress,
  error,
  onSave,
  onDelete,
  fileOnly = false,
}: {
  open: boolean;
  onClose: () => void;
  value: ArtifactSettingsState;
  onChange: (next: ArtifactSettingsState) => void;
  currentSlug: string;
  linkPrefix: string;
  protectedNow: boolean;
  originalFilename: string | null;
  mime: string;
  fileRenderer?: FileRenderer;
  sizeBytes: number;
  busy: boolean;
  progress: number;
  error: string;
  onSave: () => void;
  onDelete: () => void;
  fileOnly?: boolean;
}) {
  const replaceInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof ArtifactSettingsState>(k: K, v: ArtifactSettingsState[K]) => onChange({ ...value, [k]: v });
  const uploading = busy && progress > 0 && progress < 100;
  const slugShort = !!value.slug && value.slug.length < 3;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={fileOnly ? "Replace file" : "Artifact settings"}
      description={
        fileOnly
          ? <>Upload a new version. The link and its settings stay the same, and the space counts against the owner&apos;s storage. <ReadMore topic="versions" /></>
          : "Saved changes apply to the same link right away."
      }
      side="right"
      width={440}
      dismissible={!busy}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSave} loading={busy} disabled={fileOnly ? !value.file : slugShort}>
            {busy ? (uploading ? `Uploading ${progress}%` : "Saving…") : fileOnly ? "Replace file" : "Save changes"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {/* File: same link, new content. */}
        <div className="flex flex-col gap-2">
          <span className="text-body-strong text-text">File</span>
          <input
            ref={replaceInput}
            type="file"
            hidden
            onChange={(e) => {
              set("file", e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => replaceInput.current?.click()}
            disabled={busy}
            className="md-focus flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-3 py-2.5 text-left transition-colors duration-(--duration-fast) hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-inset">
              <FileIcon
                renderer={value.file ? undefined : fileRenderer}
                name={value.file?.name ?? originalFilename ?? ""}
                mime={value.file?.type ?? mime}
                size={18}
              />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span dir="auto" className="truncate text-body text-text">
                {value.file ? value.file.name : originalFilename || "Current file"}
              </span>
              <span className="text-caption text-text-muted">
                {value.file
                  ? `${formatBytes(value.file.size)} · Replaces the current file when you save`
                  : `${formatBytes(sizeBytes)} · Choose a file to replace it. The link stays the same.`}
              </span>
            </span>
          </button>
          {value.file && !busy && (
            <Button variant="link" size="sm" className="self-start" onClick={() => set("file", null)}>
              Keep the current file
            </Button>
          )}
          {busy && value.file && (
            <Progress
              value={progress}
              label={progress >= 100 ? "Publishing the new file…" : `Uploading ${value.file.name}`}
              showValue={progress < 100}
              indeterminate={progress >= 100 || progress === 0}
              valueText={progress >= 100 ? "Publishing" : `${progress}%`}
            />
          )}
        </div>

        {fileOnly ? (
          error && <Alert tone="danger">{error}</Alert>
        ) : (
          <>
            <Field label="Title" hint="Shown in the browser tab and in link previews.">
              <Input
                value={value.title}
                onChange={(e) => set("title", e.target.value)}
                maxLength={200}
                placeholder="Untitled"
                dir="auto"
                disabled={busy}
              />
            </Field>

            <Field
              label="Link"
              error={slugShort ? "Use at least 3 characters." : undefined}
              hint={
                value.slug !== currentSlug
                  ? "The old link stops working. Views and analytics carry over."
                  : "Letters, numbers, hyphens and underscores."
              }
            >
              <Input
                mono
                textPrefix={linkPrefix}
                value={value.slug}
                invalid={slugShort}
                onChange={(e) => /^[a-zA-Z0-9_-]*$/.test(e.target.value) && set("slug", e.target.value)}
                maxLength={50}
                disabled={busy}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              {protectedNow && !value.password ? (
                <div className="flex flex-col gap-2">
                  <span className="text-body-strong text-text">Password</span>
                  <Checkbox
                    label="Remove the password"
                    description="Anyone with the link can open it again."
                    checked={value.removePassword}
                    onChange={(e) => set("removePassword", e.currentTarget.checked)}
                    disabled={busy}
                  />
                  {!value.removePassword && (
                    <Input
                      type="password"
                      aria-label="New password"
                      placeholder="Or type a new one"
                      value={value.password}
                      onChange={(e) => set("password", e.target.value)}
                      maxLength={100}
                      disabled={busy}
                    />
                  )}
                </div>
              ) : (
                <Field label="Password" hint="Readers are asked for this before the page opens.">
                  <Input
                    type="password"
                    value={value.password}
                    onChange={(e) => set("password", e.target.value)}
                    maxLength={100}
                    placeholder={protectedNow ? "New password" : "Optional"}
                    disabled={busy}
                  />
                </Field>
              )}

              <Field label="Expires">
                <Select
                  value={value.expiry}
                  onChange={(e) => set("expiry", e.target.value as ExpiresIn | "")}
                  disabled={busy}
                  options={[
                    { value: "", label: "Leave unchanged" },
                    { value: "never", label: "Never" },
                    { value: "1d", label: "In 1 day" },
                    { value: "7d", label: "In 7 days" },
                    { value: "30d", label: "In 30 days" },
                    { value: "custom", label: "On a date…" },
                  ]}
                />
              </Field>
            </div>

            {value.expiry === "custom" && (
              <DateTimePicker
                value={value.customExpiresAt}
                onChange={(iso) => set("customExpiresAt", iso)}
                disabled={busy}
              />
            )}

            {error && <Alert tone="danger">{error}</Alert>}

            <section aria-labelledby="artifact-danger" className="flex flex-col gap-2 rounded-lg border border-border p-4">
              <h3 id="artifact-danger" className="m-0 text-body-strong text-text">
                Delete this artifact
              </h3>
              <p className="m-0 text-caption text-text-secondary">
                The file and its link are removed for good, and the space comes back to your storage.
              </p>
              <Button variant="danger" iconLeft="trash" className="self-start" onClick={onDelete} disabled={busy}>
                Delete artifact
              </Button>
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}

export default ArtifactSettingsDrawer;
