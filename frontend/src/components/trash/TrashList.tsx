"use client";

/**
 * Trash (/trash): what the signed-in person deleted, and what was deleted from the workspaces they
 * administer, newest first. Each row says what it is (kind, title, link), where it was, who deleted
 * it and when, and how long it has left; Restore puts it back where it was, Delete forever is final.
 * The list comes from the server already filtered to what the caller may restore.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Select, cx, useToast } from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import { useMounted } from "@/components/shell/useLocation";
import { ListSkeleton } from "@/components/dashboard/ListParts";
import { fullDate, plural } from "@/components/dashboard/format";
import { useAuth } from "@/contexts/AuthContext";
import { listWorkspaces, type Workspace } from "@/lib/workspaces";
import { TRASH_DAYS, TrashApiError, daysLeftLabel, deleteForever, listTrash, type RestoreResult, type TrashItem } from "@/lib/trash";
import { restoreWithToast } from "./useTrashUndo";
import { TrashTile, trashAddress, trashDeleted, trashKindLabel, trashName, trashNoun, trashWhere } from "./parts";

/** What goes with it: "+3 sub-pages", "12 items, 2 folders". */
function withIt(it: TrashItem): string | null {
  if (it.kind === "folder" && it.contents) {
    const parts = [plural(it.contents.items, "item"), it.contents.folders ? plural(it.contents.folders, "folder") : null].filter(Boolean);
    return parts.join(", ");
  }
  return it.sub_pages > 0 ? `+${plural(it.sub_pages, "sub-page")}` : null;
}

/** Where Open goes after a restore: the item, or the folder in its workspace. */
function openHref(it: TrashItem, r: RestoreResult): string | null {
  if (it.kind === "folder") {
    const ws = it.where.workspace;
    return ws?.exists && r.folders > 0 ? `/w/${encodeURIComponent(ws.id)}/f/${encodeURIComponent(r.key)}` : null;
  }
  const slug = r.slug ?? it.slug;
  return slug ? `/${encodeURIComponent(slug)}` : null;
}

