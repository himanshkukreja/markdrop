"use client";

/**
 * A shared folder on markdrop.in (D2). The server renders what a signed-out visitor may see; once
 * mounted, a signed-in reader's session is used to ask again, so a member sees the members-only
 * items too. The folder link never opens anything by itself: every row is a document the reader
 * could already open, linking to its canonical address.
 */
import { useEffect, useState } from "react";
import {
  Alert, Anchor, Breadcrumb, Button, EmptyState, FILE_KINDS, FileIcon, Icon, Skeleton, fileKind, type FileRenderer,
} from "@/components/ui";
import { useSignInHref } from "@/components/shell/useLocation";
import { useAuth } from "@/contexts/AuthContext";
import { getToken } from "@/lib/api";
import { fetchSharedFolder, type SharedFolderPage } from "@/lib/workspaces";
import { plural, relativeTime } from "@/components/dashboard/format";

type Status = 200 | 401 | 403 | 404;

const href = (shareId: string, path: string) =>
  `/f/${encodeURIComponent(shareId)}${path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : ""}`;

function formatSize(n: number | null | undefined): string | null {
  if (!n) return null;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export default function SharedFolderView({
  shareId, path, initial, initialStatus,
}: {
  shareId: string;
  path: string;
  initial: SharedFolderPage | null;
  initialStatus: Status;
}) {
  const { user, loading } = useAuth();
  const signInHref = useSignInHref();
  const [data, setData] = useState<SharedFolderPage | null>(initial);
  const [status, setStatus] = useState<Status>(initialStatus);
  const [checking, setChecking] = useState(initialStatus !== 200);
  const [error, setError] = useState(false);

  // Ask again as the signed-in reader (members see more; a members-only folder opens).
  useEffect(() => {
    if (loading) return;
    const token = getToken();
    if (!user || !token) { setChecking(false); return; }
    let live = true;
    setChecking(initialStatus !== 200);
    fetchSharedFolder(shareId, path, token)
      .then((r) => { if (!live) return; setStatus(r.status); setData(r.data); setError(false); })
      .catch(() => { if (live) setError(true); })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [user, loading, shareId, path, initialStatus]);

  if (status !== 200 || !data) {
    if (checking) {
      return (
        <div className="flex flex-col gap-4" aria-busy="true">
          <span className="md-visually-hidden">Opening the folder</span>
          <Skeleton width={160} />
          <Skeleton width={260} height={32} />
          {[0, 1, 2].map((i) => <Skeleton key={i} height={60} />)}
        </div>
      );
    }
    if (status === 401 && !user) {
      return (
        <>
          <h1 className="md-visually-hidden">Shared folder</h1>
          <EmptyState
            icon="lock"
            title="This folder is for members of a workspace"
            description="Sign in with the account you use in that workspace to see what's in it."
            actions={<Button variant="primary" href={signInHref} iconLeft="user">Sign in</Button>}
          />
        </>
      );
    }
    if (status === 401 || status === 403 || (status === 404 && user)) {
      return (
        <>
          <h1 className="md-visually-hidden">Shared folder</h1>
          <EmptyState
            icon="lock"
            title={status === 404 ? "This folder link doesn't open anything" : "You don't have access to this folder"}
            description={status === 404
              ? "It may have been turned off, or the folder deleted. If someone sent it to you, ask them for a new link."
              : `You're signed in as ${user?.email ?? "someone"}, who isn't in the workspace that shared it. Ask its owner to invite you.`}
            actions={<Button variant="secondary" href="/dashboard">Go to your documents</Button>}
          />
        </>
      );
    }
    return (
      <>
        <h1 className="md-visually-hidden">Shared folder</h1>
        <EmptyState
          icon="folder"
          title="This folder link doesn't open anything"
          description="It may have been turned off, or the folder deleted. If someone sent it to you, ask them for a new link."
          actions={
            <>
              <Button variant="primary" href={signInHref} iconLeft="user">Sign in</Button>
              <Button variant="secondary" href="/">Go to Markdrop</Button>
            </>
          }
        />
      </>
    );
  }

  const { workspace, folder, subfolders, items } = data;
  const crumbs = folder.breadcrumbs.length > 1
    ? folder.breadcrumbs.map((c, i) => ({ label: c.name, href: i < folder.breadcrumbs.length - 1 ? href(shareId, c.path) : undefined }))
    : null;
  const empty = subfolders.length === 0 && items.length === 0;
  const accent = workspace.branding?.accent_color ?? null;
  const initialLetter = (workspace.name || "?").trim().charAt(0).toUpperCase();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-3">
        <p className="flex min-w-0 items-center gap-2 text-caption text-text-secondary">
          {workspace.branding?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={workspace.branding.logo_url} alt="" className="size-5 rounded-xs object-contain" />
          ) : (
            <span aria-hidden className="grid size-5 place-items-center rounded-xs text-micro font-bold text-on-accent" style={{ background: accent ?? "var(--accent)" }}>{initialLetter}</span>
          )}
          <span className="truncate">Shared from <span className="font-medium text-text">{workspace.name}</span></span>
        </p>
        {crumbs && <Breadcrumb items={crumbs} className="min-w-0 flex-wrap" />}
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
            <Icon name="folder" size={20} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-h1 text-text [overflow-wrap:anywhere]" dir="auto">{folder.name}</h1>
            {!empty && (
              <p className="text-body text-text-secondary">
                {[subfolders.length ? plural(subfolders.length, "folder") : null, items.length ? plural(items.length, "item") : null].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </div>
      </header>

      {error && <Alert tone="warning">We couldn&apos;t check for items only your account can see. Showing what&apos;s open to everyone.</Alert>}

      {empty ? (
        <EmptyState
          icon="folder"
          title="Nothing here you can open"
          description={user
            ? "Everything in this folder is private to people other than you."
            : `People in ${workspace.name} may see more after signing in.`}
          actions={!user ? <Button variant="secondary" href={signInHref} iconLeft="user">Sign in</Button> : undefined}
        />
      ) : (
        <>
          {subfolders.length > 0 && (
            <section aria-labelledby="md-shared-folders" className="flex min-w-0 flex-col gap-2">
              <h2 id="md-shared-folders" className="text-eyebrow uppercase text-text-muted">Folders</h2>
              <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                {subfolders.map((f) => (
                  <li key={f.path} className="min-w-0">
                    <Anchor
                      href={href(shareId, f.path)}
                      className="md-focus flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 no-underline transition-colors hover:border-border-strong hover:bg-surface-hover"
                    >
                      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
                        <Icon name="folder" size={18} />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-body-strong text-text" dir="auto">{f.name}</span>
                        <span className="text-caption text-text-muted">{plural(f.count, "item")}</span>
                      </span>
                      <Icon name="chevronRight" size={16} className="ml-auto shrink-0 text-text-muted" />
                    </Anchor>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {items.length > 0 && (
            <section aria-labelledby="md-shared-items" className="flex min-w-0 flex-col gap-2">
              <h2 id="md-shared-items" className="text-eyebrow uppercase text-text-muted">Items</h2>
              <ul className="flex min-w-0 flex-col gap-2">
                {items.map((it) => {
                  const art = it.kind === "artifact";
                  const k = art ? fileKind("", it.mime || "", null) : "document";
                  const tint = FILE_KINDS[k].tint;
                  const when = relativeTime(it.updated_at ?? null);
                  const size = formatSize(it.size_bytes);
                  return (
                    <li key={it.slug} className="min-w-0">
                      <Anchor
                        href={it.url}
                        className="md-focus flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 no-underline transition-colors hover:border-border-strong hover:bg-surface-hover"
                      >
                        {it.poster_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={it.poster_url} alt="" className="h-9 w-14 shrink-0 rounded-md object-cover" />
                        ) : (
                          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg" style={{ color: tint, background: "color-mix(in srgb, currentColor 12%, transparent)" }}>
                            <FileIcon name={art ? "" : "doc.md"} mime={it.mime || ""} renderer={null as FileRenderer | null} size={18} />
                          </span>
                        )}
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-body-strong text-text" dir="auto">{it.title || it.slug}</span>
                          <span className="truncate text-caption text-text-muted">
                            {[art ? "File" : "Document", size, when ? `Updated ${when}` : null].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <Icon name="arrowUpRight" size={16} className="shrink-0 text-text-muted" />
                      </Anchor>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <p className="text-caption text-text-muted">
            {user ? "Showing what you can open." : `Showing what's open to anyone. People in ${workspace.name} may see more after signing in.`}
          </p>
        </>
      )}
    </div>
  );
}
