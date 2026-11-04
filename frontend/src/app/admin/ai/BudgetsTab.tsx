"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, ConfirmDialog, Input, Switch, Table, useToast, type Column } from "@/components/ui";
import { Card, CardError, CardTitle } from "../analytics/ui";
import { LoadingBlock, fmtDateTime, plural } from "../shared";
import { capText, featureColor, n0, usd, useAiFetch, useAiSend, useLoad } from "./common";

/**
 * Admin → AI → Budgets: the overrides on top of the server's config. An empty field means "the
 * config default" (shown as the placeholder). Saving replaces the whole override set, shows a
 * confirmation listing every change, takes effect at once and is written to the audit log.
 */

interface CapRow {
  key: string; label: string;
  default_daily_usd: number | null; default_monthly_usd: number | null;
  daily_usd: number | null; monthly_usd: number | null;
  effective_daily_usd: number | null; effective_monthly_usd: number | null;
  today_usd: number; month_usd: number;
  config_enabled?: boolean; enabled?: boolean; effective_enabled?: boolean;
}
interface Budgets {
  caps: CapRow[];
  burst: { per_minute: number | null; per_day: number | null; default_per_minute: number; default_per_day: number; effective_per_minute: number; effective_per_day: number };
  user_daily_usd: number | null; default_user_daily_usd: number | null; effective_user_daily_usd: number | null;
  blocked_users: number; capped_users: number; configured: boolean; updated_at: string | null; updated_by: string | null;
}
interface AuditRow { id: string; ts: string; admin: string; kind: "budgets" | "user" | "covers"; target: string; target_label: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }

interface Form {
  caps: Record<string, { daily: string; monthly: string }>;
  enabled: Record<string, boolean>;
  perMinute: string; perDay: string; userDaily: string;
}

const s = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

function toForm(b: Budgets): Form {
  return {
    caps: Object.fromEntries(b.caps.map((c) => [c.key, { daily: s(c.daily_usd), monthly: s(c.monthly_usd) }])),
    enabled: Object.fromEntries(b.caps.filter((c) => c.key !== "*").map((c) => [c.key, c.enabled !== false])),
    perMinute: s(b.burst.per_minute), perDay: s(b.burst.per_day), userDaily: s(b.user_daily_usd),
  };
}

const num = (v: string) => (v.trim() === "" ? null : Number(v));

/** Client-side checks (the server checks again): what's wrong, per field. */
function validate(f: Form, b: Budgets): Record<string, string> {
  const err: Record<string, string> = {};
  for (const c of b.caps) {
    const v = f.caps[c.key];
    const d = num(v.daily), m = num(v.monthly);
    if (d !== null && (!Number.isFinite(d) || d < 0)) err[`${c.key}.daily`] = "0 or more";
    if (m !== null && (!Number.isFinite(m) || m < 0)) err[`${c.key}.monthly`] = "0 or more";
    const ed = d ?? c.default_daily_usd ?? Infinity, em = m ?? c.default_monthly_usd ?? Infinity;
    if (!err[`${c.key}.daily`] && !err[`${c.key}.monthly`] && em < ed) err[`${c.key}.monthly`] = "Below the daily cap";
  }
  const pm = num(f.perMinute), pd = num(f.perDay);
  if (pm !== null && (!Number.isInteger(pm) || pm < 1)) err.perMinute = "A whole number, 1 or more";
  if (pd !== null && (!Number.isInteger(pd) || pd < 1)) err.perDay = "A whole number, 1 or more";
  if (!err.perMinute && !err.perDay && (pd ?? b.burst.default_per_day) < (pm ?? b.burst.default_per_minute)) err.perDay = "Below the per-minute limit";
  const ud = num(f.userDaily);
  if (ud !== null && (!Number.isFinite(ud) || ud < 0)) err.userDaily = "0 or more";
  return err;
}

function body(f: Form) {
  return {
    caps: Object.fromEntries(Object.entries(f.caps).map(([k, v]) => [k, { daily_usd: num(v.daily), monthly_usd: num(v.monthly) }])),
    enabled: f.enabled,
    burst: { per_minute: num(f.perMinute), per_day: num(f.perDay) },
    user_daily_usd: num(f.userDaily),
  };
}

