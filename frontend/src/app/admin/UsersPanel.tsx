"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, EmptyState, Input, Pagination, Progress, Skeleton, Table, type Column } from "@/components/ui";
import { adminListUsers, type AdminUserListItem } from "@/lib/api";
import { PageHead, PersonAvatar, bytes, fmtDate, isUnauthorized, plural, useOnUnauthorized } from "./shared";

const PROVIDER: Record<string, string> = { google: "Google", github: "GitHub", email: "Email", magic: "Email" };

function Identity({ u }: { u: AdminUserListItem }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <PersonAvatar name={u.name || u.email} src={u.picture} size="md" />
      <span className="flex min-w-0 flex-col">
        {u.name && <span className="truncate text-body-strong text-text" dir="auto">{u.name}</span>}
        <span className="truncate text-caption text-text-secondary">{u.email}</span>
      </span>
    </span>
  );
}

function Providers({ u }: { u: AdminUserListItem }) {
  if (!u.providers.length) return <span className="text-text-muted">—</span>;
  return <span className="flex flex-wrap gap-1">{u.providers.map((p) => <Badge key={p} size="sm" tone="neutral">{PROVIDER[p] ?? p}</Badge>)}</span>;
}

function VSCode({ u }: { u: AdminUserListItem }) {
  if (u.vscode_last_synced_at) {
    return (
      <Badge size="sm" tone="success" icon="check" title={`Last synced ${new Date(u.vscode_last_synced_at).toLocaleString("en-GB")} · ${plural(u.vscode_token_count, "token")}`}>
        Synced {fmtDate(u.vscode_last_synced_at, false)}
      </Badge>
    );
  }
  if (u.vscode_token_count > 0) return <Badge size="sm" tone="warning" icon="alert">Token, never synced</Badge>;
  return <span className="text-text-muted">—</span>;
}

function Drive({ u }: { u: AdminUserListItem }) {
  if (!u.google_connected) return <span className="text-text-muted">—</span>;
  return <Badge size="sm" tone="info" icon="check">{u.google_export_count ? `${u.google_export_count} exported` : "Connected"}</Badge>;
}

const dash = (n: number, s = String(n)) => (n ? s : <span className="text-text-muted">—</span>);

/** Their PostHog journey (Journeys resolves the account id, their distinct id, to the person). */
function JourneyLink({ u }: { u: AdminUserListItem }) {
  const href = `/admin?tab=journeys&person=${encodeURIComponent(u.id)}`;
  return (
    <a
      href={href}
      className="md-focus inline-flex min-h-8 items-center gap-1 whitespace-nowrap rounded-sm text-caption font-medium text-accent-text hover:underline"
      aria-label={`Journey of ${u.name || u.email}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        window.history.pushState(window.history.state, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
        window.scrollTo({ top: 0 });
      }}
    >
      Journey<span aria-hidden>↗</span>
    </a>
  );
}

export function UsersPanel({ token }: { token: string }) {
  const onUnauthorized = useOnUnauthorized();
  const [users, setUsers] = useState<AdminUserListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const r = await adminListUsers(token, page, q || undefined);
      setUsers(r.users);
      setTotal(r.total);
      setPages(r.pages);
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(true);
    } finally {
      setLoading(false);
    }
  }, [token, page, q, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onSearch = (v: string) => {
    setQuery(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setPage(1); setQ(v); }, 400);
  };

  const columns: Column<AdminUserListItem>[] = [
    { key: "user", header: "User", primary: true, render: (u) => <Identity u={u} /> },
    { key: "signin", header: "Sign-in", render: (u) => <Providers u={u} /> },
    { key: "docs", header: "Docs", align: "right", render: (u) => dash(u.document_count) },
    { key: "vscode", header: "VS Code", render: (u) => <VSCode u={u} /> },
    { key: "drive", header: "Drive", render: (u) => <Drive u={u} /> },
    { key: "shares", header: "Shares", align: "right", render: (u) => dash(u.share_count) },
    { key: "artifacts", header: "Artifacts", align: "right", render: (u) => dash(u.artifact_count, `${u.artifact_count} · ${bytes(u.artifact_bytes)}`) },
    { key: "last", header: "Last sign-in", render: (u) => <span className="whitespace-nowrap">{fmtDate(u.last_login_at)}</span> },
    { key: "journey", header: <span className="md-visually-hidden">Journey</span>, render: (u) => <JourneyLink u={u} /> },
  ];

  return (
    <>
      <PageHead title="Users" caption={`${plural(total, "account")}${q ? " match this search" : ""}.`} />
      <Input
        type="search"
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search by email or name"
        aria-label="Search users"
        prefix="search"
        wrapClassName="mb-4 max-w-md"
      />
      {loading && users && <Progress indeterminate size="sm" aria-label="Updating users" valueText="Loading" className="mb-2" />}
      {error ? (
        <Alert tone="danger" title="Couldn't load users" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>
          Check that the API is reachable, then retry.
        </Alert>
      ) : !users ? (
        <div className="flex flex-col gap-2" aria-busy="true"><span className="md-visually-hidden">Loading users</span>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="rect" height={52} />)}</div>
      ) : users.length === 0 ? (
        <EmptyState icon="users" title={q ? "No users match" : "No users yet"} description={q ? "Try another name or address." : undefined} />
      ) : (
        <>
          <div className="hidden lg:block"><Table columns={columns} rows={users} rowKey={(u) => u.id} hover={false} caption="Users" /></div>
          <ul className="flex flex-col gap-2 lg:hidden">
            {users.map((u) => (
              <li key={u.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-3">
                <div className="flex min-w-0 items-start justify-between gap-3"><Identity u={u} /><JourneyLink u={u} /></div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-caption sm:grid-cols-4">
                  <div className="min-w-0"><dt className="text-text-muted">Sign-in</dt><dd className="mt-0.5"><Providers u={u} /></dd></div>
                  <div className="min-w-0"><dt className="text-text-muted">Docs</dt><dd className="mt-0.5 tabular-nums text-text">{dash(u.document_count)}</dd></div>
                  <div className="min-w-0"><dt className="text-text-muted">VS Code</dt><dd className="mt-0.5"><VSCode u={u} /></dd></div>
                  <div className="min-w-0"><dt className="text-text-muted">Drive</dt><dd className="mt-0.5"><Drive u={u} /></dd></div>
                  <div className="min-w-0"><dt className="text-text-muted">Shares</dt><dd className="mt-0.5 tabular-nums text-text">{dash(u.share_count)}</dd></div>
                  <div className="min-w-0"><dt className="text-text-muted">Artifacts</dt><dd className="mt-0.5 tabular-nums text-text">{dash(u.artifact_count, `${u.artifact_count} · ${bytes(u.artifact_bytes)}`)}</dd></div>
                  <div className="col-span-2 min-w-0"><dt className="text-text-muted">Last sign-in</dt><dd className="mt-0.5 text-text">{fmtDate(u.last_login_at)}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-caption text-text-muted">Page {page} of {pages} · {plural(total, "user")}</p>
              <Pagination page={page} pageCount={pages} onChange={setPage} />
            </div>
          )}
        </>
      )}
    </>
  );
}
