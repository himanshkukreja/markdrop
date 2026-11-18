"use client";

/**
 * HubSpot's per-call pieces (backend services/hubspot.py), used by a deal page's Overview and Calls tabs
 * (components/hubspot/deals/DealView): Log to HubSpot (fills the HubSpot meeting's internal notes; again updates
 * the same one), the call's action items proposed as HubSpot tasks (created only when someone ticks and approves
 * them), and suggested deal updates with the lines that support them and Apply / Dismiss (never applied on their
 * own). They were the meeting panel's HubSpot section; a meeting page now shows only its deal chip
 * (DealChip below: Open deal, Change deal / Pick the deal, Match again, Log to HubSpot).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Checkbox, Icon, Input, Popover, Spinner, useToast } from "@/components/ui";
import {
  fmtAmount, hubspotDeals, hubspotLog, hubspotRematch, hubspotSetMatch, meetingDealChip,
  type HubSpotDeal, type HubSpotPanel, type HubSpotSuggestion, type HubSpotTask, type MeetingDealChip,
} from "@/lib/hubspot";

/** How a call was matched to its deal, in words. */
export const HOW: Record<string, string> = {
  meeting: "the meeting HubSpot booked for this call",
  contacts: "the attendees' emails",
  names: "the attendees' names (check it)",
  user: "picked by a person",
  none: "nothing found",
};

export const failMessage = (e: unknown) => (e instanceof Error && e.message ? e.message : "That didn't work. Try again.");
export const logOk = (n: HubSpotPanel) => (n.logged?.created ? "Logged to HubSpot as a new meeting on the deal." : "Logged to HubSpot.");
export const tasksOk = (n: HubSpotPanel) => {
  const made = (n.results ?? []).filter((r) => r.status === "created").length;
  return `${made} ${made === 1 ? "task" : "tasks"} created in HubSpot.`;
};