/** Human lines for every field that differs between the saved settings and the form. */
function changes(f: Form, b: Budgets): string[] {
  const out: string[] = [];
  const show = (v: string, fallback: number | null, money = true) => (v.trim() === "" ? `default (${money ? capText(fallback) : n0(fallback ?? 0)})` : money ? usd(Number(v)) : n0(Number(v)));
  for (const c of b.caps) {
    const v = f.caps[c.key];
    if (num(v.daily) !== c.daily_usd) out.push(`${c.label} daily cap: ${show(s(c.daily_usd), c.default_daily_usd)} → ${show(v.daily, c.default_daily_usd)}`);
    if (num(v.monthly) !== c.monthly_usd) out.push(`${c.label} monthly cap: ${show(s(c.monthly_usd), c.default_monthly_usd)} → ${show(v.monthly, c.default_monthly_usd)}`);
    if (c.key !== "*" && f.enabled[c.key] !== (c.enabled !== false)) out.push(`${c.label}: turned ${f.enabled[c.key] ? "on" : "off"}`);
  }
  if (num(f.perMinute) !== b.burst.per_minute) out.push(`Burst per minute: ${show(s(b.burst.per_minute), b.burst.default_per_minute, false)} → ${show(f.perMinute, b.burst.default_per_minute, false)}`);
  if (num(f.perDay) !== b.burst.per_day) out.push(`Burst per day: ${show(s(b.burst.per_day), b.burst.default_per_day, false)} → ${show(f.perDay, b.burst.default_per_day, false)}`);
  if (num(f.userDaily) !== b.user_daily_usd) out.push(`Default per-person daily cap: ${show(s(b.user_daily_usd), b.default_user_daily_usd)} → ${show(f.userDaily, b.default_user_daily_usd)}`);
  return out;
}

function MoneyInput({ id, value, onChange, placeholder, error, label }: { id: string; value: string; onChange: (v: string) => void; placeholder: string; error?: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Input id={id} size="sm" inputMode="decimal" textPrefix="$" aria-label={label} placeholder={placeholder} value={value}
        onChange={(e) => onChange(e.target.value)} invalid={!!error} wrapClassName="w-28" aria-describedby={error ? `${id}-err` : undefined} />
      {error && <span id={`${id}-err`} className="text-micro text-danger-text">{error}</span>}
    </div>
  );
}

function SpendVsCap({ spent, cap }: { spent: number; cap: number | null }) {
  const frac = cap ? Math.min(1, spent / cap) : 0;
  const warn = cap !== null && (cap === 0 || spent / cap >= 0.8);
  return (
    <span className="flex min-w-[7rem] flex-col gap-1">
      <span className={`text-micro tabular-nums ${warn ? "text-warning-text" : "text-text-secondary"}`}>{usd(spent)} of {capText(cap)}</span>
      <span aria-hidden className="h-1 w-full rounded-full" style={{ background: "var(--chart-track)" }}>
        {cap !== null && <span className="block h-full rounded-full" style={{ width: `${frac * 100}%`, background: warn ? "var(--warning)" : "var(--chart-1)" }} />}
      </span>
    </span>
  );
}

