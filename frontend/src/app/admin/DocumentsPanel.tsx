"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MarkdownPreview from "@/components/MarkdownPreview";
import { MetaList } from "@/components/kit/MetaList";
import {
  Alert, Badge, Button, ConfirmDialog, Progress, Drawer, EmptyState, FileIcon, Icon, Input, Pagination, RowMenu, Skeleton,
  Switch, Table, Tabs, Tooltip, copyText, useToast, type Column, type MenuItem,
} from "@/components/ui";
import {
  adminDeleteDocument, adminGetDocument, adminListDocuments,
  type AdminDocListItem, type DocKind, type DocumentResponse,
} from "@/lib/api";
import { PageHead, PersonAvatar, bytes, expiryLabel, fmtDate, iconRenderer, isUnauthorized, plural, useOnUnauthorized } from "./shared";

/** The list endpoint also returns `encrypted` (title and preview are withheld for those). */
export type AdminDoc = AdminDocListItem & { encrypted?: boolean };

export interface DocFilters { q: string; kind: DocKind | "all"; reported: boolean; page: number }
export const DEFAULT_DOC_FILTERS: DocFilters = { q: "", kind: "all", reported: false, page: 1 };

const KIND_TABS = [
  { value: "all", label: "All" },
  { value: "markdown", label: "Docs" },
  { value: "artifact", label: "Artifacts" },
];

function docUrl(slug: string) {
  return `${typeof window === "undefined" ? "https://markdrop.in" : window.location.origin}/${slug}`;
}

function DocTitle({ d }: { d: AdminDoc }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {d.encrypted ? (
        <span className="grid size-5 shrink-0 place-items-center text-text-muted"><Icon name="key" size={18} /></span>
      ) : d.kind === "artifact" ? (
        <FileIcon renderer={iconRenderer(d.renderer)} name={d.original_filename ?? ""} mime={d.mime ?? ""} size={20} />
      ) : (
        <span className="grid size-5 shrink-0 place-items-center text-cat-document"><Icon name="lines" size={18} /></span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`truncate ${d.encrypted ? "italic text-text-secondary" : "text-text"}`} dir="auto">
            {d.encrypted ? "Encrypted document" : d.title || "Untitled"}
          </span>
          {d.is_password_protected && (
            <Tooltip content="Password protected" focusable>
              <span className="inline-flex text-text-muted"><Icon name="lock" size={14} /><span className="md-visually-hidden">Password protected</span></span>
            </Tooltip>
          )}
        </span>
        <code className="truncate font-mono text-micro text-text-muted">/{d.slug}</code>
      </span>
    </span>
  );
}

function Owner({ d }: { d: AdminDoc }) {
  if (!d.owner_email) return <span className="text-text-muted">Anonymous</span>;
  return (
    <span className="flex min-w-0 items-center gap-2" title={d.owner_id ?? undefined}>
      <PersonAvatar name={d.owner_email} />
      <span className="truncate">{d.owner_email}</span>
    </span>
  );
}

function Reports({ n }: { n: number }) {
  if (!n) return <span className="text-text-muted">—</span>;
  return <Badge tone="warning" icon="flag" size="sm" className="tabular-nums">{n}<span className="md-visually-hidden"> {n === 1 ? "report" : "reports"}</span></Badge>;
}

function Expires({ iso }: { iso: string | null }) {
  const e = expiryLabel(iso);
  return <Badge size="sm" tone={e.tone} icon={e.tone === "neutral" ? undefined : "clock"}>{e.text}</Badge>;
}

const sizeOf = (d: AdminDoc) => (d.kind === "artifact" ? bytes(d.size_bytes ?? 0) : `${d.content_length.toLocaleString("en")} chars`);