export function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "Jan 5, 2026" for a YYYY-MM-DD (or ISO) date; "" when there isn't one. */
export function fmtDate(v: string | null | undefined): string {
  if (!v) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const STATE_LABEL: Record<string, string> = { applied: "Applied", dismissed: "Dismissed", applying: "Applying…" };

/** Suggested deal updates (open and failed first), each with its evidence and Apply / Dismiss. */
export function SuggestionItems({ items, dealsWrite, busy, onApply, onDismiss }: {
  items: HubSpotSuggestion[]; dealsWrite?: string | null; busy: string;
  onApply: (s: HubSpotSuggestion) => void; onDismiss: (s: HubSpotSuggestion) => void;
}) {
  const open = items.filter((i) => i.state === "open" || i.state === "failed");
  const done = items.filter((i) => !(i.state === "open" || i.state === "failed"));
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="hubspot-suggestions">
      {dealsWrite === "missing" && open.length > 0 && (
        <p className="m-0 text-caption text-text-muted">Apply needs the HubSpot key&apos;s deals write scope: a workspace admin adds it in HubSpot.</p>
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

/** A call's action items as HubSpot tasks: tick, then create the ticked ones. */
export function TaskChecklist({ tasks, busy, onCreate }: { tasks: HubSpotTask[]; busy: boolean; onCreate: (keys: string[]) => Promise<boolean> }) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const open = tasks.filter((t) => !t.created);
  const chosen = open.filter((t) => ticked.has(t.key));
  if (!tasks.length) return <p className="m-0 text-caption text-text-muted">No action items in this call.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="hubspot-tasks">
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
        {tasks.map((t) => (
          <li key={t.key} className="flex min-w-0 items-start gap-2">
            {t.created ? <Badge size="sm" tone="success">In HubSpot</Badge> : (
              <Checkbox aria-label={t.text} checked={ticked.has(t.key)} disabled={busy}
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
          <Button size="sm" variant="secondary" loading={busy} disabled={busy || chosen.length === 0} data-testid="hubspot-create-tasks"
            onClick={async () => { if (await onCreate(chosen.map((t) => t.key))) setTicked(new Set()); }}>
            {chosen.length ? `Create ${chosen.length} ${chosen.length === 1 ? "task" : "tasks"} in HubSpot` : "Tick the tasks to create"}
          </Button>
        </span>
      )}
    </div>
  );
}

/** A scope the HubSpot key lacks: admins are told what to add, everyone else that it isn't shown. */
export function MissingScopeHint({ missing, admin }: { missing: Array<{ scope: string; what?: string; why?: string }>; admin: boolean }) {
  if (!missing.length) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-caption text-text-muted" data-testid="hubspot-missing-scope">
      {missing.map((x) => {
        const what = x.what || x.why || "this";
        return (
          <li key={x.scope}>
            {admin ? <>Add <code>{x.scope}</code> to the HubSpot key to show {what}.</> : `${what.charAt(0).toUpperCase()}${what.slice(1)} aren't shown.`}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Under a meeting page's title: a small button "💼 <Company> — <Deal> · <Stage>", or "💼 Pick the deal" while the call
 * isn't filed in a deal. It opens a popover: Open deal, Change deal (deal search: choosing one files the call in that
 * deal; "None of these" says it has none), Match again and Log to HubSpot (its error shows inline, e.g. "Pick the
 * deal first"). After any change the chip is asked again. Nothing for people who can't use HubSpot on the meeting
 * (the server answers deal null, pick false).
 */
export function DealChip({ meetingId, workspaceId: wsFallback }: { meetingId: string; workspaceId: string }) {
  const toast = useToast();
  const [chip, setChip] = useState<MeetingDealChip | null>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setChip(await meetingDealChip(meetingId)); } catch { setChip(null); }
  }, [meetingId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!open) { setPicking(false); setLogError(null); } }, [open]);
  if (!chip || (!chip.deal && !chip.pick)) return null;
  const ws = chip.workspace_id || wsFallback;
  const d = chip.deal;
  const label = d
    ? `${[d.company, d.name].filter(Boolean).join(" — ")}${d.closed_label || d.stage ? ` · ${d.closed_label || d.stage}` : ""}`
    : "Pick the deal";
  const run = async (what: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(what);
    try {
      await fn();
      toast.success(ok);
      setPicking(false);
      await load();
      return true;
    } catch (e) {
      toast.error(failMessage(e));
      return false;
    } finally { setBusy(""); }
  };
  const log = async () => {
    setBusy("log");
    setLogError(null);
    try {
      const p = await hubspotLog(meetingId);
      toast.success(logOk(p));
      await load();
    } catch (e) {
      setLogError(failMessage(e));
    } finally { setBusy(""); }
  };
  const showPicker = picking || !d;
  return (
    <div className="mt-dealchip no-print" data-testid="meeting-deal-chip">
      <Popover open={open} onOpenChange={setOpen} placement="bottom-start" aria-label="HubSpot deal" width={320} panelClassName="mt-dealpop"
        trigger={(
          <button type="button" className="mt-dealchip__link" data-pick={d ? undefined : ""} data-testid="meeting-deal-chip-button">
            <span aria-hidden>💼</span><span className="mt-dealchip__text">{label}</span><Icon name="chevronDown" size={12} />
          </button>
        )}>
        <div className="flex min-w-0 flex-col gap-2 p-1">
          {d && (
            <div className="flex min-w-0 flex-col gap-1">
              <Link href={d.href} className="mt-dealpop__open" data-testid="meeting-deal-open" onClick={() => setOpen(false)}>
                <Icon name="briefcase" size={14} /><span className="min-w-0 truncate">Open deal</span>
              </Link>
              {!picking && (
                <Button size="sm" variant="ghost" iconLeft="search" onClick={() => setPicking(true)} data-testid="meeting-deal-change">Change deal</Button>
              )}
            </div>
          )}
          {showPicker && (
            <DealPicker workspaceId={ws} busy={busy === "pick"} onCancel={d ? () => setPicking(false) : undefined}
              onPick={(deal) => void run("pick", () => hubspotSetMatch(meetingId, deal ? deal.id : null), deal ? `Filed in ${deal.name}.` : "No deal for this call.")} />
          )}
          <span className="flex flex-wrap gap-1 border-t border-border pt-2">
            <Button size="sm" variant="ghost" iconLeft="refresh" loading={busy === "rematch"} disabled={!!busy}
              onClick={() => void run("rematch", () => hubspotRematch(meetingId), "Matched again.")} data-testid="meeting-deal-rematch">Match again</Button>
            <Button size="sm" variant="ghost" iconLeft="send" loading={busy === "log"} disabled={!!busy}
              onClick={() => void log()} data-testid="meeting-deal-log">Log to HubSpot</Button>
          </span>
          {logError && <p className="m-0 text-caption text-danger-text" role="alert" data-testid="meeting-deal-log-error">{logError}</p>}
        </div>
      </Popover>
    </div>
  );
}

/** Search the HubSpot account's deals by name; pick one, or "None of these". */
function DealPicker({ workspaceId, busy, onPick, onCancel }: {
  workspaceId: string; busy: boolean; onPick: (d: HubSpotDeal | null) => void; onCancel?: () => void;
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
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="hubspot-picker">
      <Input size="sm" value={q} placeholder="Search deals by name" aria-label="Search HubSpot deals" onChange={(e) => setQ(e.target.value)} />
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
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPick(null)} data-testid="hubspot-none">None of these</Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </span>
    </div>
  );
}