export function BudgetsTab({ token, onGo }: { token: string; onGo: (t: "users") => void }) {
  const get = useAiFetch(token);
  const send = useAiSend(token);
  const toast = useToast();
  const [bump, setBump] = useState(0);
  const b = useLoad(() => get<Budgets>("budgets"), [get, bump]);
  const audit = useLoad(() => get<{ items: AuditRow[] }>("budgets/audit", { limit: 50 }), [get, bump]);
  const [form, setForm] = useState<Form | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (b.data) setForm(toForm(b.data)); }, [b.data]);

  const errors = useMemo(() => (form && b.data ? validate(form, b.data) : {}), [form, b.data]);
  const diff = useMemo(() => (form && b.data ? changes(form, b.data) : []), [form, b.data]);
  const valid = Object.keys(errors).length === 0;

  if (b.error && !b.data) return <CardError title="Budgets" onRetry={b.reload} />;
  if (!b.data || !form) return <LoadingBlock label="Loading budgets" minHeight={320} />;
  const data = b.data;
  const setCap = (k: string, which: "daily" | "monthly", v: string) => setForm((f) => f && ({ ...f, caps: { ...f.caps, [k]: { ...f.caps[k], [which]: v } } }));

  const cols: Column<CapRow>[] = [
    { key: "f", header: "Feature", primary: true, render: (c) => (
      <span className="flex min-w-0 flex-col">
        <span className="inline-flex items-center gap-2 text-text">
          {c.key === "*" ? <span aria-hidden className="size-2.5 rounded-xs border border-border-strong" /> : <span aria-hidden className="size-2.5 rounded-xs" style={{ background: featureColor(c.key) }} />}
          {c.label}
        </span>
        {c.key !== "*" && c.config_enabled === false && <span className="text-micro text-warning-text">Off in the server config</span>}
      </span>
    ) },
    { key: "on", header: "On", render: (c) => (c.key === "*" ? <span className="text-micro text-text-muted">—</span> : (
      <Switch aria-label={`${c.label} on`} checked={form.enabled[c.key]} disabled={c.config_enabled === false}
        onChange={(e) => setForm((f) => f && ({ ...f, enabled: { ...f.enabled, [c.key]: e.target.checked } }))} />
    )) },
    { key: "daily", header: "Daily cap", render: (c) => (
      <MoneyInput id={`cap-${c.key}-d`} label={`${c.label} daily cap in USD`} value={form.caps[c.key].daily} onChange={(v) => setCap(c.key, "daily", v)}
        placeholder={c.default_daily_usd === null ? "None" : String(c.default_daily_usd)} error={errors[`${c.key}.daily`]} />
    ) },
    { key: "today", header: "Today", render: (c) => <SpendVsCap spent={c.today_usd} cap={c.effective_daily_usd} /> },
    { key: "monthly", header: "Monthly cap", render: (c) => (
      <MoneyInput id={`cap-${c.key}-m`} label={`${c.label} monthly cap in USD`} value={form.caps[c.key].monthly} onChange={(v) => setCap(c.key, "monthly", v)}
        placeholder={c.default_monthly_usd === null ? "None" : String(c.default_monthly_usd)} error={errors[`${c.key}.monthly`]} />
    ) },
    { key: "month", header: "This month", render: (c) => <SpendVsCap spent={c.month_usd} cap={c.effective_monthly_usd} /> },
  ];

  async function save() {
    try {
      await send("budgets", body(form!));
      toast.success("Budgets saved. They apply now.");
      setConfirm(false);
      setBump((x) => x + 1);
    } catch (e) {
      throw e instanceof Error ? e : new Error("Couldn't save.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-body text-text-secondary">
          Empty fields use the server&apos;s config default (shown faded). Changes apply within seconds, with no deploy, and are logged below.
          A cap of $0 stops all spend.
        </p>
        <div className="flex items-center gap-2">
          {diff.length > 0 && <Button size="sm" variant="ghost" onClick={() => setForm(toForm(data))}>Discard</Button>}
          <Button size="sm" iconLeft="check" disabled={!valid || diff.length === 0} onClick={() => setConfirm(true)}>
            {diff.length ? `Save ${plural(diff.length, "change")}` : "Saved"}
          </Button>
        </div>
      </div>
      {!data.configured && <Alert tone="warning" title="AI isn't configured">No API key on the server: every AI feature is off whatever these say.</Alert>}

      <Card aria-labelledby="bud-caps-h">
        <CardTitle id="bud-caps-h" title="Spend caps" sub="USD per UTC day and month. A feature stops at its own cap or at the all-AI cap, whichever comes first." />
        <Table compact hover={false} columns={cols} rows={data.caps} rowKey={(c) => c.key} caption="Spend caps per AI feature" />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card aria-labelledby="bud-burst-h">
          <CardTitle id="bud-burst-h" title="Burst limit" sub="Per signed-in person, across all AI features. Anti-abuse, not an allowance. Refused requests don't count." />
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col items-start gap-1 text-caption text-text-secondary">
              Requests a minute
              <Input size="sm" inputMode="numeric" className="w-28" wrapClassName="w-28" placeholder={String(data.burst.default_per_minute)} value={form.perMinute}
                onChange={(e) => setForm((f) => f && ({ ...f, perMinute: e.target.value }))} invalid={!!errors.perMinute} />
              {errors.perMinute && <span className="text-micro text-danger-text">{errors.perMinute}</span>}
            </label>
            <label className="flex flex-col items-start gap-1 text-caption text-text-secondary">
              Requests a day
              <Input size="sm" inputMode="numeric" className="w-28" wrapClassName="w-28" placeholder={String(data.burst.default_per_day)} value={form.perDay}
                onChange={(e) => setForm((f) => f && ({ ...f, perDay: e.target.value }))} invalid={!!errors.perDay} />
              {errors.perDay && <span className="text-micro text-danger-text">{errors.perDay}</span>}
            </label>
          </div>
          <p className="mt-3 text-micro text-text-muted">In force: {data.burst.effective_per_minute} a minute, {data.burst.effective_per_day} a day (UTC).</p>
        </Card>
        <Card aria-labelledby="bud-user-h">
          <CardTitle id="bud-user-h" title="Per-person daily cap" sub="The default USD a signed-in person can spend on AI per UTC day, all features together. A person's own cap (Users) wins." />
          <label className="flex flex-col items-start gap-1 text-caption text-text-secondary">
            Default cap
            <Input size="sm" inputMode="decimal" textPrefix="$" wrapClassName="w-28" placeholder={data.default_user_daily_usd === null ? "No cap" : String(data.default_user_daily_usd)}
              value={form.userDaily} onChange={(e) => setForm((f) => f && ({ ...f, userDaily: e.target.value }))} invalid={!!errors.userDaily} />
            {errors.userDaily && <span className="text-micro text-danger-text">{errors.userDaily}</span>}
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-caption text-text-secondary">
            <Badge size="sm" tone={data.blocked_users ? "danger" : "neutral"}>{plural(data.blocked_users, "person", "people")} blocked</Badge>
            <Badge size="sm" tone="neutral">{plural(data.capped_users, "own cap")}</Badge>
            <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => onGo("users")}>Manage people</Button>
          </div>
        </Card>
      </div>

      <Card aria-labelledby="bud-audit-h">
        <CardTitle id="bud-audit-h" title="Change log" sub={data.updated_at ? `Last saved ${fmtDateTime(data.updated_at)} by ${data.updated_by}` : "Every change to the budgets, and every Block or cap, with who made it."} />
        {audit.error ? <Alert tone="danger">Couldn&apos;t load the change log.</Alert> : !audit.data ? <LoadingBlock label="Loading the change log" /> : (
          audit.data.items.length === 0 ? <p className="py-3 text-caption text-text-secondary">No changes yet. Everything is on the config defaults.</p> : (
            <ul className="flex flex-col divide-y divide-border">
              {audit.data.items.map((a) => <AuditItem key={a.id} a={a} />)}
            </ul>
          )
        )}
      </Card>

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} tone="default" confirmLabel="Save and apply" size="md"
        title="Apply these budget changes?"
        body={<ul className="flex list-disc flex-col gap-1 pl-5 text-body text-text">{diff.map((d) => <li key={d}>{d}</li>)}</ul>}
        description="They take effect within seconds for every AI request."
        onConfirm={save} />
    </div>
  );
}