export function DocumentsPanel({ token, filters, setFilters, reportsView, onEdit, onChanged }: {
  token: string;
  filters: DocFilters;
  setFilters: (f: DocFilters) => void;
  /** The "Reports" rail item: the same table, locked to reported documents, most reports first. */
  reportsView?: boolean;
  onEdit: (slug: string) => void;
  /** After a delete (refreshes the rail counts). */
  onChanged: () => void;
}) {
  const onUnauthorized = useOnUnauthorized();
  const toast = useToast();
  const [docs, setDocs] = useState<AdminDoc[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(filters.q);
  const [confirm, setConfirm] = useState<AdminDoc | null>(null);
  const [open, setOpen] = useState<AdminDoc | null>(null);
  const reported = reportsView || filters.reported;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await adminListDocuments(token, filters.page, 20, filters.q || undefined, reported, filters.kind === "all" ? undefined : filters.kind);
      setDocs(res.documents as AdminDoc[]);
      setTotal(res.total);
      setPages(res.pages);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(true);
    } finally {
      setLoading(false);
    }
  }, [token, filters.page, filters.q, filters.kind, reported, onUnauthorized]);

  useEffect(() => { void load(); }, [load]);

  const onSearch = (v: string) => {
    setQuery(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFilters({ ...filters, q: v, page: 1 }), 400);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Delete keeps every filter and the page (the old table reloaded with search only, dropping the
  // kind and "reported" filters). If the page empties, step back one.
  const remove = async (d: AdminDoc) => {
    try {
      await adminDeleteDocument(token, d.slug);
    } catch (e) {
      if (isUnauthorized(e)) { onUnauthorized(); return; }
      throw new Error("Couldn't delete the document. Check your connection and try again.");
    }
    setConfirm(null);
    setOpen((o) => (o?.slug === d.slug ? null : o));
    toast.success("Document deleted");
    onChanged();
    if (docs && docs.length === 1 && filters.page > 1) setFilters({ ...filters, page: filters.page - 1 });
    else void load();
  };

  const menu = (d: AdminDoc): MenuItem[] => [
    { label: "Open", icon: "external", href: `/${d.slug}`, external: true },
    {
      label: "Edit", icon: "edit", onClick: () => onEdit(d.slug), disabled: !!d.encrypted,
      caption: d.encrypted ? "Encrypted: the content can't be read here" : undefined,
    },
    { label: "Copy link", icon: "link", onClick: () => { void copyText(docUrl(d.slug)).then((ok) => (ok ? toast.success("Link copied") : toast.error("Couldn't copy the link."))); } },
    { label: "Delete document", icon: "trash", danger: true, separated: true, onClick: () => setConfirm(d) },
  ];

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const columns: Column<AdminDoc>[] = [
    { key: "doc", header: "Document", primary: true, render: (d) => <DocTitle d={d} /> },
    { key: "owner", header: "Owner", render: (d) => <span className="block max-w-[14rem] text-caption text-text-secondary"><Owner d={d} /></span> },
    { key: "reports", header: "Reports", render: (d) => <Reports n={d.report_count} /> },
    { key: "views", header: "Views", align: "right", render: (d) => d.views.toLocaleString("en") },
    { key: "created", header: "Created", render: (d) => <span className="whitespace-nowrap">{fmtDate(d.created_at)}</span> },
    { key: "expires", header: "Expires", render: (d) => <Expires iso={d.expires_at} /> },
    { key: "size", header: "Size", align: "right", render: (d) => <span className="whitespace-nowrap">{sizeOf(d)}</span> },
    { key: "menu", header: <span className="md-visually-hidden">Actions</span>, width: 48, render: (d) => (
      <span onClick={stop} onKeyDown={stop} className="flex justify-end"><RowMenu items={menu(d)} label={`Actions for ${d.encrypted ? "encrypted document" : d.title || d.slug}`} portal align="right" /></span>
    ) },
  ];

  const filtered = !!filters.q || filters.kind !== "all" || (!reportsView && filters.reported);

  return (
    <>
      <PageHead
        title={reportsView ? "Reports" : "Documents"}
        caption={reportsView
          ? "Documents readers have reported, most reports first. Open one to triage it."
          : `${plural(total, "document")}${filtered ? " match these filters" : " published"}.`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={query}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search slug, title or content"
          aria-label="Search documents"
          prefix="search"
          wrapClassName="min-w-0 flex-[1_1_16rem]"
        />
        <Tabs variant="pill" items={KIND_TABS} value={filters.kind} aria-label="Kind"
          onChange={(v) => setFilters({ ...filters, kind: v as DocFilters["kind"], page: 1 })} />
        {!reportsView && (
          <span className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3">
            <Icon name="flag" size={16} className="text-warning" />
            <Switch label="Reported only" checked={filters.reported} onChange={(e) => setFilters({ ...filters, reported: e.target.checked, page: 1 })} />
          </span>
        )}
      </div>

      {loading && docs && <Progress indeterminate size="sm" aria-label="Updating documents" valueText="Loading" className="mb-2" />}

      {error ? (
        <Alert tone="danger" title="Couldn't load documents" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>
          Check that the API is reachable, then retry.
        </Alert>
      ) : !docs ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="md-visually-hidden">Loading documents</span>
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="rect" height={52} />)}
        </div>
      ) : docs.length === 0 ? (
        <EmptyState
          icon={reported ? "flag" : "inbox"}
          title={reported ? "No reported documents" : filtered ? "No documents match" : "No documents yet"}
          description={reported ? "Nothing has been reported by readers." : filtered ? "Try another search or clear the filters." : undefined}
          actions={filtered ? <Button variant="secondary" onClick={() => { setQuery(""); setFilters({ ...filters, q: "", kind: "all", reported: false, page: 1 }); }}>Clear filters</Button> : undefined}
        />
      ) : (
        <>
          <div className="hidden md:block">
            <Table columns={columns} rows={docs} rowKey={(d) => d.slug} onRowClick={(d) => setOpen(d)} caption={reportsView ? "Reported documents" : "Documents"} />
          </div>
          <ul className="flex flex-col gap-2 md:hidden">
            {docs.map((d) => (
              <li key={d.slug} className="flex min-w-0 items-start gap-2 rounded-xl border border-border bg-surface p-3">
                <button type="button" onClick={() => setOpen(d)} className="md-focus flex min-w-0 flex-1 flex-col gap-2 rounded-lg text-left">
                  <DocTitle d={d} />
                  <span className="flex flex-wrap items-center gap-2 text-caption text-text-secondary">
                    <span>{plural(d.views, "view")}</span>
                    <span aria-hidden>·</span>
                    <span>{fmtDate(d.created_at)}</span>
                    <Reports n={d.report_count} />
                    {d.expires_at && <Expires iso={d.expires_at} />}
                  </span>
                </button>
                <RowMenu items={menu(d)} label={`Actions for ${d.encrypted ? "encrypted document" : d.title || d.slug}`} portal align="right" />
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-caption text-text-muted">Page {filters.page} of {pages} · {plural(total, "document")}</p>
              <Pagination page={filters.page} pageCount={pages} onChange={(p) => setFilters({ ...filters, page: p })} />
            </div>
          )}
        </>
      )}

      <DocDrawer token={token} doc={open} onClose={() => setOpen(null)} onEdit={onEdit} onDelete={(d) => setConfirm(d)} />

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => (confirm ? remove(confirm) : undefined)}
        title="Delete this document?"
        body={confirm && (
          <p className="text-body text-text-secondary">
            <span className="font-mono text-text">/{confirm.slug}</span> stops opening for everyone, and its edit link stops working. This can&apos;t be undone.
          </p>
        )}
        confirmLabel="Delete document"
      />
    </>
  );
}

