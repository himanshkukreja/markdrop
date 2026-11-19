"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Badge, Button, ConfirmDialog, CopyButton, Field, Input, Select, Skeleton, Spinner, Switch, useToast,
} from "@/components/ui";
import { BrandMark } from "@/components/integrations/BrandMark";
import { updateTeam } from "@/lib/teams";
import {
  hubspotConnect, hubspotDisconnect, hubspotSetAutoLog, hubspotSetSwitch, hubspotSetTeam, hubspotStatus, type HubSpotStatus,
  type HubSpotSwitch,
} from "@/lib/hubspot";

/**
 * Workspace settings › Integrations › HubSpot. A HubSpot super admin creates a service key (Development › Keys ›
 * Service keys) with the scopes listed here; a workspace admin pastes it and picks the team (Sales). Markdrop
 * checks it with HubSpot (the account, missing scopes) and stores it encrypted. The team's calls are then
 * matched to HubSpot and logged from each deal page (components/hubspot/deals); Log calls
 * automatically (off by default) logs confident matches after their summary is written. Backend: routers/hubspot.py.
 */
export function HubSpotWorkspaceCard({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const toast = useToast();
  const [st, setSt] = useState<HubSpotStatus | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setSt(await hubspotStatus(id));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load HubSpot's settings.");
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (error) {
    return <Alert tone="danger" title="Couldn't load HubSpot" actions={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{error}</Alert>;
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
    <section aria-labelledby="hubspot-h" data-testid="hubspot-card" className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-5">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <BrandMark brand="hubspot" size={36} />
        <div className="min-w-0 flex-[1_1_280px]">
          <h2 id="hubspot-h" className="flex flex-wrap items-center gap-2 text-body-strong text-text">
            HubSpot
            {st.connected && <Badge tone="success" size="sm" dot data-testid="hubspot-connected">Connected</Badge>}
            {!st.configured && <Badge size="sm">Not set up yet</Badge>}
          </h2>
          <p className="mt-0.5 text-[13px] leading-5 text-text-secondary">
            One team&apos;s calls are written up in HubSpot: each meeting is matched to the meeting HubSpot booked, its contacts and
            deal, and Log to HubSpot puts the summary, next steps and decisions in the meeting&apos;s internal notes. Action items become
            tasks when someone approves them.
          </p>
        </div>
      </div>

      {!st.configured && <p className="text-[13px] text-text-muted">HubSpot isn&apos;t switched on for this server yet.</p>}
      {st.configured && !st.connected && !isAdmin && <p className="text-[13px] text-text-muted">A workspace admin connects HubSpot here.</p>}

      {st.connected && c && !editing && (
        <>
          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-text-muted">Calls from</dt>
            <dd className="min-w-0 text-text" data-testid="hubspot-team">
              {isAdmin && st.teams ? (
                <TeamPicker id={id} st={st} onSaved={(s) => { setSt(s); toast.success("That team's calls go to HubSpot now."); }} />
              ) : st.team ? <>{st.team.name} <span className="text-text-muted">({st.team.visibility === "private" ? "private team" : "open team"})</span></>
                : <span className="text-text-muted">No team yet</span>}
            </dd>
            <dt className="text-text-muted">HubSpot account</dt>
            <dd className="min-w-0 text-text">
              <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">{c.portal_id}</a>
              {c.connected_by ? <span className="text-text-muted"> · connected by {c.connected_by}</span> : null}
            </dd>
            <dt className="text-text-muted">Logged</dt>
            <dd className="text-text" data-testid="hubspot-counts">
              {c.logged} {c.logged === 1 ? "call" : "calls"} · {c.tasks} {c.tasks === 1 ? "task" : "tasks"}
              {c.last_log_at ? <span className="text-text-muted"> · last {shortWhen(c.last_log_at)}</span> : null}
            </dd>
          </dl>

          <AutoLog id={id} st={st} isAdmin={isAdmin} onSaved={setSt} />
          <MoreSwitches id={id} st={st} isAdmin={isAdmin} onSaved={setSt} />

          {!st.team && (
            <Alert tone="info" title="Pick a team">
              Nothing goes to HubSpot until {isAdmin ? "you pick" : "an admin picks"} the team whose calls are logged there.
            </Alert>
          )}
          {st.team && st.team.visibility === "open" && (
            <div data-testid="hubspot-open-team"><Alert tone="warning" title={`${st.team.name} is an open team`}
              actions={isAdmin ? (
                <Button size="sm" loading={busy === "private"} onClick={async () => {
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
              Everyone in the workspace can read an open team&apos;s meetings. Make the team private so only its members (and workspace
              admins) see its calls.
            </Alert></div>
          )}
          {isAdmin && c.broken && (
            <div data-testid="hubspot-broken"><Alert tone="danger" title="The HubSpot connection needs attention">
              {c.broken === "token" ? "HubSpot no longer accepts the key (it was rotated or deleted). Paste the new one."
                : c.broken === "missing_scopes" ? "The HubSpot key is missing scopes Markdrop needs (below)." : c.last_error || c.broken}
            </Alert></div>
          )}
          {isAdmin && (c.missing_scopes?.length ?? 0) > 0 && (
            <div data-testid="hubspot-missing-scopes"><Alert tone="warning" title="Add these scopes to the HubSpot key">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {c.missing_scopes!.map((m) => <li key={m.scope}><code className="text-[12px]">{m.scope}</code>: {m.why}</li>)}
              </ul>
              <p className="mt-1">In HubSpot, open the key, choose Edit and add them, then save the key here again.</p>
            </Alert></div>
          )}
          {isAdmin && (c.unchecked_scopes?.length ?? 0) > 0 && (
            <p className="m-0 text-caption text-text-muted" data-testid="hubspot-unchecked">
              HubSpot doesn&apos;t say whether a service key can write, so Markdrop didn&apos;t check{" "}
              {c.unchecked_scopes!.map((s, i) => <span key={s}>{i ? ", " : ""}<code className="text-[12px]">{s}</code></span>)}. Make sure the key has it.
            </p>
          )}
          {isAdmin && c.last_error && !c.broken && <p className="text-[13px] text-danger-text">Last problem: {c.last_error}</p>}

          <div className="flex flex-wrap gap-2">
            {isAdmin && <Button size="sm" variant="secondary" iconLeft="key" onClick={() => setEditing(true)} data-testid="hubspot-edit">Change key</Button>}
            {isAdmin && <Button size="sm" variant="secondary" iconLeft="logOut" onClick={() => setConfirm(true)}>Disconnect HubSpot…</Button>}
          </div>
        </>
      )}

      {showSetup && (
        <Setup id={id} st={st} onCancel={st.connected ? () => setEditing(false) : undefined}
          onSaved={(s) => { setSt(s); setEditing(false); toast.success("HubSpot is connected."); }} />
      )}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Disconnect HubSpot?"
        description={<>Markdrop deletes the key and every meeting&apos;s match, and stops logging calls. Notes and tasks already in HubSpot stay there. You can also delete the key in HubSpot.</>}
        confirmLabel="Disconnect"
        onConfirm={async () => {
          setSt(await hubspotDisconnect(id));
          setConfirm(false);
          toast.success("HubSpot is disconnected.");
        }}
      />
    </section>
  );
}

function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function AutoLog({ id, st, isAdmin, onSaved }: { id: string; st: HubSpotStatus; isAdmin: boolean; onSaved: (s: HubSpotStatus) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-bg p-3" data-testid="hubspot-auto">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-text">Log calls automatically</span>
        <Switch checked={st.auto_log} disabled={!isAdmin || busy} aria-label="Log calls automatically" data-testid="hubspot-auto-switch"
          onChange={async (e) => {
            setBusy(true);
            try {
              onSaved(await hubspotSetAutoLog(id, e.target.checked));
              toast.success(e.target.checked ? "Confident matches are logged on their own now." : "Calls are logged with one click.");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "That didn't save.");
            } finally { setBusy(false); }
          }} />
      </div>
      <p className="m-0 text-[13px] leading-5 text-text-secondary">
        {st.auto_log
          ? "On: when a call's summary is written and Markdrop found the meeting HubSpot booked for it, the notes go to HubSpot on their own. Other calls wait for Log to HubSpot."
          : "Off: someone in the team chooses Log to HubSpot on each meeting. On: calls matched to the meeting HubSpot booked are logged after their summary is written."}
        {" "}Tasks always wait for someone to approve them.
      </p>
    </div>
  );
}

const MORE: Array<{ key: HubSpotSwitch; label: string; on: string; off: string }> = [
  { key: "suggest", label: "Suggest deal updates",
    on: "After a call matched to a deal, Markdrop suggests changes to its stage, close date, amount and next step, with the lines of the call that support them. Nothing changes in HubSpot until someone applies one.",
    off: "Off: no suggestions after calls." },
  { key: "precall", label: "Pre-call briefs",
    on: "Before a team member's HubSpot meeting, a brief in Slack and their Markdrop inbox: the deal, the last call and what was promised. Each person can turn them off.",
    off: "Off: nobody gets pre-call briefs." },
  { key: "approve", label: "Slack buttons after calls",
    on: "When a call's summary is ready, its host gets a Slack message with Log to HubSpot and Create tasks. Each person can turn it off.",
    off: "Off: no Slack message after calls." },
];

function MoreSwitches({ id, st, isAdmin, onSaved }: { id: string; st: HubSpotStatus; isAdmin: boolean; onSaved: (s: HubSpotStatus) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState("");
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-bg p-3" data-testid="hubspot-switches">
      {MORE.map((x) => {
        const on = st.switches?.[x.key] ?? true;
        return (
          <div key={x.key} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] font-medium text-text">{x.label}</span>
              <Switch checked={on} disabled={!isAdmin || !!busy} aria-label={x.label} data-testid={`hubspot-switch-${x.key}`}
                onChange={async (e) => {
                  setBusy(x.key);
                  try {
                    onSaved(await hubspotSetSwitch(id, x.key, e.target.checked));
                    toast.success(`${x.label}: ${e.target.checked ? "on" : "off"}.`);
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "That didn't save.");
                  } finally { setBusy(""); }
                }} />
            </div>
            <p className="m-0 text-[13px] leading-5 text-text-secondary">{on ? x.on : x.off}</p>
          </div>
        );
      })}
      {st.deals_write === "missing" && (
        <Alert tone="warning">Apply on a suggested update needs the <code>crm.objects.deals.write</code> scope on the HubSpot key. Add it in HubSpot (the key&apos;s scopes), then try Apply again.</Alert>
      )}
    </div>
  );
}

function TeamPicker({ id, st, onSaved }: { id: string; st: HubSpotStatus; onSaved: (s: HubSpotStatus) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const teams = st.teams ?? [];
  if (!teams.length) return <span className="text-text-muted">Create a team first (Teams in the sidebar), then pick it here.</span>;
  return (
    <span className="inline-flex max-w-[320px] items-center gap-2">
      <Select aria-label="Team whose calls go to HubSpot" value={st.team?.id ?? ""} disabled={busy} data-testid="hubspot-team-select"
        onChange={async (e) => {
          if (!e.target.value) return;
          setBusy(true);
          try { onSaved(await hubspotSetTeam(id, e.target.value)); } catch (err) {
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

function Setup({ id, st, onSaved, onCancel }: { id: string; st: HubSpotStatus; onSaved: (s: HubSpotStatus) => void; onCancel?: () => void }) {
  const [token, setToken] = useState("");
  const [team, setTeam] = useState(st.team?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const editing = st.connected;
  const scopes = st.scopes_needed ?? [];
  const teams = st.teams ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-5 border-t border-border pt-4" data-testid="hubspot-setup">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[13px] font-medium text-text">Set up HubSpot (a HubSpot super admin does steps 1 and 2; you save step 3 here)</h3>
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          <Step n={1} title="Create a service key">
            In HubSpot, go to <strong>Development › Keys › Service keys</strong> and choose <strong>Create service key</strong>. Name it
            &ldquo;Markdrop&rdquo;. (A private app made before October 2026 works too: use its access token.)
          </Step>
          <Step n={2} title="Add the scopes, then copy the key">
            Choose <strong>Add new scope</strong> and tick:
            <ul className="mt-1 flex list-none flex-col gap-1 p-0" data-testid="hubspot-scopes">
              {scopes.map((s) => (
                <li key={s.scope} className="flex min-w-0 flex-wrap items-center gap-2">
                  <code className="text-[12px] text-text [overflow-wrap:anywhere]">{s.scope}</code>
                  <CopyButton text={s.scope} iconOnly label={`Copy ${s.scope}`} />
                  <span className="text-text-muted">{s.why}</span>
                </li>
              ))}
            </ul>
            <span className="mt-1 block">Choose <strong>Create</strong>, then <strong>Show</strong> and <strong>Copy</strong> under the key.</span>
          </Step>
          <Step n={3} title="Save it here">
            Paste the key below, pick the team whose calls go to HubSpot, and choose <strong>Connect and check</strong>.
          </Step>
        </ol>
      </div>

      <form className="flex min-w-0 flex-col gap-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
          onSaved(await hubspotConnect({ workspace_id: id, token: token.trim() || null, team_id: editing ? undefined : team || null }));
        } catch (e2) {
          setErr(e2 instanceof Error ? e2.message : "That didn't save.");
        } finally { setBusy(false); }
      }}>
        <div className="max-w-[520px]">
          <Field label="Service key" hint={editing ? "Leave blank to check the saved one again." : "It starts with pat-."}>
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required={!editing} autoComplete="new-password" mono data-testid="hubspot-token" />
          </Field>
        </div>
        {!editing && (
          <div className="max-w-[320px]">
            <Field label="Team" hint="Only this team's calls go to HubSpot.">
              <Select value={team} onChange={(e) => setTeam(e.target.value)} data-testid="hubspot-team-new"
                options={[{ value: "", label: teams.length ? "Pick later" : "No teams yet" },
                  ...teams.map((t) => ({ value: t.id, label: `${t.name}${t.visibility === "private" ? " (private)" : " (open)"}` }))]} />
            </Field>
          </div>
        )}
        <p className="m-0 text-caption text-text-muted">
          Markdrop checks the key with HubSpot and stores it encrypted. Only workspace admins see this.{" "}
          <Link href="/privacy#hubspot" className="text-accent-text hover:underline">Privacy</Link>
        </p>
        {err && <div data-testid="hubspot-error"><Alert tone="danger">{err}</Alert></div>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy} data-testid="hubspot-save">{editing ? "Save and check" : "Connect and check"}</Button>
          {onCancel && <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </div>
  );
}
