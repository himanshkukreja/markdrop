"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, cx } from "@/components/ui";
import {
  ApiError, adminAddAdmin, adminAdminCandidates, adminListAdmins, adminRemoveAdmin,
  type AddedAdmin, type AdminCandidate, type AdminChange, type AdminPerson, type AdminsList,
} from "@/lib/api";
import { LoadingBlock, PageHead, PersonAvatar, fmtDate, fmtDateTime, isUnauthorized, useOnUnauthorized } from "./shared";

/**
 * Admin › Admins (backend routers/admin_roles): who can open this console. Owners come from the
 * server (MARKDROP_ADMIN_EMAILS) and can't be removed here; admins are added by an owner and get
 * every page but this one's changes. Only owners see Add / Remove (the API checks too). A change
 * needs a sign-in within the last day: a 401 on a change asks the owner to sign in again.
 * Every change is audited (Recent changes) and emailed to every owner.
 */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SIGN_IN_AGAIN = `/login?next=${encodeURIComponent("/admin?tab=admins")}`;
const POWERS = "see every user, document, analytics, email and AI log in this console";

type Row = (AdminPerson & { owner: true }) | (AddedAdmin & { owner: false });

function Who({ p, you }: { p: AdminPerson; you: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <PersonAvatar name={p.name || p.email} src={p.picture} size="md" />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-body-strong text-text" dir="auto">{p.name || p.email}</span>
          {you && <Badge size="sm" tone="neutral">You</Badge>}
        </span>
        {p.name && <span className="ph-sensitive truncate text-caption text-text-secondary">{p.email}</span>}
      </span>
    </span>
  );
}

function RoleBadges({ r }: { r: Row }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {r.owner ? <Badge size="sm" tone="info" icon="shieldCheck">Owner</Badge> : <Badge size="sm" tone="neutral">Admin</Badge>}
      {!r.has_account && <Badge size="sm" tone="warning" title="Nobody has signed in with this address yet. It becomes an admin on the first sign-in.">Pending sign-in</Badge>}
      {r.disabled && <Badge size="sm" tone="danger">Account disabled</Badge>}
    </span>
  );
}

function Meta({ r }: { r: Row }) {
  const added = r.owner ? "Set on the server" : `Added by ${r.added_by || "the server (break-glass)"}${r.added_at ? ` · ${fmtDate(r.added_at)}` : ""}`;
  const visit = r.last_visit_at ? `Last visit ${fmtDateTime(r.last_visit_at)}` : "Hasn't opened the console yet";
  return (
    <span className="flex min-w-0 flex-col gap-0.5 text-caption text-text-muted">
      <span className="truncate">{added}</span>
      <span className="truncate">{visit}</span>
      {!r.owner && r.note && <span className="truncate text-text-secondary" dir="auto">“{r.note}”</span>}
    </span>
  );
}

function ChangeLine({ c }: { c: AdminChange }) {
  const actor = c.actor || (c.via === "break_glass" ? "The server (break-glass)" : "Someone");
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-3 text-body">
      <span className="min-w-0 break-all text-text-secondary">{actor}</span>
      <Badge size="sm" tone={c.action === "add" ? "success" : "neutral"}>{c.action === "add" ? "added" : "removed"}</Badge>
      <span className="min-w-0 break-all text-text">{c.target}</span>
      {c.note && <span className="min-w-0 text-text-muted" dir="auto">· {c.note}</span>}
      <span className="ml-auto whitespace-nowrap text-caption text-text-muted" title={new Date(c.at).toLocaleString("en-GB")}>{fmtDateTime(c.at)}</span>
    </li>
  );
}

