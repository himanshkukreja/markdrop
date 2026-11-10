"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Badge, Button, Checkbox, ConfirmDialog, CopyButton, Dialog, Field, Icon, Input, SegmentedControl, Select, Skeleton, Spinner, useToast,
} from "@/components/ui";
import { updateTeam } from "@/lib/teams";
import {
  zoomConnect, zoomDisconnect, zoomImport, zoomRecordings, zoomSetTeam, zoomStatus,
  type ZoomRecording, type ZoomResult, type ZoomStatus,
} from "@/lib/zoom";

/**
 * Workspace settings › Integrations › Zoom. The workspace's Zoom admin makes a Server-to-Server OAuth app
 * in their own Zoom account (the steps are right here) and a workspace admin pastes its Account ID,
 * Client ID, Client Secret and Secret Token; Markdrop checks them with Zoom and lists missing scopes.
 * Recorded meetings hosted by members of the chosen team come in on their own, visible to that team;
 * admins and the team's leads import past ones (Import past meetings). Backend: routers/zoom.py.
 */
export function ZoomWorkspaceCard({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const toast = useToast();
  const [st, setSt] = useState<ZoomStatus | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setSt(await zoomStatus(id));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load Zoom's settings.");
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (error) {
    return <Alert tone="danger" title="Couldn't load Zoom" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{error}</Alert>;
  }
  if (!st) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5" aria-busy="true">
        <Skeleton width="40%" height={18} />
        <Skeleton width="80%" height={14} />
      </div>
    );
  }
  const c = st.connection;
  const showSetup = isAdmin && st.configured && (editing || !st.connected);

  return (
    <section aria-labelledby="zoom-h" data-testid="zoom-card" className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg text-text-secondary"><Icon name="film" size={18} /></span>
        <div className="min-w-0 flex-[1_1_280px]">
          <h2 id="zoom-h" className="flex flex-wrap items-center gap-2 text-body-strong text-text">
            Zoom
            {st.connected && <Badge tone="success" size="sm" dot data-testid="zoom-connected">Connected</Badge>}
            {!st.configured && <Badge size="sm">Not set up yet</Badge>}
          </h2>
          <p className="mt-0.5 text-[13px] leading-5 text-text-secondary">
            Recorded Zoom meetings hosted by one team&apos;s members become meetings in that team, with a summary, decisions and
            action items, and you can bring in past ones. Meetings hosted by anyone else are ignored.
          </p>
        </div>
      </div>

      {!st.configured && <p className="text-[13px] text-text-muted">Zoom isn&apos;t switched on for this server yet.</p>}
      {st.configured && !st.connected && !isAdmin && <p className="text-[13px] text-text-muted">A workspace admin connects Zoom here.</p>}

      {st.connected && c && !editing && (
        <>
          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-text-muted">Meetings go to</dt>
            <dd className="min-w-0 text-text" data-testid="zoom-team">
              {isAdmin && st.teams ? (
                <TeamPicker id={id} st={st} onSaved={(s) => { setSt(s); toast.success("Zoom meetings go to that team now."); }} />
              ) : st.team ? <>{st.team.name} <span className="text-text-muted">({st.team.visibility === "private" ? "private team" : "open team"})</span></>
                : <span className="text-text-muted">No team yet</span>}
            </dd>
            <dt className="text-text-muted">Imported</dt>
            <dd className="text-text" data-testid="zoom-counts">
              {c.imported} {c.imported === 1 ? "meeting" : "meetings"}
              {c.last_import_at ? <span className="text-text-muted"> · last {shortWhen(c.last_import_at)}</span> : null}
              {c.no_transcript ? <span className="text-text-muted"> · {c.no_transcript} without a transcript</span> : null}
            </dd>
            {isAdmin && (
              <>
                <dt className="text-text-muted">Zoom events</dt>
                <dd className="text-text" data-testid="zoom-verified">
                  {c.last_event_at ? <>Last one {shortWhen(c.last_event_at)}</> : c.verified ? "Zoom checked the endpoint; waiting for the first recording"
                    : <span className="text-text-muted">Zoom hasn&apos;t checked the endpoint yet (step 6 below)</span>}
                </dd>
                <dt className="text-text-muted">Zoom app</dt>
                <dd className="text-text">Account {c.account_id} · Client {c.client_id}{c.connected_by ? ` · connected by ${c.connected_by}` : ""}</dd>
              </>
            )}
          </dl>

          {!st.team && (
            <Alert tone="info" title="Pick a team">
              Nothing comes in until {isAdmin ? "you pick" : "an admin picks"} the team whose members&apos; Zoom meetings Markdrop brings in.
            </Alert>
          )}
          {st.team && st.team.visibility === "open" && (
            <div data-testid="zoom-open-team"><Alert tone="warning" title={`${st.team.name} is an open team`}
              actions={isAdmin ? (
                <Button size="sm" loading={busy === "private"} data-testid="zoom-make-private" onClick={async () => {
                  setBusy("private");
                  try {
                    await updateTeam(id, st.team!.id, { visibility: "private" });
                    await load();
                    toast.success(`${st.team!.name} is private now.`);
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "That didn't work.");
                  } finally { setBusy(""); }
                }}>Make it private</Button>
              ) : undefined}>
              Everyone in the workspace can read an open team&apos;s meetings. Make the team private so only its members (and
              workspace admins) see its Zoom calls.
            </Alert></div>
          )}
          {isAdmin && c.broken && (
            <div data-testid="zoom-broken"><Alert tone="danger" title="The Zoom connection needs attention">
              {c.broken === "credentials" ? "Zoom no longer accepts the app's credentials. Check that the app is still activated in Zoom, then paste them again."
                : c.broken === "deauthorized" ? "The Zoom app was removed or deactivated, so its credentials were deleted. Paste them again to reconnect."
                : c.broken === "missing_scopes" ? "The Zoom app is missing scopes Markdrop needs (below)." : c.test_error || c.broken}
            </Alert></div>
          )}
          {isAdmin && (c.missing_scopes?.length ?? 0) > 0 && (
            <div data-testid="zoom-missing-scopes"><Alert tone={c.missing_scopes!.some((m) => m.required) ? "warning" : "info"} title="Add these scopes to the Zoom app">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {c.missing_scopes!.map((m) => <li key={m.scope}><code className="text-[12px]">{m.scope}</code>: {m.why}{m.required ? "" : " (optional)"}</li>)}
              </ul>
              <p className="mt-1">Then save the credentials again here.</p>
            </Alert></div>
          )}
          {isAdmin && c.last_error && <p className="text-[13px] text-danger-text">Last problem: {c.last_error}</p>}

          {st.recent && st.recent.length > 0 && (
            <div className="flex min-w-0 flex-col gap-1.5">
              <h3 className="text-[13px] font-medium text-text">Latest from Zoom</h3>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" data-testid="zoom-recent">
                {st.recent.map((r) => (
                  <li key={r.uuid} className="flex min-w-0 flex-wrap items-center gap-2">
                    <StateBadge state={r.state} />
                    {r.slug && (r.state === "imported" || r.state === "duplicate")
                      ? <Link href={`/${r.slug}`} className="min-w-0 truncate text-accent-text hover:underline">{r.topic}</Link>
                      : <span className="min-w-0 truncate text-text">{r.topic}</span>}
                    <span className="text-text-muted">{r.date}{r.host ? ` · ${r.host}` : ""}</span>
                    {r.state === "failed" && r.reason ? <span className="text-text-muted">· {r.reason}</span> : null}
                  </li>
                ))}
              </ul>
              {st.recent.some((r) => r.state === "no_transcript") && <p className="text-caption text-text-muted">{st.no_transcript_help}</p>}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {st.can_import && (
              <Button size="sm" iconLeft="history" onClick={() => setImporting(true)} data-testid="zoom-import-open">Import past meetings</Button>
            )}
            {isAdmin && <Button size="sm" variant="secondary" iconLeft="key" onClick={() => setEditing(true)} data-testid="zoom-edit">Change credentials</Button>}
            {isAdmin && <Button size="sm" variant="secondary" iconLeft="logOut" onClick={() => setConfirm(true)}>Disconnect Zoom…</Button>}
          </div>
        </>
      )}

      {!st.connected && isAdmin && c?.broken && (
        <Alert tone="danger" title="Zoom was disconnected">
          {c.broken === "deauthorized" ? "The Zoom app was removed or deactivated, so its credentials were deleted. Paste them again to reconnect." : "Paste the app's credentials again to reconnect."}
        </Alert>
      )}

      {showSetup && (
        <Setup id={id} st={st} onCancel={st.connected ? () => setEditing(false) : undefined}
          onSaved={(s) => { setSt(s); setEditing(false); toast.success("Zoom is connected."); }} />
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Disconnect Zoom?"
        description={<>Markdrop deletes the Zoom app&apos;s credentials and stops bringing in meetings. Meetings already imported stay. You can also delete the app in Zoom.</>}
        confirmLabel="Disconnect"
        onConfirm={async () => {
          setSt(await zoomDisconnect(id));
          setConfirm(false);
          toast.success("Zoom is disconnected.");
        }}
      />
      {importing && <Importer id={id} st={st} onClose={() => { setImporting(false); void load(); }} />}
    </section>
  );
}

function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StateBadge({ state }: { state: string | null }) {
  if (state === "imported") return <Badge size="sm" tone="success">Imported</Badge>;
  if (state === "duplicate") return <Badge size="sm" tone="neutral">Already here</Badge>;
  if (state === "no_transcript") return <Badge size="sm" tone="warning">No transcript</Badge>;
  if (state === "failed") return <Badge size="sm" tone="danger">Didn&apos;t import</Badge>;
  if (state === "processing") return <Badge size="sm" tone="info">Importing</Badge>;
  if (state === "ignored") return <Badge size="sm" tone="neutral">Not the team&apos;s</Badge>;
  return null;
}

function TeamPicker({ id, st, onSaved }: { id: string; st: ZoomStatus; onSaved: (s: ZoomStatus) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const teams = st.teams ?? [];
  if (!teams.length) return <span className="text-text-muted">Create a team first (Teams in the sidebar), then pick it here.</span>;
  return (
    <span className="inline-flex max-w-[320px] items-center gap-2">
      <Select aria-label="Team for Zoom meetings" value={st.team?.id ?? ""} disabled={busy} data-testid="zoom-team-select"
        onChange={async (e) => {
          if (!e.target.value) return;
          setBusy(true);
          try { onSaved(await zoomSetTeam(id, e.target.value)); } catch (err) {
            toast.error(err instanceof Error ? err.message : "That didn't save.");
          } finally { setBusy(false); }
        }}
        options={[...(st.team ? [] : [{ value: "", label: "Pick a team…" }]),
          ...teams.map((t) => ({ value: t.id, label: `${t.name}${t.visibility === "private" ? " (private)" : " (open)"}` }))]} />
      {busy && <Spinner size={14} />}
    </span>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border bg-bg text-[12px] font-medium text-text">{n}</span>
      <div className="min-w-0 flex-1 text-[13px] leading-5 text-text-secondary">
        <p className="m-0 font-medium text-text">{title}</p>
        {children}
      </div>
    </li>
  );
}

function Setup({ id, st, onSaved, onCancel }: { id: string; st: ZoomStatus; onSaved: (s: ZoomStatus) => void; onCancel?: () => void }) {
  const [account, setAccount] = useState("");
  const [client, setClient] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [team, setTeam] = useState(st.team?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const editing = st.connected;
  const scopes = st.scopes_needed ?? [];
  const teams = st.teams ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-5 border-t border-border pt-4" data-testid="zoom-setup">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[13px] font-medium text-text">Set up Zoom (your Zoom account admin does steps 1–7)</h3>
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          <Step n={1} title="Create the app">
            Sign in to the Zoom App Marketplace (marketplace.zoom.us) as a Zoom account admin. Choose <strong>Develop › Build App</strong>,
            pick <strong>Server-to-Server OAuth App</strong>, and name it &ldquo;Markdrop&rdquo;.
          </Step>
          <Step n={2} title="Copy the credentials">
            On <strong>App Credentials</strong>, copy the <strong>Account ID</strong>, <strong>Client ID</strong> and <strong>Client Secret</strong> into the form below.
          </Step>
          <Step n={3} title="Fill in Information">Add a short description and a developer contact (Zoom requires them).</Step>
          <Step n={4} title="Add the scopes">
            On <strong>Scopes</strong>, choose <strong>Add Scopes</strong> and add:
            <ul className="mt-1 flex list-none flex-col gap-1 p-0" data-testid="zoom-scopes">
              {scopes.map((s) => (
                <li key={s.scope} className="flex min-w-0 flex-wrap items-center gap-2">
                  <code className="text-[12px] text-text [overflow-wrap:anywhere]">{s.scope}</code>
                  <CopyButton text={s.scope} iconOnly label={`Copy ${s.scope}`} />
                  <span className="text-text-muted">{s.why}{s.required ? "" : " (optional)"}</span>
                </li>
              ))}
            </ul>
          </Step>
          <Step n={5} title="Turn on Event Subscriptions">
            On <strong>Feature</strong>, turn on <strong>Event Subscriptions</strong>, add a subscription named &ldquo;Markdrop&rdquo;, and set the
            event notification endpoint URL to:
            {st.webhook_url && (
              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                <code className="min-w-0 text-[12px] text-text [overflow-wrap:anywhere]" data-testid="zoom-webhook-url">{st.webhook_url}</code>
                <CopyButton text={st.webhook_url} label="Copy URL" />
              </span>
            )}
            <span className="mt-1 block">
              Add the events <strong>Recording › Cloud recording transcript files have completed</strong> (<code className="text-[12px]">recording.transcript_completed</code>)
              and <strong>Recording › All recordings have completed</strong> (<code className="text-[12px]">recording.completed</code>). Copy the
              <strong> Secret Token</strong> shown on that page into the form below.
            </span>
          </Step>
          <Step n={6} title="Save here, then validate in Zoom">
            Save the form below first. Then press <strong>Validate</strong> next to the endpoint URL in Zoom and save the subscription.
          </Step>
          <Step n={7} title="Activate the app">On <strong>Activation</strong>, choose <strong>Activate your app</strong>.</Step>
          <Step n={8} title="Turn on transcripts in Zoom">
            In the Zoom web portal (Account Management › Account Settings › Recording), turn on <strong>Cloud recording</strong> and, under its
            advanced settings, <strong>Create audio transcript</strong>. Lock both so every host has them. Only recorded meetings with a transcript come in.
          </Step>
        </ol>
      </div>

      <form className="flex min-w-0 flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
          onSaved(await zoomConnect({ workspace_id: id, account_id: account.trim(), client_id: client.trim(),
            client_secret: secret.trim() || null, secret_token: token.trim() || null, team_id: team || null }));
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : "That didn't save.");
        } finally { setBusy(false); }
      }}>
        <div className="grid max-w-[640px] gap-3 sm:grid-cols-2">
          <Field label="Account ID"><Input value={account} onChange={(e) => setAccount(e.target.value)} required autoComplete="off" mono data-testid="zoom-account-id" placeholder={editing ? st.connection?.account_id ?? "" : ""} /></Field>
          <Field label="Client ID"><Input value={client} onChange={(e) => setClient(e.target.value)} required autoComplete="off" mono data-testid="zoom-client-id" placeholder={editing ? st.connection?.client_id ?? "" : ""} /></Field>
          <Field label="Client Secret" hint={editing ? "Leave blank to keep the saved one." : undefined}>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required={!editing} autoComplete="new-password" mono data-testid="zoom-client-secret" />
          </Field>
          <Field label="Secret Token" hint={editing ? "Leave blank to keep the saved one." : "From the event subscription (step 5)."}>
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required={!editing} autoComplete="new-password" mono data-testid="zoom-secret-token" />
          </Field>
        </div>
        {!editing && (
          <div className="max-w-[320px]">
            <Field label="Team" hint="Only meetings hosted by this team's members come in, and only this team sees them.">
              <Select value={team} onChange={(e) => setTeam(e.target.value)} data-testid="zoom-team-new"
                options={[{ value: "", label: teams.length ? "Pick later" : "No teams yet" },
                  ...teams.map((t) => ({ value: t.id, label: `${t.name}${t.visibility === "private" ? " (private)" : " (open)"}` }))]} />
            </Field>
          </div>
        )}
        <p className="m-0 text-caption text-text-muted">Markdrop checks these with Zoom and stores them encrypted. Only workspace admins see this.</p>
        {err && <div data-testid="zoom-error"><Alert tone="danger">{err}</Alert></div>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy} data-testid="zoom-save">{editing ? "Save and check" : "Connect and check"}</Button>
          {onCancel && <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </div>
  );
}

