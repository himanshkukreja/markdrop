"use client";

/**
 * The meeting panel's HubSpot section (backend services/hubspot.py): the deal this call matches (stage, amount,
 * owner, close date, contacts, company, open in HubSpot), Change match (deal search), Log to HubSpot (fills the
 * HubSpot meeting's internal notes; again updates the same one) and the action items proposed as HubSpot tasks,
 * created only when someone ticks and approves them. Shown only on the HubSpot team's meetings, to people who can
 * read the meeting and are in that team (or workspace admins); everyone else sees nothing.
 *
 * Phase 2: Suggested updates to the deal (stage, close date, amount, next step, the portal's own fields), each with
 * the lines of the call that support it and Apply / Dismiss (never applied on their own), and the company's
 * account page (a link, and Update).
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Checkbox, Input, Spinner, useToast } from "@/components/ui";
import { BrandMark } from "@/components/integrations/BrandMark";
import {
  fmtAmount, hubspotAccount, hubspotApply, hubspotCreateTasks, hubspotDeals, hubspotDismiss, hubspotLog, hubspotMeeting,
  hubspotRematch, hubspotSetMatch, hubspotSuggest, type HubSpotDeal, type HubSpotPanel, type HubSpotSuggestion,
} from "@/lib/hubspot";

const HOW: Record<string, string> = {
  meeting: "the meeting HubSpot booked for this call",
  contacts: "the attendees' emails",
  names: "the attendees' names (check it)",
  user: "picked by a person",
  none: "nothing found",
};

export function HubSpotSection({ meetingId, workspaceId }: { meetingId: string; workspaceId: string }) {
  const toast = useToast();
  const [p, setP] = useState<HubSpotPanel | null>(null);
  const [busy, setBusy] = useState("");
  const [picking, setPicking] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try { setP(await hubspotMeeting(meetingId)); } catch { setP(null); }
  }, [meetingId]);
  useEffect(() => { void load(); }, [load]);

  if (!p || !p.available) return null;
  const run = async (what: string, fn: () => Promise<HubSpotPanel>, ok: string | ((n: HubSpotPanel) => string)) => {
    setBusy(what);
    try {
      const next = await fn();
      setP(next);
      toast.success(typeof ok === "string" ? ok : ok(next));
      return next;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
      return null;
    } finally { setBusy(""); }
  };
  const d = p.deal;
  const m = p.match;
  const canLog = !!m && (m.meeting_found || !!d || p.contacts.length > 0);
  const open = p.tasks.filter((t) => !t.created);
  const chosen = open.filter((t) => ticked.has(t.key));

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="hubspot-section">
      <p className="pa-sources__label m-0 flex items-center gap-2"><BrandMark brand="hubspot" size={18} /> HubSpot</p>
      {p.error && <p className="m-0 text-[13px] text-danger-text">{p.error}</p>}

      {d ? (
        <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-bg p-3 text-[13px]" data-testid="hubspot-deal">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            {d.url ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="min-w-0 font-medium text-accent-text hover:underline">{d.name}</a>
              : <b className="min-w-0">{d.name}</b>}
            {d.stage && <Badge size="sm" tone={d.closed ? "neutral" : "info"}>{d.stage}</Badge>}
          </span>
          <span className="text-text-secondary">
            {[fmtAmount(d.amount, d.currency), d.owner ? `Owner ${d.owner}` : null, d.close_date ? `Closes ${d.close_date}` : null].filter(Boolean).join(" · ") || "No amount or close date"}
          </span>
          {(p.contacts.length > 0 || p.companies.length > 0) && (
            <span className="text-text-secondary">
              {[...p.companies.map((c) => ({ ...c, email: null })), ...p.contacts].map((c, i) => (
                <span key={c.id}>{i ? ", " : ""}{c.url ? <a href={c.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{c.name || c.email}</a> : c.name}</span>
              ))}
            </span>
          )}
        </div>
      ) : (
        <p className="m-0 text-[13px] text-text-secondary" data-testid="hubspot-no-deal">
          {p.contacts.length > 0 ? `No open deal for ${p.contacts.map((c) => c.name || c.email).join(", ")}.` : "Markdrop didn't find this call in HubSpot."} Pick the deal.
        </p>
      )}
      {m && (
        <p className="m-0 text-caption text-text-muted" data-testid="hubspot-how">
          Matched by {HOW[m.how] ?? m.how}{m.confidence !== "none" && m.how !== "user" ? ` · ${m.confidence} confidence` : ""}
          {m.candidates.length > 0 ? ` · also: ${m.candidates.map((c) => c.name).filter(Boolean).join(", ")}` : ""}
        </p>
      )}

      {picking ? (
        <DealPicker workspaceId={workspaceId} busy={busy === "pick"} onCancel={() => setPicking(false)}
          onPick={async (deal) => {
            const next = await run("pick", () => hubspotSetMatch(meetingId, deal ? deal.id : null), deal ? `Matched to ${deal.name}.` : "No deal for this call.");
            if (next) setPicking(false);
          }} />
      ) : (
        <span className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" iconLeft="search" onClick={() => setPicking(true)} data-testid="hubspot-change">{d ? "Change match" : "Pick the deal"}</Button>
          <Button size="sm" variant="ghost" iconLeft="refresh" loading={busy === "rematch"} disabled={!!busy}
            onClick={() => void run("rematch", () => hubspotRematch(meetingId), "Matched again.")}>Match again</Button>
        </span>
      )}

      {p.suggestions && p.suggestions.enabled && (d || p.suggestions.items.length > 0) && (
        <Suggestions p={p} busy={busy}
          onSuggest={() => void run("suggest", () => hubspotSuggest(meetingId), (n) => {
            const k = (n.suggestions?.items ?? []).filter((i) => i.state === "open").length;
            return k ? `${k} suggested ${k === 1 ? "update" : "updates"}.` : (n.suggestions?.message || "Nothing to change in the deal from this call.");
          })}
          onApply={(it) => void run(`apply:${it.id}`, () => hubspotApply(meetingId, it.id), `${it.label} updated in HubSpot.`)}
          onDismiss={(it) => void run(`dismiss:${it.id}`, () => hubspotDismiss(meetingId, it.id), "Dismissed.")} />
      )}

      {(p.account || p.companies.length > 0) && (
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13px]" data-testid="hubspot-account">
          {p.account
            ? <a href={p.account.href} className="font-medium text-accent-text hover:underline">Account page: {p.account.name || "open"}</a>
            : <span className="text-text-secondary">No account page yet.</span>}
          <Button size="sm" variant="ghost" iconLeft="refresh" loading={busy === "account"} disabled={!!busy}
            onClick={async () => {
              setBusy("account");
              try {
                const a = await hubspotAccount(meetingId);
                setP((cur) => (cur ? { ...cur, account: a } : cur));
                toast.success("The account page is up to date.");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
              } finally { setBusy(""); }
            }}>{p.account ? "Update" : "Make it"}</Button>
        </p>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" variant={p.logged ? "secondary" : "primary"} iconLeft="send" loading={busy === "log"} disabled={!!busy || !canLog}
          data-testid="hubspot-log"
          onClick={() => void run("log", () => hubspotLog(meetingId), (n) => n.logged?.created ? "Logged to HubSpot as a new meeting on the deal." : "Logged to HubSpot.")}>
          {p.logged ? "Update in HubSpot" : "Log to HubSpot"}
        </Button>
        <span className="text-caption text-text-muted" data-testid="hubspot-logged">
          {p.logged
            ? <>Logged {shortWhen(p.logged.at)}{p.logged.auto ? " automatically" : p.logged.by ? ` by ${p.logged.by}` : ""}{p.logged.url ? <> · <a href={p.logged.url} target="_blank" rel="noopener noreferrer" className="hover:underline">Open in HubSpot</a></> : null}</>
            : canLog ? "The summary, next steps and decisions go in the meeting's internal notes." : "Pick the deal first."}
        </span>
      </div>

      {p.tasks.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="hubspot-tasks">
          <p className="m-0 text-[13px] font-medium text-text">Action items as HubSpot tasks</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
            {p.tasks.map((t) => (
              <li key={t.key} className="flex min-w-0 items-start gap-2">
                {t.created ? <Badge size="sm" tone="success">In HubSpot</Badge> : (
                  <Checkbox aria-label={t.text} checked={ticked.has(t.key)} disabled={!!busy}
                    onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(t.key); else n.delete(t.key); return n; })} />
                )}
                <span className="min-w-0">
                  {t.text}
                  <span className="text-text-muted"> · due {t.due}{t.assignee?.name ? ` · ${t.assignee.name}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
          {open.length > 0 && (
            <span>
              <Button size="sm" variant="secondary" loading={busy === "tasks"} disabled={!!busy || chosen.length === 0} data-testid="hubspot-create-tasks"
                onClick={async () => {
                  const next = await run("tasks", () => hubspotCreateTasks(meetingId, chosen.map((t) => t.key)), (n) => {
                    const made = (n.results ?? []).filter((r) => r.status === "created").length;
                    return `${made} ${made === 1 ? "task" : "tasks"} created in HubSpot.`;
                  });
                  if (next) setTicked(new Set());
                }}>
                {chosen.length ? `Create ${chosen.length} ${chosen.length === 1 ? "task" : "tasks"} in HubSpot` : "Tick the tasks to create"}
              </Button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = { applied: "Applied", dismissed: "Dismissed", applying: "Applying…" };

function Suggestions({ p, busy, onSuggest, onApply, onDismiss }: {
  p: HubSpotPanel; busy: string; onSuggest: () => void; onApply: (s: HubSpotSuggestion) => void; onDismiss: (s: HubSpotSuggestion) => void;
}) {
  const s = p.suggestions!;
  const open = s.items.filter((i) => i.state === "open" || i.state === "failed");
  const done = s.items.filter((i) => !(i.state === "open" || i.state === "failed"));
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="hubspot-suggestions">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-text">Suggested updates</span>
        {s.can_suggest && (
          <Button size="sm" variant="ghost" iconLeft="refresh" loading={busy === "suggest"} disabled={!!busy} onClick={onSuggest}>
            {s.state ? "Suggest again" : "Suggest updates"}
          </Button>
        )}
      </span>
      {p.deals_write === "missing" && open.length > 0 && (
        <p className="m-0 text-caption text-text-muted">Apply needs the HubSpot key&apos;s deals write scope: a workspace admin adds it in HubSpot.</p>
      )}
      {open.length === 0 && done.length === 0 && (
        <p className="m-0 text-caption text-text-muted">
          {s.state === "done" ? "Nothing in this call changes the deal." : s.message || "Markdrop suggests deal updates after the call's summary is written. Nothing changes in HubSpot until you apply it."}
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
        {[...open, ...done].map((it) => (
          <li key={it.id} className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-bg p-2" data-testid="hubspot-suggestion">
            <span className="min-w-0">
              <b>{it.label}</b>: {it.current ? <span className="text-text-muted line-through">{it.current}</span> : null}{it.current ? " → " : ""}{it.display}
              {STATE_LABEL[it.state] && <Badge size="sm" tone={it.state === "applied" ? "success" : "neutral"} className="ml-2">{STATE_LABEL[it.state]}</Badge>}
            </span>
            {it.why && <span className="text-text-secondary">{it.why}</span>}
            {it.evidence.map((e) => (
              <span key={e.ref} className="text-caption text-text-muted">
                “{e.quote}”{e.speaker ? ` · ${e.speaker}` : ""}{e.at ? <> · {e.href ? <a href={e.href} className="hover:underline">{e.at}</a> : e.at}</> : null}
              </span>
            ))}
            {it.state === "failed" && it.error && <span className="text-caption text-danger-text">{it.error}</span>}
            {(it.state === "open" || it.state === "failed") && (
              <span className="flex flex-wrap gap-1">
                <Button size="sm" variant="secondary" loading={busy === `apply:${it.id}`} disabled={!!busy} onClick={() => onApply(it)}>Apply</Button>
                <Button size="sm" variant="ghost" loading={busy === `dismiss:${it.id}`} disabled={!!busy} onClick={() => onDismiss(it)}>Dismiss</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function shortWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function DealPicker({ workspaceId, busy, onPick, onCancel }: {
  workspaceId: string; busy: boolean; onPick: (d: HubSpotDeal | null) => void; onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [deals, setDeals] = useState<HubSpotDeal[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      hubspotDeals(workspaceId, q).then((r) => { if (live) setDeals(r.deals); }, () => { if (live) setDeals([]); })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [workspaceId, q]);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-bg p-2" data-testid="hubspot-picker">
      <Input size="sm" autoFocus value={q} placeholder="Search deals by name" aria-label="Search HubSpot deals" onChange={(e) => setQ(e.target.value)} />
      {loading && !deals ? <Spinner size={14} /> : (
        <ul className="m-0 flex max-h-56 list-none flex-col gap-0.5 overflow-auto p-0 text-[13px]">
          {(deals ?? []).map((d) => (
            <li key={d.id}>
              <button type="button" disabled={busy} className="w-full rounded-md px-2 py-1 text-left hover:bg-surface-hover" onClick={() => onPick(d)}>
                <span className="text-text">{d.name}</span>
                <span className="text-text-muted">{[d.stage, fmtAmount(d.amount, d.currency)].filter(Boolean).map((x) => ` · ${x}`).join("")}</span>
              </button>
            </li>
          ))}
          {deals && deals.length === 0 && <li className="px-2 py-1 text-text-muted">No deals found.</li>}
        </ul>
      )}
      <span className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPick(null)}>None of these</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}
