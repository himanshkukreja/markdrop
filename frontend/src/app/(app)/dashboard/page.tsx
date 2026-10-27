"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert, Anchor, Breadcrumb, Button, ConfirmDialog, EmptyState, Icon, Input, Kbd, MarkdropLoader,
  Tabs, VSCodeIcon, copyText, cx, type MenuEntry,
} from "@/components/ui";
import { useToast } from "@/components/Toast";
import { PageHeader } from "@/components/shell/PageHeader";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { useAuth } from "@/contexts/AuthContext";
import {
  listMyDocuments, getGoogleDocsStatus, connectGoogleDocs, disconnectGoogleDocs, exportToGoogleDocs,
  type MyDocListItem, type GoogleStatus,
} from "@/lib/api";
import { recallKey, withKey } from "@/lib/e2e";
import { can, listWorkspaces, type Workspace } from "@/lib/workspaces";
import { ancestry, useDocumentsChanged, useWorkspaceTree, useWorkspaceTrees, workspaceChanged } from "@/lib/workspaceStore";
import { track } from "@/lib/track";
import ShareDialog from "@/components/access/ShareDialog";
import type { LibraryAnalyticsTarget } from "@/components/workspace/LibraryPanel";
import { MoveToDialog } from "@/components/workspace/folder/FolderDialogs";
import AnalyticsDrawer from "@/components/dashboard/AnalyticsDrawer";
import NameCard from "@/components/dashboard/NameCard";
import { DocRow, rowStatuses } from "@/components/dashboard/DocRow";
import { ListFooter, ListSkeleton } from "@/components/dashboard/ListParts";
import { ChangeUrlDialog, DeleteDocDialog } from "@/components/dashboard/DocDialogs";
import { addressOf, displayTitle, plural } from "@/components/dashboard/format";
import { shouldHandleSlash, usePhone } from "@/components/dashboard/hooks";
import styles from "@/components/dashboard/dashboard.module.css";

const PER_PAGE = 20;
type KindTab = "all" | "document" | "artifact";

const TITLES: Record<KindTab, string> = { all: "All items", document: "Documents", artifact: "Artifacts" };

const GDOCS_NOTICES: Record<string, { kind: "success" | "info" | "error"; text: string }> = {
  connected: { kind: "success", text: "Google Docs connected. You can now export documents." },
  cancelled: { kind: "info", text: "Google connection was cancelled." },
  failed: { kind: "error", text: "Couldn't connect to Google. Try again." },
  state_error: { kind: "error", text: "The connection expired. Try again." },
  no_refresh_token: { kind: "error", text: "Google didn't return access. Try again and approve all prompts." },
};

/** Scope lives in the URL (REVAMP_PLAN 4.3): ?kind=document|artifact, ?ws=<id>&folder=<id|unfiled>, ?q=, ?page=. */
function readScope(search: string) {
  const p = new URLSearchParams(search);
  const k = p.get("kind");
  const kind: KindTab = k === "document" || k === "markdown" ? "document" : k === "artifact" ? "artifact" : "all";
  const page = Math.max(1, parseInt(p.get("page") || "1", 10) || 1);
  return { ws: p.get("ws"), folder: p.get("folder"), kind, q: (p.get("q") || "").trim(), page };
}

