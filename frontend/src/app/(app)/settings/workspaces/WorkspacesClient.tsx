"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge, Breadcrumb, Button, Dialog, EmptyState, Field, Icon, Input, Skeleton, useToast,
} from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import { BrowserFrame } from "@/components/kit/BrowserFrame";
import { BrandTile, type BrandingWithWell } from "@/components/workspace/BrandTile";
import { createWorkspace, listWorkspaces, type Workspace } from "@/lib/workspaces";
import { track } from "@/lib/track";
import { SettingsLoader, plural, shortDate, useRequireUser } from "../settings-shared";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Can edit", viewer: "Can view" };

/** /settings/workspaces (REVAMP_PLAN 7.12): a grid of workspace cards, or the empty state. */
export default function WorkspacesClient() {
  const { ready } = useRequireUser("/settings/workspaces");
  const router = useRouter();
  const toast = useToast();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listWorkspaces()
      .then(setWorkspaces)
      .catch(() => {
        setWorkspaces((w) => w ?? []);
        toast.error("Couldn't load your workspaces. Refresh the page to try again.");
      });
  }, [toast]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  if (!ready) return <SettingsLoader />;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError("Give the workspace a name."); return; }
    setBusy(true);
    setError("");
    try {
      const w = await createWorkspace(n);
      track("workspace_created");
      // Straight into the new workspace: its "Get set up" checklist and drop zone.
      router.push(`/w/${encodeURIComponent(w.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the workspace. Try again.");
      setBusy(false);
    }
  }

  const newButton = (block?: boolean) => (
    <Button variant="primary" iconLeft="plus" block={block} onClick={() => { setOpen(true); setError(""); }}>
      New workspace
    </Button>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        breadcrumb={<Breadcrumb items={[{ label: "Settings", href: "/settings" }, { label: "Workspaces" }]} />}
        title="Workspaces"
        description="A workspace holds your own domains, branding and team. Documents outside a workspace keep working exactly as they do now."
        actions={workspaces && workspaces.length > 0 ? <span className="hidden sm:inline-flex">{newButton()}</span> : undefined}
      />

      {workspaces && workspaces.length > 0 && <div className="sm:hidden">{newButton(true)}</div>}

      {workspaces === null ? (
        <div className="grid gap-4 sm:grid-cols-2" aria-busy="true" aria-label="Loading workspaces">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5" aria-hidden>
              <Skeleton variant="rect" width={40} height={40} />
              <Skeleton width="60%" height={18} />
              <Skeleton width="40%" />
            </div>
          ))}
        </div>
      ) : workspaces.length === 0 ? (
        <div className="grid min-w-0 items-center gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
          <EmptyState
            icon="globe"
            title="Serve documents from your own domain"
            description="Create a workspace to add your domain, logo and team. Documents you don't share into it stay private."
            actions={newButton()}
          />
          <BrowserFrame
            size="sm"
            url={{ host: "docs.example.com", slug: "quarterly-plan" }}
            urlIcon="globe"
            role="img"
            aria-label="Illustration: a document served at docs.example.com/quarterly-plan"
            bodyClassName="px-4 py-4"
          >
            <div className="flex flex-col gap-2" aria-hidden>
              <div className="flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-sm bg-accent text-micro font-bold text-on-accent">A</span>
                <span className="text-caption font-semibold text-text">Acme Docs</span>
              </div>
              <p className="mt-1 text-body-strong text-text">Quarterly plan</p>
              <Skeleton width="92%" height={8} />
              <Skeleton width="84%" height={8} />
              <Skeleton width="60%" height={8} />
            </div>
          </BrowserFrame>
        </div>
      ) : (
        <ul className="grid min-w-0 gap-4 sm:grid-cols-2">
          {workspaces.map((w) => {
            const b = w.branding as BrandingWithWell;
            return (
              <li key={w.id} className="min-w-0">
                <Link
                  href={`/settings/workspaces/${w.id}`}
                  className="md-card md-card--interactive flex h-full min-w-0 flex-col gap-4 p-5 no-underline"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <BrandTile name={w.name} logoUrl={b.logo_url} logoWell={b.logo_well} accent={b.accent_color} size={40} />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-h4 text-text" dir="auto">{w.name}</h2>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge size="sm" tone={w.role === "owner" ? "info" : "neutral"} icon="user">{ROLE_LABEL[w.role] ?? w.role}</Badge>
                      </div>
                    </div>
                    <Icon name="chevronRight" className="mt-2 shrink-0 text-text-muted" />
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {w.primary_host ? (
                      <>
                        <span className="min-w-0 truncate font-mono text-code text-text-secondary">{w.primary_host}</span>
                        <Badge size="sm" tone="success" dot>Live</Badge>
                      </>
                    ) : (
                      <Badge size="sm" tone="neutral" icon="globe">No domain yet</Badge>
                    )}
                  </div>
                  <p className="mt-auto flex flex-wrap items-center gap-x-1.5 border-t border-border pt-3 text-caption text-text-muted">
                    {/* The list endpoint leaves the counts at 0 (only the detail fills them), and a
                        workspace always has its owner, so 0 means "not counted here", not "empty". */}
                    {w.member_count > 0 && (
                      <>
                        <Icon name="users" size={14} />
                        {plural(w.member_count, "member")}
                        {w.pending_invite_count > 0 && <> · {w.pending_invite_count} invited</>}
                        {" · "}
                      </>
                    )}
                    Created {shortDate(w.created_at)}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        dismissible={!busy}
        title="New workspace"
        description="You can add a domain, logo and people next."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" form="new-workspace" loading={busy}>Create workspace</Button>
          </>
        }
      >
        <form id="new-workspace" onSubmit={create} noValidate>
          <Field label="Name" error={error || undefined}>
            <Input value={name} onChange={(e) => { setName(e.target.value); if (error) setError(""); }} maxLength={80} placeholder="Acme Docs" autoComplete="organization" />
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