/** The add form: an email (or a pick from matching accounts), an optional note, then a confirm step. */
function AddDialog({ token, open, onClose, onAdded, onReauth, existing }: {
  token: string; open: boolean; onClose: () => void; onAdded: (email: string, pending: boolean) => void;
  onReauth: () => void; existing: Set<string>;
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<AdminCandidate | null>(null);
  const [matches, setMatches] = useState<AdminCandidate[]>([]);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail(""); setNote(""); setPicked(null); setMatches([]); setStep("form"); setError(null); setBusy(false);
  }, [open]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const clean = email.trim().toLowerCase();
  const valid = EMAIL_RE.test(clean) && clean.length <= 254;
  const already = existing.has(clean);

  const search = (v: string) => {
    setEmail(v);
    setPicked(null);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    const q = v.trim();
    if (q.length < 2) { setMatches([]); return; }
    timer.current = setTimeout(() => {
      adminAdminCandidates(token, q).then(setMatches).catch((e) => {
        if (isUnauthorized(e)) onReauth();
        setMatches([]);
      });
    }, 250);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await adminAddAdmin(token, clean, note.trim() || undefined);
      onAdded(r.email, r.pending);
    } catch (e) {
      if (isUnauthorized(e)) { onReauth(); return; }
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Couldn't add the admin.");
      setStep("form");
    } finally {
      setBusy(false);
    }
  };

  const known = picked ?? matches.find((m) => m.email === clean) ?? null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={step === "form" ? "Add an admin" : `Make ${clean} an admin?`}
      description={step === "form" ? "Pick an account, or type the address they sign in with." : undefined}
      tone="default"
      footer={step === "form" ? (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => setStep("confirm")} disabled={!valid || already}>Continue</Button>
        </>
      ) : (
        <>
          <Button variant="secondary" onClick={() => setStep("form")} disabled={busy}>Back</Button>
          <Button onClick={() => void submit()} loading={busy} iconLeft="shieldCheck">Make admin</Button>
        </>
      )}
    >
      {step === "form" ? (
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (valid && !already) setStep("confirm"); }}>
          <Field label="Email or name" hint={already ? undefined : "Search existing accounts, or type a full address to invite someone who hasn't signed up yet."}
            error={already ? "Already an owner or an admin." : error ?? undefined}>
            <Input type="search" value={email} onChange={(e) => search(e.target.value)} placeholder="name@example.com" autoComplete="off"
              autoCapitalize="none" spellCheck={false} prefix="search" aria-controls="admin-candidates" />
          </Field>
          {matches.length > 0 && (
            <ul id="admin-candidates" aria-label="Matching accounts" className="-mt-2 flex max-h-64 flex-col overflow-y-auto rounded-lg border border-border">
              {matches.map((m) => (
                <li key={m.email} className="border-b border-border last:border-b-0">
                  <button type="button" disabled={!!m.role}
                    className={cx("md-focus flex min-h-11 w-full min-w-0 items-center gap-2.5 bg-transparent px-3 py-2 text-left",
                      m.role ? "cursor-default opacity-60" : "cursor-pointer hover:bg-surface-hover", m.email === clean && "bg-accent-soft")}
                    onClick={() => { setEmail(m.email); setPicked(m); setMatches([]); }}>
                    <PersonAvatar name={m.name || m.email} src={m.picture} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body text-text" dir="auto">{m.name || m.email}</span>
                      {m.name && <span className="truncate text-caption text-text-muted">{m.email}</span>}
                    </span>
                    {m.role && <Badge size="sm" tone="neutral">{m.role === "owner" ? "Owner" : "Admin"}</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Field label="Note (optional)" hint="Why they have access, for the other owners. Shown in the list and the emails.">
            <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Runs support" />
          </Field>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <Alert tone="warning" title="This is full read access">
            They&apos;ll be able to {POWERS}, and to moderate documents. They can&apos;t change who is an admin.
          </Alert>
          {known ? (
            <p className="text-body text-text-secondary">{known.name ? `${known.name} (${known.email})` : known.email} has a Markdrop account and gets access on their next visit.</p>
          ) : (
            <p className="text-body text-text-secondary">If nobody has an account with this address yet, it becomes an admin the first time someone signs in with it (a verified sign-in, Google or an emailed code).</p>
          )}
          <p className="text-caption text-text-muted">Every owner gets an email about this change, and so do they.</p>
        </div>
      )}
    </Dialog>
  );
}

export function AdminsPanel({ token }: { token: string }) {
  const onUnauthorized = useOnUnauthorized();
  const [data, setData] = useState<AdminsList | null>(null);
  const [error, setError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<AddedAdmin | null>(null);
  const [reauth, setReauth] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      setData(await adminListAdmins(token));
    } catch (e) {
      if (isUnauthorized(e)) onUnauthorized();
      else setError(true);
    }
  }, [token, onUnauthorized]);
  useEffect(() => { void load(); }, [load]);

  const askReauth = () => { setAdding(false); setRemoving(null); setReauth(true); };

  if (error && !data) {
    return (
      <>
        <PageHead title="Admins" />
        <Alert tone="danger" title="Couldn't load the admins" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>
          Check that the API is reachable, then retry.
        </Alert>
      </>
    );
  }
  if (!data) return (<><PageHead title="Admins" /><LoadingBlock size="md" label="Loading admins" minHeight={320} /></>);

  const manage = data.can_manage;
  const rows: Row[] = [
    ...data.owners.map((o) => ({ ...o, owner: true as const })),
    ...data.admins.map((a) => ({ ...a, owner: false as const })),
  ];
  const existing = new Set(rows.map((r) => r.email));

  return (
    <>
      <PageHead
        title="Admins"
        caption={manage
          ? "Who can open this console. Owners are set on the server; you add and remove admins here."
          : "Who can open this console. Only an owner can add or remove admins."}
        actions={manage ? <Button iconLeft="userPlus" onClick={() => { setMsg(null); setAdding(true); }}>Add admin</Button> : undefined}
      />
      {msg && <Alert tone="success" className="mb-4" onDismiss={() => setMsg(null)} live>{msg}</Alert>}

      <section aria-labelledby="admins-who" className="mb-8">
        <h2 id="admins-who" className="mb-2 text-h4 text-text">Who has access <span className="text-text-muted tabular-nums">· {rows.length}</span></h2>
        {rows.length === 0 ? (
          <EmptyState icon="users" title="No admins" />
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface" data-testid="admins-list">
            {rows.map((r) => (
              <li key={r.email} className={cx("grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 p-3 sm:p-4 md:items-center",
                // A fixed actions column, so every row's middle column lines up (owners have no Remove).
                manage ? "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_6rem]" : "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_0]")} data-email={r.email}>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <Who p={r} you={r.email === data.you} />
                  <span className="md:hidden"><RoleBadges r={r} /></span>
                </span>
                <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-1 md:col-start-2 flex flex-col gap-1.5">
                  <span className="hidden md:block"><RoleBadges r={r} /></span>
                  <Meta r={r} />
                </span>
                <span className="col-start-2 row-start-1 md:col-start-3 flex justify-end">
                  {manage && !r.owner && (
                    <Button size="sm" variant="ghost" className="max-md:min-h-11" onClick={() => { setMsg(null); setRemoving(r); }} aria-label={`Remove ${r.email} as admin`}>
                      Remove
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="admins-history">
        <h2 id="admins-history" className="mb-2 text-h4 text-text">Recent changes</h2>
        {data.history.length === 0 ? (
          <p className="text-body text-text-muted">No admins have been added or removed yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
            {data.history.map((c) => <ChangeLine key={c.id} c={c} />)}
          </ul>
        )}
      </section>

      {manage && (
        <AddDialog token={token} open={adding} onClose={() => setAdding(false)} onReauth={askReauth} existing={existing}
          onAdded={(email, pending) => {
            setAdding(false);
            setMsg(pending ? `${email} is an admin as soon as they first sign in with that address. We've emailed them.` : `${email} is now an admin. We've emailed them and every owner.`);
            void load();
          }} />
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.email ?? ""} as admin?`}
        body={<p className="text-body text-text-secondary">Their next request to the console is refused. Their Markdrop account and documents aren&apos;t touched. Every owner gets an email about this change.</p>}
        confirmLabel="Remove admin"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await adminRemoveAdmin(token, removing.email);
          } catch (e) {
            if (isUnauthorized(e)) { askReauth(); return; }
            throw e;
          }
          setMsg(`${removing.email} is no longer an admin.`);
          setRemoving(null);
          void load();
        }}
      />
      <Dialog open={reauth} onClose={() => setReauth(false)} title="Sign in again to change admins"
        description="Adding or removing an admin needs a sign-in from the last day. You'll come straight back here."
        footer={<><Button variant="secondary" onClick={() => setReauth(false)}>Not now</Button><Button href={SIGN_IN_AGAIN}>Sign in again</Button></>}
      />
    </>
  );
}

export default AdminsPanel;