type Analyzed = LibraryAnalyticsTarget;

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const phone = usePhone();
  const mounted = useMounted();
  const search = useLocationSearch();
  // The URL is only trusted once it has been read on the client (the server snapshot is "").
  const urlReady = mounted && typeof window !== "undefined" && search === window.location.search;
  const scope = useMemo(() => readScope(search), [search]);
  const inWorkspace = !!scope.ws;

  // v2: a workspace's library is its folder view. Old links (?ws=…&folder=…) keep their meaning.
  useEffect(() => {
    if (!urlReady || !scope.ws) return;
    const ws = encodeURIComponent(scope.ws);
    const p = new URLSearchParams();
    if (scope.q) p.set("q", scope.q);
    if (scope.kind !== "all") p.set("kind", scope.kind === "document" ? "markdown" : "artifact");
    let path = `/w/${ws}`;
    if (scope.folder === "unfiled") p.set("filter", "unfiled");
    else if (scope.folder) path += `/f/${encodeURIComponent(scope.folder)}`;
    const qs = p.toString();
    router.replace(`${path}${qs ? `?${qs}` : ""}`);
  }, [urlReady, scope.ws, scope.folder, scope.q, scope.kind, router]);

  /** Update the query string. Push for scope/page changes (Back works), replace while typing. */
  const navigate = useCallback((patch: Record<string, string | null>, replace = false) => {
    const p = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    if (!("page" in patch)) p.delete("page");
    const qs = p.toString();
    const url = `/dashboard${qs ? `?${qs}` : ""}`;
    if (replace) router.replace(url, { scroll: false });
    else router.push(url, { scroll: false });
  }, [router]);

  /* ── Search box (debounced 300ms into ?q=) ─────────────────────────── */
  const searchRef = useRef<HTMLInputElement>(null);
  const [qInput, setQInput] = useState("");
  const typing = useRef(false);
  useEffect(() => {
    if (!urlReady) return;
    if (document.activeElement !== searchRef.current || !typing.current) setQInput(scope.q);
  }, [urlReady, scope.q]);
  useEffect(() => {
    if (!urlReady || !typing.current) return;
    const t = setTimeout(() => {
      typing.current = false;
      if (qInput.trim() !== scope.q) navigate({ q: qInput.trim() || null }, true);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, urlReady, scope.q, navigate]);
  const clearSearch = useCallback(() => {
    typing.current = false;
    setQInput("");
    navigate({ q: null }, true);
  }, [navigate]);

  // "/" focuses search (single-key rules: not in a field, no dialog or menu open, no modifiers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldHandleSlash(e)) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── Auth gate ──────────────────────────────────────────────────────── */
  useEffect(() => {
    if (authLoading || !mounted || user) return;
    const next = `/dashboard${window.location.search}`;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [authLoading, mounted, user, router]);

  /* ── Workspaces (names for the workspace scope and Move to folder) ─── */
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [wsError, setWsError] = useState(false);
  useEffect(() => {
    if (!user) return;
    let live = true;
    listWorkspaces()
      .then((w) => { if (live) { setWorkspaces(w); setWsError(false); } })
      .catch(() => { if (live) { setWorkspaces([]); setWsError(true); } });
    return () => { live = false; };
  }, [user]);
  void wsError;

  /* ── Personal list ──────────────────────────────────────────────────── */
  const [docs, setDocs] = useState<MyDocListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [counts, setCounts] = useState<{ all: number; document: number; artifact: number } | null>(null);
  const [listState, setListState] = useState<"loading" | "ok" | "error">("loading");
  const [loadedOnce, setLoadedOnce] = useState(false);
  /** The scope the rows on screen were loaded for: the list crossfades when it changes. */
  const [dataKey, setDataKey] = useState("");
  /** Rows rise with a stagger on the first load only (REVAMP_PLAN 7.10 motion). */
  const firstPaint = useRef(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!user || !urlReady || inWorkspace) return;
    const id = ++seq.current;
    setListState((s) => (s === "error" ? "loading" : s));
    try {
      const res = await listMyDocuments(
        scope.page,
        scope.q || undefined,
        scope.kind === "document" ? "markdown" : scope.kind === "artifact" ? "artifact" : undefined,
      );
      if (id !== seq.current) return;
      if (res.documents.length === 0 && scope.page > 1 && res.total > 0) {
        navigate({ page: String(Math.max(1, res.pages)) }, true);
        return;
      }
      setDocs(res.documents);
      setTotal(res.total);
      setPages(Math.max(1, res.pages));
      setCounts({
        all: res.count_all ?? res.total,
        document: res.count_markdown ?? 0,
        artifact: res.count_artifact ?? 0,
      });
      setListState("ok");
      setLoadedOnce(true);
      setDataKey(`${scope.kind}|${scope.q}|${scope.page}`);
    } catch (e) {
      if (id !== seq.current) return;
      if (e instanceof Error && e.message === "UNAUTHORIZED") {
        router.replace(`/login?next=${encodeURIComponent(`/dashboard${window.location.search}`)}`);
        return;
      }
      setListState("error");
    }
  }, [user, urlReady, inWorkspace, scope.page, scope.q, scope.kind, navigate, router]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (listState !== "ok" || !loadedOnce) return;
    const t = setTimeout(() => { firstPaint.current = false; }, 0);
    return () => clearTimeout(t);
  }, [listState, loadedOnce]);

  /* ── Google Docs (logic unchanged: 428 → reconnect; track on success) ── */
  const [gStatus, setGStatus] = useState<GoogleStatus | null>(null);
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  useEffect(() => {
    if (!user) return;
    getGoogleDocsStatus().then(setGStatus).catch(() => {});
  }, [user]);

  // The result of the Google connect redirect (?gdocs=…) becomes a toast; the param is removed.
  useEffect(() => {
    if (!urlReady) return;
    const p = new URLSearchParams(window.location.search);
    const g = p.get("gdocs");
    if (!g) return;
    const n = GDOCS_NOTICES[g];
    if (n) toast.toast(n.text, n.kind);
    if (g === "connected") getGoogleDocsStatus().then(setGStatus).catch(() => {});
    p.delete("gdocs");
    const qs = p.toString();
    window.history.replaceState(window.history.state, "", `/dashboard${qs ? `?${qs}` : ""}`);
  }, [urlReady, toast]);

  async function handleExport(doc: MyDocListItem) {
    const wasLinked = !!doc.google_doc_url;
    setExportBusy(doc.slug);
    setReconnect(null);
    try {
      const result = await exportToGoogleDocs(doc.id);
      track("google_docs_export", { from: "dashboard" });
      setDocs((ds) => ds.map((d) => (d.id === doc.id ? { ...d, google_doc_url: result.google_doc_url, google_doc_stale: false } : d)));
      // No auto-open: window.open() after an await is blocked by popup blockers. The toast's
      // action runs inside a click, so it may open the tab.
      const url = result.google_doc_url;
      toast.toast({
        message: `${displayTitle(doc)} ${wasLinked ? "updated in" : "exported to"} Google Docs`,
        kind: "success",
        action: url ? { label: "Open", onClick: () => window.open(url, "_blank", "noopener,noreferrer") } : undefined,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "ReconnectRequired") {
        setReconnect(err.message);
      } else {
        toast.error(err instanceof Error ? err.message : "Export failed. Try again.");
      }
    } finally {
      setExportBusy(null);
    }
  }

  async function handleConnect() {
    try {
      await connectGoogleDocs("/dashboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the Google connection. Try again.");
    }
  }

  /* ── Dialog state ───────────────────────────────────────────────────── */
  const [shareFor, setShareFor] = useState<MyDocListItem | null>(null);
  const [renameFor, setRenameFor] = useState<MyDocListItem | null>(null);
  const [deleteFor, setDeleteFor] = useState<MyDocListItem | null>(null);
  const [moveFor, setMoveFor] = useState<MyDocListItem | null>(null);
  const [shareAt, setShareAt] = useState(false);
  const [analytics, setAnalytics] = useState<Analyzed | null>(null);
  const moveTree = useWorkspaceTree(moveFor?.workspace_id ?? null).tree;

  // Rows filed in a workspace show where ("Acme › Guides"): names come from the shared trees.
  const rowWorkspaces = useMemo(() => [...new Set(docs.map((d) => d.workspace_id).filter((x): x is string => !!x))], [docs]);
  const rowTrees = useWorkspaceTrees(rowWorkspaces);
  // Something filed or unfiled elsewhere (a Share dialog, the folder view): reload this list.
  const reloadList = useCallback(() => { void load(); }, [load]);
  useDocumentsChanged(reloadList);

  function locationChip(d: MyDocListItem) {
    if (!d.workspace_id) return null;
    const ws = workspaces?.find((w) => w.id === d.workspace_id);
    const tree = rowTrees[d.workspace_id] || null;
    const names = tree ? ancestry(tree.folders, d.folder_id).map((f) => f.name) : [];
    const wsName = tree?.workspace.name ?? ws?.name;
    if (!wsName) return null;
    const label = [wsName, ...names].join(" › ");
    const href = d.folder_id
      ? `/w/${encodeURIComponent(d.workspace_id)}/f/${encodeURIComponent(d.folder_id)}`
      : `/w/${encodeURIComponent(d.workspace_id)}`;
    return (
      <Anchor
        href={href}
        title={`In ${label}`}
        className="md-focus relative z-[1] inline-flex min-w-0 max-w-[45%] shrink items-center gap-1 rounded-sm bg-surface-active px-1.5 text-micro text-text-secondary no-underline hover:text-text sm:max-w-56"
      >
        <Icon name="folder" size={11} className="shrink-0" />
        {/* Phones: just the innermost place; the full trail is in the title. */}
        <span className="truncate" dir="auto">{phone ? names[names.length - 1] ?? wsName : label}</span>
      </Anchor>
    );
  }

  function rowCopy(d: MyDocListItem): { text: string; hint?: string } | null {
    if (!d.encrypted) return { text: d.url };
    const key = recallKey(d.slug);
    return key ? { text: withKey(d.url, key), hint: "Key saved on this device" } : null;
  }

  function menuFor(d: MyDocListItem, title: string, address: string, copy: { text: string } | null): MenuEntry[] {
    const isArtifact = d.kind === "artifact";
    const items: MenuEntry[] = [{ label: "Open", icon: "external", href: `/${d.slug}` }];
    if (phone && copy) {
      items.push({
        label: "Copy link", icon: "copy",
        onClick: () => { void copyText(copy.text).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy the link"))); },
      });
    }
    if (!isArtifact) {
      if (d.encrypted && !recallKey(d.slug)) {
        items.push({ label: "Edit", icon: "edit", disabled: true, description: "The key lives in your link, which was never sent to us" });
      } else {
        items.push({ label: "Edit", icon: "edit", href: `/${d.slug}?edit=1` });
      }
    }
    items.push({ label: "Analytics", icon: "chart", onClick: () => setAnalytics({ doc: d, title, address, copyText: copy?.text ?? null }) });

    // Google actions: product actions stay on the dashboard (D7); they need a connected account.
    if (gStatus?.configured && !isArtifact && !d.encrypted) {
      if (gStatus.connected && d.google_doc_url) {
        items.push({ label: "Open in Google Docs", icon: "google", href: d.google_doc_url, external: true, separated: true });
        items.push({
          label: exportBusy === d.slug ? "Syncing…" : d.google_doc_stale ? "Sync to Google Docs" : "Re-sync to Google Docs",
          icon: "refresh", busy: exportBusy === d.slug, onClick: () => void handleExport(d),
        });
      } else if (gStatus.connected) {
        items.push({ label: exportBusy === d.slug ? "Exporting…" : "Export to Google Docs", icon: "google", busy: exportBusy === d.slug, separated: true, onClick: () => void handleExport(d) });
      } else {
        items.push({ label: "Export to Google Docs", icon: "google", separated: true, caption: "Connects your Google account first", onClick: () => void handleConnect() });
      }
    }

    items.push({ label: "Share…", icon: "user", separated: true, onClick: () => setShareFor(d) });
    items.push({ label: "Change URL", icon: "link", onClick: () => setRenameFor(d) });
    if (d.workspace_id) {
      items.push({ label: "Move to folder…", icon: "folder", onClick: () => setMoveFor(d) });
    } else if (workspaces?.some((w) => can(w.role, "member"))) {
      items.push({ label: "Add to a workspace…", icon: "folder", description: "Same link; who can open it stays as it is", onClick: () => { setShareAt(true); setShareFor(d); } });
    }
    items.push({ label: "Delete", icon: "trash", danger: true, separated: true, onClick: () => setDeleteFor(d) });
    return items;
  }

  /* ── Header ─────────────────────────────────────────────────────────── */
  const heading = TITLES[scope.kind];
  let summary: React.ReactNode = null;
  if (counts) {
    summary = counts.all === 0 ? "Nothing published from this account yet" : `${plural(counts.document, "document")} · ${plural(counts.artifact, "artifact")}`;
  }
  const crumbs = [{ label: "Your documents", href: "/dashboard" }, { label: TITLES[scope.kind] }];

  const searchBox = (
    <div className={cx("min-w-0", phone ? "w-full" : "w-60")} role="search">
      <Input
        ref={searchRef}
        size={phone ? "md" : "sm"}
        iconPrefix="search"
        iconSuffix={!phone && !qInput ? <Kbd>/</Kbd> : undefined}
        type="search"
        value={qInput}
        onChange={(e) => { typing.current = true; setQInput(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && qInput) { e.preventDefault(); clearSearch(); }
        }}
        placeholder="Search by title or link"
        aria-label="Search by title or link"
        aria-keyshortcuts="/"
        maxLength={200}
        className="w-full"
        wrapClassName="w-full"
      />
    </div>
  );

  const headerActions = <>{!phone && searchBox}</>;

  const tabItems = [
    { value: "all", label: "All", count: counts?.all },
    { value: "document", label: "Documents", count: counts?.document },
    { value: "artifact", label: "Artifacts", count: counts?.artifact },
  ];

  /* ── Render ─────────────────────────────────────────────────────────── */
  if (authLoading || !user || inWorkspace) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <ListSkeleton label="Loading your dashboard" />
        <div className="flex justify-center"><MarkdropLoader label="Loading your dashboard" size="sm" delay={2000} /></div>
      </div>
    );
  }

  const showList = !inWorkspace;
  const personalEmpty = showList && listState === "ok" && docs.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        breadcrumb={<Breadcrumb items={crumbs} />}
        title={heading}
        description={summary ? <span className="text-text-muted">{summary}</span> : undefined}
        actions={headerActions}
      />

      {phone && searchBox}

      <NameCard />

      {reconnect && (
        <Alert
          tone="danger"
          title="Google Docs needs reconnecting"
          onDismiss={() => setReconnect(null)}
          actions={<Button size="sm" variant="secondary" iconLeft="google" onClick={() => void handleConnect()}>Reconnect Google Docs</Button>}
        >
          {reconnect}
        </Alert>
      )}

      <Tabs
        variant="pill"
        size="sm"
        aria-label="Kind"
        items={tabItems}
        value={scope.kind}
        onChange={(v) => navigate({ kind: v === "all" ? null : v })}
        className="max-w-full min-w-0 self-start"
      />


      {/* ── Your documents ── */}
      {showList && listState === "error" && (
        <Alert
          tone="danger"
          title="Couldn't load your documents"
          actions={<Button size="sm" variant="secondary" iconLeft="refresh" onClick={() => void load()}>Try again</Button>}
        >
          Check your connection and try again.
        </Alert>
      )}

      {showList && listState === "loading" && <ListSkeleton />}

      {personalEmpty && (scope.q ? (
        <EmptyState
          icon="search"
          title={`Nothing matches “${scope.q}”`}
          description="Search looks at titles and links."
          actions={<Button variant="secondary" onClick={clearSearch}>Clear search</Button>}
        />
      ) : scope.kind === "artifact" ? (
        <EmptyState
          icon="layers"
          title="No artifacts yet"
          description="Publish an HTML page, PDF or spreadsheet and get a link that renders it."
          actions={<Button variant="secondary" iconLeft="upload" href="/upload">Publish an artifact</Button>}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <EmptyState
            icon="lines"
            title="Publish your first document"
            description="Paste markdown and get a shareable link instantly. Documents you publish while signed in appear here."
            actions={<Button variant="secondary" iconLeft="lines" href="/new">New document</Button>}
          />
          <p className="text-center text-caption text-text-muted">
            Saved one while signed out? Open it and choose <span className="font-semibold text-text-secondary">Save to my account</span>.
          </p>
          {scope.kind === "all" && <OtherWays />}
        </div>
      ))}

      {showList && listState === "ok" && docs.length > 0 && (
        <>
          <ul key={dataKey} className={cx("flex min-w-0 flex-col gap-2", !firstPaint.current && styles.fade)} aria-label={scope.q ? "Matching items" : TITLES[scope.kind]}>
            {docs.map((d, i) => {
              const title = displayTitle(d);
              const addr = addressOf(d);
              const copy = rowCopy(d);
              return (
                <DocRow
                  key={d.id}
                  doc={d}
                  title={title}
                  href={`/${d.slug}`}
                  address={addr.label}
                  statuses={rowStatuses(d, !!gStatus?.connected)}
                  onAccess={() => setShareFor(d)}
                  copy={copy}
                  menu={menuFor(d, title, addr.label, copy)}
                  phone={phone}
                  riseDelay={firstPaint.current ? Math.min(i, 8) * 20 : null}
                  menuLabel={`Actions for ${title}`}
                  chip={locationChip(d)}
                />
              );
            })}
          </ul>
          <ListFooter
            page={scope.page}
            pages={pages}
            shown={docs.length}
            total={total}
            perPage={PER_PAGE}
            onPage={(p) => { navigate({ page: p > 1 ? String(p) : null }); window.scrollTo({ top: 0 }); }}
            phone={phone}
          />
        </>
      )}

      {gStatus?.configured && gStatus.connected && !inWorkspace && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-4 text-caption text-text-muted">
          <Icon name="google" size={14} />
          Google Docs is connected.
          <Button variant="link" size="sm" onClick={() => setDisconnectOpen(true)}>Disconnect</Button>
        </p>
      )}

      {/* ── Overlays ── */}
      {shareFor && (
        <ShareDialog
          slug={shareFor.slug}
          documentId={shareFor.id}
          title={displayTitle(shareFor)}
          location={{ workspaceId: shareFor.workspace_id ?? null, folderId: shareFor.folder_id ?? null }}
          startWithLocation={shareAt}
          onClose={() => { setShareFor(null); setShareAt(false); }}
          onChanged={() => void load()}
        />
      )}

      <ChangeUrlDialog
        doc={renameFor}
        onClose={() => setRenameFor(null)}
        onChanged={(_old, next) => {
          setRenameFor(null);
          toast.success(`Link changed to /${next}`);
          void load();
        }}
      />

      <DeleteDocDialog
        doc={deleteFor}
        onClose={() => setDeleteFor(null)}
        onDeleted={(slug) => {
          setDeleteFor(null);
          setDocs((ds) => ds.filter((x) => x.slug !== slug));
          toast.success(`Deleted /${slug}`);
          void load();
        }}
      />

      <MoveToDialog
        workspace={{
          id: moveFor?.workspace_id ?? "",
          name: moveTree?.workspace.name ?? workspaces?.find((w) => w.id === moveFor?.workspace_id)?.name ?? "Workspace",
          branding: workspaces?.find((w) => w.id === moveFor?.workspace_id)?.branding ?? ({} as Workspace["branding"]),
        }}
        tree={moveTree}
        target={moveFor ? { kind: "items", slugs: [moveFor.slug], label: displayTitle(moveFor), fromFolderId: moveFor.folder_id ?? null } : null}
        onClose={() => setMoveFor(null)}
        onMoved={(dest) => {
          const d = moveFor;
          setMoveFor(null);
          if (d?.workspace_id) workspaceChanged(d.workspace_id);
          if (d) toast.success(`Moved “${displayTitle(d)}” to ${dest.label}`);
          void load();
        }}
      />

      <AnalyticsDrawer
        doc={analytics?.doc ?? null}
        title={analytics?.title ?? ""}
        address={analytics?.address ?? ""}
        copyText={analytics?.copyText ?? null}
        onClose={() => setAnalytics(null)}
      />

      <ConfirmDialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        title="Disconnect Google Docs?"
        body={<p className="text-body text-text-secondary">Markdrop's access to your Google account is revoked. Docs you already exported stay in your Google Drive but stop syncing.</p>}
        confirmLabel="Disconnect"
        onConfirm={async () => {
          const status = await disconnectGoogleDocs();
          setGStatus(status);
          setDocs((ds) => ds.map((d) => ({ ...d, google_doc_url: null, google_doc_stale: false })));
          setDisconnectOpen(false);
          toast.success("Google Docs disconnected");
        }}
      />
    </div>
  );
}

