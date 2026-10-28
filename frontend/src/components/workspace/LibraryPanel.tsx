"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert, Button, ConfirmDialog, EmptyState, Input, SegmentedControl, Tabs, copyText, cx, type MenuEntry,
} from "@/components/ui";
import { useToast } from "@/components/Toast";
import ShareDialog from "@/components/access/ShareDialog";
import { DocRow, rowStatuses } from "@/components/dashboard/DocRow";
import { ListFooter, ListSkeleton } from "@/components/dashboard/ListParts";
import { MoveFolderDialog, folderOptions } from "@/components/dashboard/DocDialogs";
import { addressOf, displayTitle, plural } from "@/components/dashboard/format";
import { usePhone } from "@/components/dashboard/hooks";
import styles from "@/components/dashboard/dashboard.module.css";
import type { MyDocListItem } from "@/lib/api";
import { recallKey, withKey } from "@/lib/e2e";
import {
  can, libraryCounts, listLibrary, unshareFromWorkspace, type Folder, type Role,
} from "@/lib/workspaces";

const PER_PAGE = 20;
type Kind = "" | "markdown" | "artifact";

export interface LibraryAnalyticsTarget {
  doc: MyDocListItem;
  title: string;
  address: string;
  copyText: string | null;
}

/**
 * The workspace's shared documents and artifacts (D11: the library lives on the dashboard, at
 * /dashboard?ws=<id>[&folder=<id|unfiled>]).
 *
 * Library privacy invariant: everything listed here was put here deliberately by the person who
 * owns it. Private documents are not filtered out of this view; they were never in the result set,
 * because the server matches on `workspace_id` and a private document has none. There is no "show
 * only shared" flag to accidentally drop, and nothing here may add one.
 *
 * Two modes. Controlled (the dashboard passes `q`): search, kind, folder and page come from the URL
 * and the dashboard header owns the search box. Uncontrolled (the legacy workspace-settings tab):
 * the panel shows its own search, kind and folder filters.
 */
