"use client";

import { useEffect, useRef, useState } from "react";
import {
  Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Drawer, EmptyState, Field, Icon,
  Input, Kbd, Select, Switch, Tabs,
} from "@/components/ui";
import { EditorFrame } from "@/components/kit/EditorFrame";
import { DateTimePicker } from "@/components/kit/DateTimePicker";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import MarkdownPreview from "@/components/MarkdownPreview";
import MarkdownToolbar from "@/components/MarkdownToolbar";
import { MAX_CHARS } from "@/lib/limits";
import type { ExpiresIn } from "@/lib/api";
import type { useDocumentViewer, ViewMode } from "./useDocumentViewer";

type Viewer = ReturnType<typeof useDocumentViewer>;

/**
 * Secret unlock (REVAMP_PLAN 7.6 "Edit flow"): a 400px card with a key tile, "Enter your edit
 * secret", a mono field and "Unlock editor". Same handlers as before (handleUnlock /
 * handleCancelEdit).
 */
export function SecretUnlock({ v }: { v: Viewer }) {
  return (
    <div className="mx-auto w-full max-w-[400px] px-4 py-12 sm:py-16">
      <Card>
        <form onSubmit={v.handleUnlock} className="flex flex-col gap-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-h4 text-accent-text" aria-hidden>
            <Icon name="key" />
          </span>
          <h1 className="text-h3 text-text">Enter your edit secret</h1>
          <Field
            label="Edit secret"
            hint="It starts with sk_ and was shown when you published."
            error={v.secretError || undefined}
          >
            <Input
              mono
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={v.secretInput}
              onChange={(e) => v.setSecretInput(e.target.value)}
              placeholder="sk_…"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Unlock editor</Button>
            <Button type="button" variant="ghost" onClick={v.handleCancelEdit}>Cancel</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

const EXPIRY_OPTIONS: { value: ExpiresIn | ""; label: string }[] = [
  { value: "", label: "No change" },
  { value: "never", label: "Remove expiry" },
  { value: "1d", label: "Expire in 1 day" },
  { value: "7d", label: "Expire in 7 days" },
  { value: "30d", label: "Expire in 30 days" },
  { value: "custom", label: "On a date…" },
];

/**
 * The editor (REVAMP_PLAN 7.6 "Edit flow"; Editor board look): a bar with the title, "Unsaved
 * changes", Settings (Drawer), Cancel and the save button; pill tabs Write / Split / Preview; the
 * toolbar and an EditorFrame; a status bar with the characters left and ⌘S. Cancel or Escape
 * while dirty asks "Discard your changes?". Every save/delete path is the hook's, unchanged.
 */
export function EditorScreen({ v, isPasswordProtected, encrypted, displayTitle, displayContent }: {
  v: Viewer;
  isPasswordProtected: boolean;
  encrypted: boolean;
  displayTitle: string | null;
  displayContent: string;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const saveRef = useRef(v.handleSave);
  saveRef.current = v.handleSave;

  const settingsDirty = !!(v.editNewPassword || v.editRemovePassword || v.editExpiresIn || v.rotateKey);
  const dirty =
    (v.canEditContent && (v.editTitle !== (displayTitle || "") || v.editContent !== displayContent)) || settingsDirty;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  function requestCancel() {
    if (dirtyRef.current) setConfirmDiscard(true);
    else v.handleCancelEdit();
  }
  const cancelRef = useRef(requestCancel);
  cancelRef.current = requestCancel;

  // ⌘S / Ctrl+S saves; Escape (when no overlay took it) cancels, asking first if dirty.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (!v.saving) saveRef.current();
        return;
      }
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        cancelRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [v.saving]);

  // Split needs width; phones get Write / Preview only (as before).
  const modes: ViewMode[] = phone ? ["write", "preview"] : ["write", "split", "preview"];
  const mode: ViewMode = phone && v.viewMode === "split" ? "write" : v.viewMode;
  const saveLabel = v.saving ? "Saving…" : v.canEditContent ? (v.rotateKey ? "Save with new key" : "Save changes") : "Save settings";
  const nearLimit = v.remaining < 1000;

  const textareaCls =
    "block h-full min-h-[50dvh] w-full resize-none bg-transparent p-4 font-mono text-code text-text outline-none placeholder:text-text-muted";

  return (
    <div className="mx-auto flex w-full max-w-marketing flex-col gap-3 px-4 py-4 sm:px-6">
      <h1 className="md-visually-hidden">Edit {displayTitle || "document"}</h1>

      {/* Bar */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <Input
          aria-label="Title"
          value={v.editTitle}
          onChange={(e) => v.setEditTitle(e.target.value)}
          placeholder={v.canEditContent ? "Document title (optional)" : "Title is encrypted"}
          maxLength={200}
          disabled={!v.canEditContent}
          dir="auto"
          wrapClassName="min-w-0 flex-1 basis-60"
          className="min-w-0 flex-1 basis-60 text-body-strong"
        />
        <div className="flex flex-wrap items-center gap-2">
          {dirty && <Badge tone="warning" dot size="sm">Unsaved changes</Badge>}
          {v.canEditSettings && <Button variant="ghost" iconLeft="settings" onClick={() => setSettingsOpen(true)}>Settings</Button>}
          <Button variant="ghost" onClick={requestCancel}>Cancel</Button>
          <Button
            onClick={v.handleSave}
            loading={v.saving}
            disabled={v.canEditContent && !v.editContent.trim()}
          >
            {saveLabel}
          </Button>
        </div>
      </div>

      {v.saveError && <Alert tone="danger">{v.saveError}</Alert>}
      {v.sessionEditor && !v.canEditSettings && (
        <p className="text-caption text-text-muted">You can edit the text. Its password, expiry, link and who can open it stay with its owner.</p>
      )}

      {/* No key: the editor would be an empty box, which reads as "your document
          is gone" and invites someone to retype it over the top. Say what is
          actually true and leave the settings usable. */}
      {!v.canEditContent ? (
        <div className="rounded-xl border border-dashed border-border-strong py-6">
          <EmptyState
            icon="key"
            title="The text can't be edited without the key"
            description={
              <>
                Your document is still here and still intact — it just can&apos;t be read or rewritten
                from this browser. Open it with its full link, the one ending in{" "}
                <span className="font-mono">#k=…</span>, and editing comes back. Expiry, password and
                deletion in Settings don&apos;t need the key, so those still work.
              </>
            }
            actions={v.canEditSettings ? <Button variant="secondary" iconLeft="settings" onClick={() => setSettingsOpen(true)}>Open settings</Button> : undefined}
          />
        </div>
      ) : (
        <>
          <Tabs
            variant="pill"
            size="sm"
            aria-label="Editor view"
            idPrefix="md-edit"
            value={mode}
            onChange={(m) => v.setViewMode(m as ViewMode)}
            items={modes.map((m) => ({ value: m, label: m.charAt(0).toUpperCase() + m.slice(1) }))}
            className="no-print self-start"
          />
          <div role="tabpanel" id={`md-edit-panel-${mode}`} aria-labelledby={`md-edit-tab-${mode}`} className="min-w-0">
            {mode === "write" && (
              <EditorFrame
                tab={`${v.editTitle.trim() || "document"}.md`}
                toolbar={<MarkdownToolbar textareaRef={v.activeTextareaRef} onChange={v.setEditContent} bare />}
                status={<EditorStatus remaining={v.remaining} nearLimit={nearLimit} />}
              >
                <textarea
                  ref={v.writeTextareaRef}
                  aria-label="Markdown"
                  value={v.editContent}
                  onChange={(e) => v.setEditContent(e.target.value)}
                  autoFocus
                  maxLength={MAX_CHARS}
                  spellCheck
                  className={textareaCls}
                />
              </EditorFrame>
            )}
            {mode === "split" && (
              <div className="grid min-h-[60dvh] grid-cols-2 gap-3">
                <EditorFrame
                  tab="Markdown"
                  toolbar={<MarkdownToolbar textareaRef={v.activeTextareaRef} onChange={v.setEditContent} bare />}
                  status={<EditorStatus remaining={v.remaining} nearLimit={nearLimit} />}
                  className="min-w-0"
                >
                  <textarea
                    ref={v.textareaRef}
                    aria-label="Markdown"
                    value={v.editContent}
                    onChange={(e) => v.setEditContent(e.target.value)}
                    onScroll={v.syncScroll}
                    autoFocus
                    maxLength={MAX_CHARS}
                    className={`${textareaCls} h-[60dvh] overflow-y-auto`}
                  />
                </EditorFrame>
                <div
                  ref={v.previewRef}
                  tabIndex={0}
                  aria-label="Preview"
                  className="md-focus h-[calc(60dvh+5rem)] min-w-0 overflow-y-auto rounded-xl border border-border bg-bg p-5"
                >
                  {v.editContent.trim()
                    ? <MarkdownPreview content={v.editContent} />
                    : <p className="text-body text-text-muted">Preview will appear here.</p>}
                </div>
              </div>
            )}
            {mode === "preview" && (
              <div className="min-h-[50dvh] rounded-xl border border-border bg-bg p-4 sm:p-8">
                {v.editContent.trim()
                  ? <MarkdownPreview content={v.editContent} size="reading" className="mx-auto max-w-reading" />
                  : <p className="text-body text-text-muted">Nothing to preview yet.</p>}
              </div>
            )}
          </div>
        </>
      )}

      {/* Settings: password, expiry, a new key, and the danger zone. */}
      <Drawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Document settings"
        description="Saved with the document when you press Save."
        side={phone ? "bottom" : "right"}
        footer={<Button variant="secondary" onClick={() => setSettingsOpen(false)}>Done</Button>}
      >
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <h3 className="text-eyebrow text-text-muted">Password</h3>
            {isPasswordProtected ? (
              <Checkbox
                label="Remove password"
                description="Anyone with the link can open it again."
                checked={v.editRemovePassword}
                onChange={(e) => v.setEditRemovePassword(e.target.checked)}
              />
            ) : (
              <Field label="Add a password" hint="Readers are asked for this before the document opens.">
                <Input
                  type={v.editShowPassword ? "text" : "password"}
                  value={v.editNewPassword}
                  onChange={(e) => v.setEditNewPassword(e.target.value)}
                  maxLength={100}
                  autoComplete="new-password"
                  suffix={v.editNewPassword ? (
                    <button
                      type="button"
                      className="md-focus grid h-8 w-8 place-items-center rounded-md text-text-muted hover:text-text"
                      aria-label={v.editShowPassword ? "Hide password" : "Show password"}
                      aria-pressed={v.editShowPassword}
                      onClick={() => v.setEditShowPassword((s: boolean) => !s)}
                    >
                      <Icon name={v.editShowPassword ? "eyeOff" : "eye"} />
                    </button>
                  ) : undefined}
                />
              </Field>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-eyebrow text-text-muted">Expiry</h3>
            <Field label="Expires">
              <Select
                value={v.editExpiresIn}
                onChange={(e) => v.setEditExpiresIn(e.target.value as ExpiresIn | "")}
                options={EXPIRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </Field>
            {v.editExpiresIn === "custom" && (
              <DateTimePicker
                value={v.editCustomExpiresAt || null}
                onChange={(iso) => v.setEditCustomExpiresAt(iso)}
                hint="The link stops working then."
              />
            )}
          </section>

          {/* Rotation needs the current key: the document has to be decrypted
              before it can be re-encrypted under a new one. */}
          {encrypted && v.canEditContent && (
            <section className="flex flex-col gap-2">
              <h3 className="text-eyebrow text-text-muted">Encryption</h3>
              <Switch
                checked={v.rotateKey}
                onChange={(e) => v.setRotateKey(e.target.checked)}
                label={
                  <span className="flex flex-col">
                    <span className="text-body text-text">Issue a new key</span>
                    <span className="text-caption text-text-muted">
                      The old link stops working. Anyone who already read it keeps what they read.
                    </span>
                  </span>
                }
              />
            </section>
          )}

          <section className="flex flex-col gap-3 rounded-xl border border-danger p-4">
            <h3 className="text-eyebrow text-danger">Danger zone</h3>
            <p className="text-caption text-text-secondary">
              Deleting removes the document and its link for everyone.
            </p>
            <Button variant="danger" iconLeft="trash" onClick={() => v.setShowDeleteConfirm(true)} className="self-start">
              Delete document
            </Button>
          </section>
        </div>
      </Drawer>

      <ConfirmDialog
        open={v.showDeleteConfirm}
        onClose={() => { if (!v.deleting) v.setShowDeleteConfirm(false); }}
        onConfirm={v.handleDelete}
        busy={v.deleting}
        title="Delete this document?"
        body="The link stops working for everyone, immediately. This can't be undone."
        confirmLabel="Delete document"
      />

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => { setConfirmDiscard(false); v.handleCancelEdit(); }}
        title="Discard your changes?"
        body="Your edits in this tab will be lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
      />
    </div>
  );
}

function EditorStatus({ remaining, nearLimit }: { remaining: number; nearLimit: boolean }) {
  return (
    <>
      <span className={`tabular-nums ${nearLimit ? "text-warning" : ""}`}>
        {remaining.toLocaleString()} characters left
      </span>
      <span className="ml-auto inline-flex items-center gap-1.5">
        <Kbd>⌘S</Kbd> to save
      </span>
    </>
  );
}