export default function TrashList() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const mounted = useMounted();
  const toast = useToast();

  useEffect(() => {
    if (authLoading || !mounted || user) return;
    router.replace(`/login?next=${encodeURIComponent("/trash")}`);
  }, [authLoading, mounted, user, router]);

  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [days, setDays] = useState(TRASH_DAYS);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [purging, setPurging] = useState<TrashItem | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await listTrash(workspace || null);
      setItems(r.items);
      setDays(r.days);
    } catch (e) {
      if (e instanceof TrashApiError && e.status === 401) {
        router.replace(`/login?next=${encodeURIComponent("/trash")}`);
        return;
      }
      setItems((xs) => xs ?? []);
      setError(e instanceof Error && e.message ? e.message : "Couldn't load the trash.");
    }
  }, [workspace, router]);

  useEffect(() => { if (user) void load(); }, [user, load]);
  useEffect(() => {
    if (!user) return;
    listWorkspaces().then(setWorkspaces).catch(() => setWorkspaces([]));
  }, [user]);

  const wsOptions = useMemo(
    () => [{ value: "", label: "Everything" }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))],
    [workspaces],
  );

  async function restore(it: TrashItem) {
    if (busy) return;
    setBusy(it.key);
    const r = await restoreWithToast(toast, {
      key: it.key,
      workspaceId: it.where.workspace?.exists ? it.where.workspace.id : null,
      open: (res) => openHref(it, res),
    });
    setBusy(null);
    if (r) setItems((xs) => (xs ?? []).filter((x) => x.key !== it.key));
    // A batch can change shape (an item restored on its own leaves its folder's row): re-read.
    void load();
  }

  if (authLoading || !user) return <ListSkeleton label="Loading" />;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title="Trash"
        description={`Deleted items stay here for ${days} days, then they're deleted for good. Restoring puts an item back where it was.`}
        actions={workspaces.length > 0 ? (
          <label className="flex min-w-0 items-center gap-2 text-caption text-text-secondary">
            <span className="shrink-0">Show</span>
            {/* ph-no-capture: the options are workspace names. */}
            <Select
              value={workspace}
              onChange={(e) => { setItems(null); setWorkspace(e.target.value); }}
              options={wsOptions}
              className="ph-no-capture max-w-56"
              aria-label="Show what was deleted from"
            />
          </label>
        ) : undefined}
      />

      {error && (
        <Alert tone="danger" actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Try again</Button>}>
          {error}
        </Alert>
      )}

      {items === null ? (
        <ListSkeleton rows={4} label="Loading" />
      ) : items.length === 0 && !error ? (
        <EmptyState
          icon="trash"
          title="Trash is empty"
          description={`Deleted items stay here for ${days} days, then they're deleted for good.`}
          actions={<Button variant="secondary" href="/dashboard">Go to My files</Button>}
        />
      ) : items.length > 0 ? (
        <section aria-label="Deleted items" className="flex min-w-0 flex-col gap-2">
          {/* ph-no-capture: titles, links, workspace and people's names. */}
          <ul className="ph-no-capture m-0 flex min-w-0 list-none flex-col gap-2 p-0">
            {items.map((it) => {
              const name = trashName(it);
              const address = it.hidden ? null : trashAddress(it);
              const where = trashWhere(it);
              const extra = withIt(it);
              const soon = it.days_left <= 3;
              return (
                <li key={it.key} className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
                  <TrashTile item={it} />
                  <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={cx("ph-sensitive ph-mask min-w-0 truncate text-body-strong", it.hidden ? "text-text-secondary italic" : "text-text")} dir="auto" title={name}>
                        {name}
                      </span>
                      {it.encrypted && <Badge size="sm" tone="info" icon="key" upper title="Encrypted in the browser. The key is in the link.">E2E</Badge>}
                      {extra && <Badge size="sm">{extra}</Badge>}
                    </div>
                    <div className="min-w-0 truncate text-caption text-text-muted">
                      <span>{trashKindLabel(it)}</span>
                      {address && <><span aria-hidden> · </span><span className="ph-sensitive ph-mask font-mono">{address}</span></>}
                      <span aria-hidden> · </span>
                      <span className="ph-sensitive ph-mask" dir="auto">{where.text}</span>
                      {where.gone && <span> {where.gone}</span>}
                    </div>
                    <div className="min-w-0 text-caption text-text-muted">
                      <time dateTime={it.deleted_at} title={fullDate(it.deleted_at)} className="ph-sensitive ph-mask">{trashDeleted(it)}</time>
                      <span aria-hidden> · </span>
                      <span className={soon ? "text-warning" : undefined} title={it.restore_until ? `Deleted for good ${fullDate(it.restore_until)}` : undefined}>
                        {daysLeftLabel(it.days_left)}
                      </span>
                      {it.deleted_with?.folder && (
                        <>
                          <span aria-hidden> · </span>
                          <span>Deleted with the folder “<span className="ph-sensitive ph-mask">{it.deleted_with.folder}</span>”</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:[&>*]:flex-1">
                    {it.can.restore && (
                      <Button size="sm" variant="secondary" iconLeft="undo" className="max-sm:min-h-11" loading={busy === it.key} disabled={!!busy && busy !== it.key}
                        onClick={() => void restore(it)} aria-label={`Restore ${name}`}>
                        Restore
                      </Button>
                    )}
                    {it.can.delete_forever && (
                      <Button size="sm" variant="ghost" iconLeft="trash" className="text-danger max-sm:min-h-11" disabled={!!busy}
                        onClick={() => setPurging(it)} aria-label={`Delete ${name} forever`}>
                        Delete forever
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={!!purging}
        onClose={() => setPurging(null)}
        title={purging ? <>Delete the {trashNoun(purging)} “<span className="ph-sensitive ph-mask">{trashName(purging)}</span>” forever?</> : "Delete forever?"}
        body={purging ? (
          <p className="text-body text-text-secondary">
            {purging.kind === "folder" && purging.contents && (purging.contents.items || purging.contents.folders)
              ? <>Everything in it goes too ({withIt(purging)}). </>
              : purging.sub_pages > 0 ? <>Its {plural(purging.sub_pages, "sub-page")} {purging.sub_pages === 1 ? "goes" : "go"} too. </> : null}
            This can&apos;t be undone.
          </p>
        ) : null}
        confirmLabel="Delete forever"
        onConfirm={async () => {
          const it = purging;
          if (!it) return;
          await deleteForever(it.key);
          setPurging(null);
          setItems((xs) => (xs ?? []).filter((x) => x.key !== it.key));
          toast.success(<>Deleted “{trashName(it)}” forever</>);
          void load();
        }}
      />
    </div>
  );
}