type Range = "30" | "90" | "custom";

function isoDay(d: Date) { return d.toISOString().slice(0, 10); }

function Importer({ id, st, onClose }: { id: string; st: ZoomStatus; onClose: () => void }) {
  const [range, setRange] = useState<Range>("30");
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 864e5)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [rows, setRows] = useState<ZoomRecording[] | null>(null);
  const [notInZoom, setNotInZoom] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [results, setResults] = useState<ZoomResult[] | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setErr("");
    setResults(null);
    try {
      const out = await zoomRecordings(id, range === "custom" ? { from, to } : { days: Number(range) });
      setRows(out.meetings);
      setNotInZoom(out.not_in_zoom);
      setPicked(new Set(out.meetings.filter((m) => m.transcript && !m.imported).map((m) => m.uuid)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't list the Zoom meetings.");
    } finally { setLoading(false); }
  }, [id, range, from, to]);
  useEffect(() => { if (range !== "custom") void fetchList(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = useMemo(() => (rows ?? []).filter((m) => m.transcript && !m.imported), [rows]);
  const allOn = ready.length > 0 && ready.every((m) => picked.has(m.uuid));

  return (
    <Dialog open onClose={onClose} size="lg" title="Import past Zoom meetings"
      description={<>Recorded meetings hosted by members of <strong>{st.team?.name}</strong>. They come in as past meetings: summarised, in the team, and nobody is notified.</>}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button loading={busy} disabled={!picked.size || loading} data-testid="zoom-import-go" onClick={async () => {
            setBusy(true);
            setErr("");
            try {
              const out = await zoomImport(id, [...picked].slice(0, 50));
              setResults(out.results);
              const done = new Set(out.results.filter((r) => r.status === "imported" || r.status === "duplicate").map((r) => r.uuid));
              setRows((rs) => (rs ?? []).map((m) => done.has(m.uuid) ? { ...m, imported: true,
                slug: out.results.find((r) => r.uuid === m.uuid)?.slug ?? m.slug } : m));
              setPicked(new Set());
            } catch (e) {
              setErr(e instanceof Error ? e.message : "That didn't import.");
            } finally { setBusy(false); }
          }}>Import {picked.size ? `${Math.min(picked.size, 50)} ${picked.size === 1 ? "meeting" : "meetings"}` : ""}</Button>
        </>
      )}>
      <div className="flex min-w-0 flex-col gap-4" data-testid="zoom-importer">
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <SegmentedControl<Range> aria-label="Range" value={range} onChange={setRange} size="sm"
            options={[{ value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }, { value: "custom", label: "Custom" }]} />
          {range === "custom" && (
            <>
              <Field label="From"><Input type="date" size="sm" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="zoom-from" /></Field>
              <Field label="To"><Input type="date" size="sm" value={to} onChange={(e) => setTo(e.target.value)} data-testid="zoom-to" /></Field>
              <Button size="sm" variant="secondary" onClick={() => void fetchList()} loading={loading}>Show meetings</Button>
            </>
          )}
        </div>
        {err && <Alert tone="danger">{err}</Alert>}
        {results && (
          <div data-testid="zoom-import-result"><Alert tone="success" title="Done">
            {summary(results)}
          </Alert></div>
        )}
        {loading && rows === null ? <Skeleton width="70%" height={14} /> : rows && rows.length === 0 ? (
          <p className="text-[13px] text-text-muted">No recorded meetings by the team&apos;s members in this range.</p>
        ) : rows && (
          <div className="flex min-w-0 flex-col gap-1">
            {ready.length > 0 && (
              <Checkbox label={`Select all ready to import (${ready.length})`} checked={allOn}
                onChange={(e) => setPicked(e.target.checked ? new Set(ready.map((m) => m.uuid)) : new Set())} />
            )}
            <ul className="m-0 flex max-h-[380px] min-w-0 list-none flex-col divide-y divide-border overflow-auto rounded-lg border border-border p-0">
              {rows.map((m) => (
                <li key={m.uuid} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]" data-testid="zoom-row">
                  <Checkbox aria-label={`Import ${m.topic}`} checked={picked.has(m.uuid)} disabled={!m.transcript || m.imported}
                    onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(m.uuid); else n.delete(m.uuid); return n; })} />
                  <span className="min-w-0 flex-[1_1_200px] truncate font-medium text-text">{m.topic}</span>
                  <span className="text-text-muted">{m.date}{m.time ? ` ${m.time}` : ""}{m.duration_min ? ` · ${m.duration_min} min` : ""} · {m.host.name}</span>
                  {m.imported ? (m.slug ? <Link href={`/${m.slug}`} className="text-accent-text hover:underline">Open</Link> : <Badge size="sm">Imported</Badge>)
                    : m.transcript ? <Badge size="sm" tone="success">Transcript</Badge>
                    : <Badge size="sm" tone="warning">No transcript</Badge>}
                </li>
              ))}
            </ul>
            {rows.some((m) => !m.transcript) && <p className="mt-1 text-caption text-text-muted">{st.no_transcript_help}</p>}
            {notInZoom.length > 0 && (
              <p className="text-caption text-text-muted">Not found in this Zoom account (by email): {notInZoom.join(", ")}.</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function summary(results: ZoomResult[]): string {
  const n = (s: string) => results.filter((r) => r.status === s).length;
  const parts = [
    n("imported") && `${n("imported")} imported`,
    n("duplicate") && `${n("duplicate")} already here`,
    n("no_transcript") && `${n("no_transcript")} without a transcript`,
    n("ignored") && `${n("ignored")} not hosted by the team`,
    n("failed") && `${n("failed")} didn't import (${results.find((r) => r.status === "failed")?.reason ?? "try again"})`,
  ].filter(Boolean);
  return parts.join(", ") + ".";
}