const AUDIT_FEATURE: Record<string, string> = { "*": "All AI", docs_ask: "Docs Ask AI", docs_editor: "Guides editor AI", pages_ai: "Pages AI", search_ai: "AI search", analytics_ai: "Analytics AI", meetings_ai: "Meetings AI" };

function describe(v: unknown, money: boolean): string {
  if (v === null || v === undefined) return "default";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return money ? usd(v) : n0(v);
  return JSON.stringify(v);
}

/** One audit row as short "field: before → after" lines. */
function AuditItem({ a }: { a: AuditRow }) {
  const lines: string[] = [];
  if (a.kind === "covers") {
    const st = (o: Record<string, unknown> | null) => String(o?.status ?? "idle");
    lines.push(st(a.after) === "paused" ? "Paused" : st(a.after) === "running" ? "Resumed" : `${st(a.before)} → ${st(a.after)}`);
  } else if (a.kind === "user") {
    for (const k of ["blocked", "daily_usd"]) {
      const before = a.before?.[k] ?? (k === "blocked" ? false : null), after = a.after?.[k] ?? (k === "blocked" ? false : null);
      if (before !== after) lines.push(k === "blocked" ? (after ? "Blocked from AI" : "Unblocked") : `Daily cap ${before === null ? "default" : usd(before as number)} → ${after === null ? "default" : usd(after as number)}`);
    }
  } else {
    const flat = (o: Record<string, unknown> | null) => {
      const out: Record<string, unknown> = {};
      const caps = (o?.caps ?? {}) as Record<string, Record<string, number>>;
      for (const [f, c] of Object.entries(caps)) for (const [k, v] of Object.entries(c)) out[`${AUDIT_FEATURE[f] ?? f} ${k.replace("_usd", "")} cap`] = v;
      for (const [f, v] of Object.entries((o?.enabled ?? {}) as Record<string, boolean>)) out[`${AUDIT_FEATURE[f] ?? f}`] = v;
      for (const [k, v] of Object.entries((o?.burst ?? {}) as Record<string, number>)) out[`Burst ${k.replace("_", " ")}`] = v;
      if (o && "user_daily_usd" in o) out["Per-person daily cap"] = o.user_daily_usd;
      return out;
    };
    const b = flat(a.before), f = flat(a.after);
    for (const k of new Set([...Object.keys(b), ...Object.keys(f)])) {
      const isSwitch = Object.values(AUDIT_FEATURE).includes(k);
      const money = !k.startsWith("Burst");
      if (JSON.stringify(b[k]) !== JSON.stringify(f[k])) lines.push(`${k}: ${describe(b[k] ?? (isSwitch ? true : null), money)} → ${describe(f[k] ?? (isSwitch ? true : null), money)}`);
    }
  }
  return (
    <li className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-body text-text">{a.kind === "user" ? <>Person <b className="font-medium">{a.target_label || a.target}</b></> : a.kind === "covers" ? "Cover backfill" : "Budgets"}</p>
        <ul className="mt-0.5 flex flex-col text-caption text-text-secondary">{(lines.length ? lines : ["No visible change"]).map((l) => <li key={l}>{l}</li>)}</ul>
      </div>
      <p className="shrink-0 text-micro text-text-muted">{fmtDateTime(a.ts)} · {a.admin}</p>
    </li>
  );
}
