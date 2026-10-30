"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Button, Card, ConfirmDialog, CopyButton, Dialog, EmptyState, Field, Input, RowMenu,
  Skeleton, Table, VSCodeIcon, useToast, type Column,
} from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import { VSCODE_URL } from "@/components/shell/links";
import { ReadMore } from "@/components/ReadMore";
import { createApiToken, listApiTokens, revokeApiToken, type ApiTokenItem } from "@/lib/api";
import { SettingsLoader, shortDate, useRequireUser } from "../settings-shared";

/** "Done" unlocks after a copy, or after this long (REVAMP_PLAN 7.11). */
const DONE_DELAY_MS = 3000;

function masked(t: ApiTokenItem) {
  return `${t.prefix}••••`;
}

/** /settings/tokens: create, list and revoke API tokens (the VS Code extension's credentials). */
export default function TokensClient() {
  const { ready } = useRequireUser("/settings/tokens");
  const toast = useToast();
  const [tokens, setTokens] = useState<ApiTokenItem[] | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [canClose, setCanClose] = useState(false);
  const doneRef = useRef<HTMLButtonElement>(null);

  const [revoking, setRevoking] = useState<ApiTokenItem | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await listApiTokens());
    } catch {
      setTokens((t) => t ?? []);
      toast.error("Couldn't load your tokens. Refresh the page to try again.");
    }
  }, [toast]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  // The fresh token dialog can't be dismissed until the token was copied or 3s have passed.
  useEffect(() => {
    if (!fresh) return;
    setCanClose(false);
    const t = setTimeout(() => setCanClose(true), DONE_DELAY_MS);
    return () => clearTimeout(t);
  }, [fresh]);

  if (!ready) return <SettingsLoader />;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim() || "API token";
    setCreating(true);
    try {
      const t = await createApiToken(name);
      setCreateOpen(false);
      setNewName("");
      setFresh({ name: t.name || name, token: t.token });
      load();
    } catch {
      toast.error("Couldn't create the token. Check your connection and try again.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke() {
    const t = revoking;
    if (!t) return;
    try {
      await revokeApiToken(t.id);
      setTokens((list) => (list ?? []).filter((x) => x.id !== t.id));
      toast.success(`Revoked "${t.name}".`);
    } catch {
      toast.error(`Couldn't revoke "${t.name}". Try again.`);
    }
    setRevoking(null);
  }

  const menu = (t: ApiTokenItem) => (
    <RowMenu
      portal
      align="right"
      label={`More actions for ${t.name}`}
      items={[{ label: "Revoke", icon: "trash", danger: true, onClick: () => setRevoking(t) }]}
    />
  );

  const lastUsed = (t: ApiTokenItem) =>
    t.last_used_at ? shortDate(t.last_used_at) : <span className="text-text-muted">Never</span>;

  const columns: Column<ApiTokenItem>[] = [
    { key: "name", header: "Name", primary: true, render: (t) => <span className="[overflow-wrap:anywhere]" dir="auto">{t.name}</span> },
    { key: "token", header: "Token", render: (t) => <code className="font-mono text-code text-text-secondary">{masked(t)}</code> },
    { key: "created", header: "Created", render: (t) => shortDate(t.created_at) },
    { key: "used", header: "Last used", render: lastUsed },
    { key: "menu", header: <span className="md-visually-hidden">Actions</span>, align: "right", width: 56, render: menu },
  ];

  const createButton = (
    <Button variant="primary" iconLeft="plus" onClick={() => setCreateOpen(true)}>
      Create token
    </Button>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="API tokens"
        description={
          <>
            Tokens let the Markdrop VS Code extension and the API act as you. Keep them secret; revoke anytime.{" "}
            <ReadMore topic="apiTokens" />
          </>
        }
        actions={tokens && tokens.length > 0 ? createButton : undefined}
      />

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_248px]">
        <section aria-label="Your tokens" className="min-w-0" aria-busy={tokens === null}>
          {tokens === null ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4" aria-hidden>
              {[0, 1, 2].map((i) => <Skeleton key={i} height={20} />)}
            </div>
          ) : tokens.length === 0 ? (
            <EmptyState
                icon="code"
                title="No tokens yet"
                description="Create one for each device or script, so you can revoke one without breaking the others."
                actions={createButton}
              />
          ) : (
            <>
              <Table<ApiTokenItem>
                className="hidden sm:block"
                columns={columns}
                rows={tokens}
                rowKey={(t) => t.id}
                hover={false}
                caption="API tokens"
              />
              {/* Phones: stacked rows instead of a sideways-scrolling table. */}
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface sm:hidden">
                {tokens.map((t) => (
                  <li key={t.id} className="flex min-w-0 items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-body-strong text-text [overflow-wrap:anywhere]" dir="auto">{t.name}</p>
                      <p className="mt-0.5 font-mono text-code text-text-secondary">{masked(t)}</p>
                      <p className="mt-1 text-caption text-text-muted">
                        Created {shortDate(t.created_at)} · Last used {t.last_used_at ? shortDate(t.last_used_at) : "never"}
                      </p>
                    </div>
                    {menu(t)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <Card title="Connect VS Code" compact>
          <div className="flex min-w-0 flex-col gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-surface-inset text-cat-sync" aria-hidden>
              <VSCodeIcon size={20} />
            </span>
            <p className="text-caption text-text-secondary">
              Install Markdrop Sync, run <strong className="font-semibold text-text">Markdrop: Sign in</strong>, and
              approve in the browser. We create the token for you. <ReadMore topic="vscode" />
            </p>
            <Button variant="secondary" size="sm" href={VSCODE_URL} target="_blank" rel="noreferrer noopener" iconRight="external">
              Get the extension
            </Button>
          </div>
        </Card>
      </div>

      <Dialog
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        dismissible={!creating}
        title="Create token"
        description="Name it after the device or script that will use it."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            <Button variant="primary" type="submit" form="create-token" loading={creating}>Create token</Button>
          </>
        }
      >
        <form id="create-token" onSubmit={create}>
          <Field label="Name">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} placeholder="My laptop" autoComplete="off" />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={!!fresh}
        onClose={() => canClose && setFresh(null)}
        dismissible={canClose}
        hideClose={!canClose}
        title="Copy your token now"
        description={fresh ? `For "${fresh.name}". Paste it into the VS Code extension or your script.` : undefined}
        initialFocus={doneRef}
        size="md"
        footer={
          <Button ref={doneRef} variant="primary" disabled={!canClose} onClick={() => setFresh(null)}>
            Done
          </Button>
        }
      >
        {fresh && (
          <div className="flex min-w-0 flex-col gap-4">
            <Alert tone="warning">This is the only time the full token is shown.</Alert>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <Input
                mono
                readOnly
                value={fresh.token}
                aria-label="Your new token"
                wrapClassName="min-w-0 flex-1"
                onFocus={(e) => e.currentTarget.select()}
              />
              <CopyButton
                text={fresh.token}
                label="Copy token"
                copiedLabel="Copied"
                variant="secondary"
                announceText="Token copied"
                onCopy={() => setCanClose(true)}
              />
            </div>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        title={revoking ? `Revoke "${revoking.name}"?` : "Revoke token?"}
        body="Any VS Code extension using this token will stop syncing. This cannot be undone."
        confirmLabel="Revoke token"
      />
    </div>
  );
}