export default function LibraryPanel({
  workspaceId,
  role,
  folders,
  primaryHost,
  onError,
  workspaceName,
  folderId,
  q: qProp,
  kind: kindProp,
  page: pageProp,
  onPage,
  onClearSearch,
  onAnalytics,
  onTotal,
  animateFirst = true,
}: {
  workspaceId: string;
  role: Role;
  folders: Folder[];
  /** Unused since the revamp (rows use category colours); kept so existing callers compile. */
  accent?: string;
  /** The workspace's own document host, when it has a verified one. */
  primaryHost: string | null;
  onError?: (msg: string) => void;
  workspaceName?: string;
  /** Controlled: the folder in view (`"unfiled"`, a folder id, or null for the whole library). */
  folderId?: string | null;
  /** Presence switches the panel to controlled mode. */
  q?: string;
  kind?: Kind;
  page?: number;
  onPage?: (p: number) => void;
  onClearSearch?: () => void;
  onAnalytics?: (t: LibraryAnalyticsTarget) => void;
  onTotal?: (total: number) => void;
  animateFirst?: boolean;
}) {
  const controlled = qProp !== undefined;
  const phone = usePhone();
  const toast = useToast();

  // Uncontrolled filters (legacy settings tab).
  const [qLocal, setQLocal] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [kindLocal, setKindLocal] = useState<Kind>("");
  const [folderLocal, setFolderLocal] = useState<string>("");
  const [pageLocal, setPageLocal] = useState(1);

  const q = controlled ? qProp ?? "" : qDebounced;
  const kind = controlled ? kindProp ?? "" : kindLocal;
  const folder = controlled ? folderId ?? "" : folderLocal;
  const page = controlled ? pageProp ?? 1 : pageLocal;
  const setPage = controlled ? (p: number) => onPage?.(p) : setPageLocal;

  useEffect(() => {
    if (controlled) return;
    const t = setTimeout(() => { setQDebounced(qLocal.trim()); setPageLocal(1); }, 300);
    return () => clearTimeout(t);
  }, [qLocal, controlled]);

  const [docs, setDocs] = useState<MyDocListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [dataKey, setDataKey] = useState("");
  const firstPaint = useRef(true);
  const [shareFor, setShareFor] = useState<MyDocListItem | null>(null);
  const [moveFor, setMoveFor] = useState<MyDocListItem | null>(null);
  const [unshareFor, setUnshareFor] = useState<MyDocListItem | null>(null);
  const seq = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onTotalRef = useRef(onTotal);
  onTotalRef.current = onTotal;

  const load = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => (s === "ok" ? "ok" : "loading"));
    try {
      const r = await listLibrary(workspaceId, {
        page,
        limit: PER_PAGE,
        q: q || undefined,
        kind: kind || undefined,
        folderId: folder && folder !== "unfiled" ? folder : undefined,
        unfiled: folder === "unfiled",
      });
      if (id !== seq.current) return;
      // A page that emptied (last item removed) steps back one.
      if (r.documents.length === 0 && page > 1 && r.total > 0) { setPage(Math.max(1, r.pages)); return; }
      setDocs(r.documents);
      setTotal(r.total);
      setPages(Math.max(1, r.pages));
      setState("ok");
      setLoadedOnce(true);
      setDataKey(`${folder}|${kind}|${q}|${page}`);
      onTotalRef.current?.(r.total);
    } catch (e) {
      if (id !== seq.current) return;
      setState("error");
      onErrorRef.current?.(e instanceof Error ? e.message : "Couldn't load the library");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, q, kind, folder, page]);

  // Reset to a loading state when the scope itself changes, so old rows don't linger.
  useEffect(() => {
    setState("loading");
  }, [workspaceId, folder]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (state !== "ok") return;
    const t = setTimeout(() => { firstPaint.current = false; }, 0);
    return () => clearTimeout(t);
  }, [state]);

  const loadCounts = useCallback(async () => {
    if (controlled) return;
    setCounts(await libraryCounts(workspaceId).catch(() => ({})));
  }, [workspaceId, controlled]);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  const canEdit = can(role, "member");
  const canAdmin = can(role, "admin");
  const wsName = workspaceName || "the workspace";

  function rowCopy(d: MyDocListItem, href: string, external: boolean): { text: string; hint?: string } | null {
    const url = external ? href : d.url;
    if (!d.encrypted) return { text: url };
    const key = recallKey(d.slug);
    return key ? { text: withKey(url, key), hint: "Key saved on this device" } : null;
  }

  function menuFor(d: MyDocListItem, t: string, href: string, external: boolean, address: string, copy: { text: string } | null): MenuEntry[] {
    const items: MenuEntry[] = [{ label: "Open", icon: "external", href, external: true }];
    if (phone && copy) {
      items.push({ label: "Copy link", icon: "copy", onClick: () => { void copyText(copy.text).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy the link"))); } });
    }
    if (d.is_mine && onAnalytics) {
      items.push({ label: "Analytics", icon: "chart", onClick: () => onAnalytics({ doc: d, title: t, address, copyText: copy?.text ?? null }) });
    }
    const second: MenuEntry[] = [];
    if (d.is_mine) second.push({ label: "Share…", icon: "user", onClick: () => setShareFor(d) });
    if (canEdit && folders.length > 0) second.push({ label: "Move to folder…", icon: "folder", onClick: () => setMoveFor(d) });
    if (second.length) items.push({ ...second[0]!, separated: true } as MenuEntry, ...second.slice(1));
    if (d.is_mine || canAdmin) {
      items.push({ label: "Remove from library", icon: "x", danger: true, separated: true, onClick: () => setUnshareFor(d) });
    }
    return items;
  }

  const filters = [
    { value: "", label: "All", count: controlled ? undefined : total },
    { value: "unfiled", label: "Unfiled", count: counts["unfiled"] },
    ...folderOptions(folders).map((o) => ({ value: o.value, label: o.label, count: counts[o.value] })),
  ];

  const activeFolder = folder && folder !== "unfiled" ? folders.find((f) => f.id === folder) : null;
  const filtered = !!(q || kind || folder);

  let empty: React.ReactNode = null;
  if (state === "ok" && docs.length === 0) {
    if (q) {
      empty = (
        <EmptyState
          icon="search"
          title={`Nothing matches “${q}”`}
          description="Search looks at titles and links in this library."
          actions={<Button variant="secondary" onClick={() => (controlled ? onClearSearch?.() : (setQLocal(""), setQDebounced("")))}>Clear search</Button>}
        />
      );
    } else if (folder) {
      empty = (
        <EmptyState
          icon="folder"
          title={folder === "unfiled" ? "No unfiled documents" : `Nothing in ${activeFolder?.name ?? "this folder"} yet`}
          description="File a shared document here from its menu: Move to folder…"
        />
      );
    } else {
      empty = (
        <EmptyState
          icon="inbox"
          title={kind === "artifact" ? "No artifacts shared yet" : kind === "markdown" ? "No documents shared yet" : "Nothing shared yet"}
          description="Documents stay private until their owner shares them here. Open Share on any document and choose Everyone in the workspace."
          actions={<Button variant="secondary" href="/dashboard">Go to your documents</Button>}
        />
      );
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {!controlled && (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              iconPrefix="search"
              value={qLocal}
              onChange={(e) => setQLocal(e.target.value)}
              placeholder="Search shared documents"
              aria-label="Search shared documents"
              wrapClassName="min-w-0 flex-1 basis-52"
              className="min-w-0 flex-1 basis-52"
            />
            <SegmentedControl<Kind>
              aria-label="Kind"
              size="sm"
              value={kindLocal}
              onChange={(v) => { setKindLocal(v); setPageLocal(1); }}
              options={[{ value: "", label: "All" }, { value: "markdown", label: "Documents" }, { value: "artifact", label: "Artifacts" }]}
            />
          </div>
          {filters.length > 2 && (
            <Tabs
              variant="pill"
              size="sm"
              aria-label="Folder"
              items={filters}
              value={folderLocal}
              onChange={(v) => { setFolderLocal(v); setPageLocal(1); }}
            />
          )}
        </div>
      )}

      {state === "error" && (
        <Alert
          tone="danger"
          title="Couldn't load the library"
          actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Try again</Button>}
        >
          Check your connection and try again.
        </Alert>
      )}

      {state === "loading" && !loadedOnce && <ListSkeleton label="Loading the library" />}
      {state === "loading" && loadedOnce && <ListSkeleton rows={Math.min(5, Math.max(1, docs.length))} label="Loading the library" />}

      {empty}

      {state === "ok" && docs.length > 0 && (
        <ul
          key={dataKey}
          className={cx("flex min-w-0 flex-col gap-2", !firstPaint.current && styles.fade)}
          aria-label={filtered ? "Matching shared items" : "Shared items"}
        >
          {docs.map((d, i) => {
            const t = displayTitle(d);
            const addr = addressOf(d, primaryHost);
            const copy = rowCopy(d, addr.href, addr.external);
            const by = d.is_mine ? "You" : d.shared_by_name || d.shared_by_email;
            return (
              <DocRow
                key={d.id}
                doc={d}
                title={t}
                href={addr.href}
                external
                address={addr.label}
                extraMeta={by ? <><span aria-hidden> · </span><span>{by}</span></> : null}
                statuses={rowStatuses(d, false)}
                onAccess={d.is_mine ? () => setShareFor(d) : null}
                copy={copy}
                menu={menuFor(d, t, addr.href, addr.external, addr.label, copy)}
                phone={phone}
                riseDelay={animateFirst && firstPaint.current ? Math.min(i, 8) * 20 : null}
                menuLabel={`Actions for ${t}`}
              />
            );
          })}
        </ul>
      )}

      {state === "ok" && docs.length > 0 && (
        <>
          <ListFooter page={page} pages={pages} shown={docs.length} total={total} perPage={PER_PAGE} onPage={setPage} phone={phone} />
          <p className="text-caption text-text-muted">
            {plural(total, "shared item")}.{" "}
            {canEdit ? "Everyone here can read these; members and admins can edit them." : "You have read-only access."}
          </p>
        </>
      )}

      {shareFor && (
        <ShareDialog
          slug={shareFor.slug}
          documentId={shareFor.id}
          title={displayTitle(shareFor)}
          onClose={() => setShareFor(null)}
          onChanged={() => void load()}
        />
      )}

      <MoveFolderDialog
        doc={moveFor}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        folders={folders}
        onClose={() => setMoveFor(null)}
        onMoved={(d, label) => {
          setMoveFor(null);
          toast.success(`Moved “${displayTitle(d)}” to ${label}`);
          void load();
          void loadCounts();
        }}
      />

      <ConfirmDialog
        open={!!unshareFor}
        onClose={() => setUnshareFor(null)}
        title={unshareFor ? `Remove “${displayTitle(unshareFor)}” from ${wsName}?` : "Remove from the library?"}
        body={<p className="text-body text-text-secondary">People in the workspace lose access through the library. The document itself isn&apos;t deleted.</p>}
        confirmLabel="Remove"
        onConfirm={async () => {
          const d = unshareFor;
          if (!d) return;
          try {
            await unshareFromWorkspace(workspaceId, d.id, d.slug);
          } catch (e) {
            throw new Error(e instanceof Error && e.message ? e.message : "Couldn't remove it. Check your connection and try again.");
          }
          setUnshareFor(null);
          toast.success(`Removed “${displayTitle(d)}” from ${wsName}`);
          void load();
          void loadCounts();
        }}
      />
    </div>
  );
}