/** Below the first-run empty state: the other ways in (Dashboard board, empty state). */
function OtherWays() {
  const rows = [
    { href: "/upload", icon: "upload", tint: "var(--cat-artifact)", title: "Upload a file", desc: "HTML page, PDF, sheet, Word doc, video or site" },
    { href: "/builder", icon: "lines", tint: "var(--cat-builder)", title: "Build a README", desc: "Assemble a README from ready-made blocks" },
    { href: "/settings/tokens", icon: "vscode", tint: "var(--cat-sync)", title: "Sync from VS Code", desc: "Install Markdrop Sync, run Markdrop: Sign in, and approve in the browser. We create the token for you." },
  ];
  return (
    <section aria-labelledby="md-other-ways" className="flex flex-col gap-2">
      <h2 id="md-other-ways" className="text-eyebrow text-text-muted uppercase">Other ways to publish</h2>
      <ul className="grid gap-2 sm:grid-cols-3">
        {rows.map((r) => (
          <li key={r.href} className="min-w-0">
            <Anchor href={r.href} className="md-focus flex h-full min-w-0 items-start gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-surface-hover">
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ color: r.tint, background: "color-mix(in srgb, currentColor 12%, transparent)" }}>
                {r.icon === "vscode" ? <VSCodeIcon size={16} /> : <Icon name={r.icon} size={16} />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-strong text-text">{r.title}</span>
                <span className="text-caption text-text-muted">{r.desc}</span>
              </span>
            </Anchor>
          </li>
        ))}
      </ul>
    </section>
  );
}