/** Row drawer: the metadata and a read-only preview, for triage without leaving the list. */
function DocDrawer({ token, doc, onClose, onEdit, onDelete }: {
  token: string; doc: AdminDoc | null; onClose: () => void; onEdit: (slug: string) => void; onDelete: (d: AdminDoc) => void;
}) {
  const onUnauthorized = useOnUnauthorized();
  const [full, setFull] = useState<DocumentResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [last, setLast] = useState<AdminDoc | null>(doc);
  useEffect(() => { if (doc) setLast(doc); }, [doc]);

  useEffect(() => {
    setFull(null);
    setFailed(false);
    if (!doc || doc.encrypted || doc.kind === "artifact") return;
    let live = true;
    adminGetDocument(token, doc.slug)
      .then((r) => live && setFull(r))
      .catch((e) => { if (!live) return; if (isUnauthorized(e)) onUnauthorized(); else setFailed(true); });
    return () => { live = false; };
  }, [doc, token, onUnauthorized]);

  const d = doc ?? last;
  return (
    <Drawer
      open={!!doc}
      onClose={onClose}
      width={560}
      title={d ? (d.encrypted ? "Encrypted document" : d.title || "Untitled") : "Document"}
      description={d ? <span className="font-mono">/{d.slug}</span> : undefined}
      footer={d && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" iconLeft="external" href={`/${d.slug}`} target="_blank" rel="noopener noreferrer">Open</Button>
          {!d.encrypted && <Button variant="secondary" iconLeft="edit" onClick={() => onEdit(d.slug)}>Edit</Button>}
          <Button variant="danger" iconLeft="trash" className="ml-auto" onClick={() => onDelete(d)}>Delete document</Button>
        </div>
      )}
    >
      {d && (
        <div className="flex flex-col gap-5">
          <MetaList size="sm" items={[
            { k: "Kind", v: d.kind === "artifact" ? (d.type_label || "Artifact") : "Markdown document" },
            ...(d.original_filename ? [{ k: "File", v: d.original_filename, mono: true }] : []),
            { k: "Owner", v: d.owner_email ?? "Anonymous" },
            { k: "Views", v: d.views.toLocaleString("en") },
            { k: "Reports", v: <Reports n={d.report_count} /> },
            { k: "Created", v: fmtDate(d.created_at) },
            { k: "Updated", v: fmtDate(d.updated_at) },
            { k: "Expires", v: <Expires iso={d.expires_at} /> },
            { k: "Size", v: sizeOf(d) },
            { k: "Password", v: d.is_password_protected ? "Protected" : "None" },
          ]} />
          <section aria-labelledby="doc-preview-h" className="flex flex-col gap-2">
            <h3 id="doc-preview-h" className="text-eyebrow uppercase text-text-muted">Preview</h3>
            {d.encrypted ? (
              <Alert tone="neutral" icon="key">Markdrop stores ciphertext it has no key for, so this document can&apos;t be previewed or edited here. Delete and expiry still work.</Alert>
            ) : d.kind === "artifact" ? (
              <Alert tone="neutral" icon="shield">Artifacts render on the isolated artifact domain. Use Open to see it as readers do.</Alert>
            ) : failed ? (
              <Alert tone="danger">Couldn&apos;t load the preview. Close and reopen the document to try again.</Alert>
            ) : !full ? (
              <div className="flex flex-col gap-2" aria-busy="true"><Skeleton /><Skeleton width="80%" /><Skeleton width="60%" /></div>
            ) : (
              <div className="min-w-0 rounded-xl border border-border bg-bg p-4">
                <MarkdownPreview content={full.content} />
              </div>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
