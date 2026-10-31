"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, EmptyState, Icon, Skeleton, Spinner, cx } from "@/components/ui";
import { RecordBlock } from "@/components/workspace/RecordBlock";
import { API_BASE } from "@/lib/api";
import type { DomainCheck as Check } from "@/lib/guideDomains";

const POLL_MS = 30_000;

type State = { kind: "loading" } | { kind: "ok"; data: Check; at: number } | { kind: "missing" } | { kind: "error"; message: string };

async function fetchCheck(host: string): Promise<State> {
  try {
    // Public and read-only: no session is sent.
    const res = await fetch(`${API_BASE}/api/v1/docs-sites/domain-check/${encodeURIComponent(host)}`, { cache: "no-store" });
    if (res.status === 404) return { kind: "missing" };
    if (res.status === 429) return { kind: "error", message: "That's a lot of checks. Try again in a minute." };
    if (!res.ok) return { kind: "error", message: "Couldn't check right now. Try again in a minute." };
    return { kind: "ok", data: (await res.json()) as Check, at: Date.now() };
  } catch {
    return { kind: "error", message: "Couldn't reach Markdrop. Check your connection and try again." };
  }
}

/**
 * The public domain check (markdrop.in/d/check/<host>), for whoever runs a guide's DNS: the record to
 * add in their provider's words, then Record found → HTTPS certificate → Live, re-checked every 30
 * seconds while the page is open.
 */
export default function DomainCheck({ host }: { host: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    const next = await fetchCheck(host);
    // A passing error keeps what was there.
    setState((prev) => (next.kind === "error" && prev.kind === "ok" ? prev : next));
    setBusy(false);
  }, [host]);

  useEffect(() => { void check(); }, [check]);

  const live = state.kind === "ok" && state.data.status === "live";
  useEffect(() => {
    if (live || state.kind === "missing") return;
    const t = window.setInterval(() => { if (document.visibilityState !== "hidden") void check(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [live, state.kind, check]);

  if (state.kind === "missing") {
    return (
      <EmptyState
        icon="globe"
        title="Nothing to check here"
        description={<>Markdrop isn&apos;t setting up <span className="font-mono">{host}</span>. Check the link you were sent, or ask the person who sent it.</>}
      />
    );
  }

  const d = state.kind === "ok" ? state.data : null;
  const p = d?.provider;
  const known = !!p?.detected;
  const seen = !!d && (d.status === "live" || d.stage === "certificate" || d.record_seen === true);
  const failed = d?.status === "failed";
  const rows: Array<{ label: string; note: string; state: "done" | "running" | "waiting" | "failed" }> = [
    { label: "Record found", state: seen ? "done" : failed ? "failed" : "running", note: seen ? "points at Markdrop" : d?.record_points_to ? `points to ${d.record_points_to} instead` : "waiting for it to appear" },
    { label: "HTTPS certificate issued", state: live ? "done" : seen && !failed ? "running" : "waiting", note: "automatic" },
    { label: `Live at ${host}`, state: live ? "done" : "waiting", note: live ? "all done" : "" },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="text-eyebrow uppercase text-text-muted">Markdrop Guides · domain check</p>
        <h1 className="font-mono text-[24px] font-bold leading-8 text-text [overflow-wrap:anywhere]">{host}</h1>
        <p className="text-body text-text-secondary">
          {live
            ? "This domain is set up: it serves a help center made with Markdrop Guides, with HTTPS. Nothing else to do."
            : "Someone is putting a help center made with Markdrop Guides on this domain. It needs one DNS record, below. This page checks for it on its own."}
        </p>
      </div>

      {state.kind === "error" && <Alert tone="warning">{state.message}</Alert>}
      {state.kind === "loading" && <Skeleton variant="rect" height={220} />}

      {d && (
        <>
          <section aria-labelledby="st" className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:p-[22px]">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="st" className="flex-1 text-[16px] font-semibold text-text">Status</h2>
              {live ? <Badge tone="success" size="sm" dot>Live</Badge> : failed ? <Badge tone="danger" size="sm" icon="alertCircle">Not live</Badge> : <Badge tone="warning" size="sm" icon="clock">In progress</Badge>}
              {!live && <Button variant="ghost" size="sm" iconLeft="refresh" loading={busy} onClick={() => void check()}>Check now</Button>}
            </div>
            <ol className="m-0 flex list-none flex-col gap-1 p-0">
              {rows.map((r) => (
                <li key={r.label} className={cx("flex flex-wrap items-center gap-3 rounded-lg px-2.5 py-2", r.state === "running" && "bg-accent-soft", r.state === "failed" && "bg-danger-soft")}>
                  <span className={cx("grid size-[22px] shrink-0 place-items-center rounded-full", r.state === "done" ? "bg-success-soft text-success" : r.state === "failed" ? "text-danger" : "bg-surface-inset text-text-muted")}>
                    {r.state === "done" ? <Icon name="check" size={13} /> : r.state === "running" ? <Spinner size={13} /> : r.state === "failed" ? <Icon name="alertCircle" size={14} /> : null}
                  </span>
                  <span className={cx("min-w-0 flex-1 [overflow-wrap:anywhere]", r.state === "waiting" ? "text-text-muted" : "text-text")}>{r.label}</span>
                  {r.note && <span className="text-caption text-text-muted [overflow-wrap:anywhere]">{r.note}</span>}
                </li>
              ))}
            </ol>
            {!live && <p className="text-caption text-text-muted">Checking every 30 seconds while this page is open. DNS changes usually show within minutes, sometimes up to an hour.</p>}
            {failed && <p className="text-caption text-text-secondary">Markdrop stopped checking after 3 days. Once the record is right, the person who set this up can start it again.</p>}
          </section>

          {!live && (
            <section aria-labelledby="rec" className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 sm:p-[22px]">
              <h2 id="rec" className="text-[16px] font-semibold text-text">The record to add</h2>
              {known ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="min-w-0 flex-[1_1_260px] text-body text-text-secondary">
                    {p!.zone}&apos;s DNS is at <strong className="text-text">{p!.provider_name}</strong>. This is written the way its form asks for it.{p!.note ? ` ${p!.note}` : ""}
                  </p>
                  {p!.panel_url && <Button variant="secondary" size="sm" iconRight="external" href={p!.panel_url} target="_blank" rel="noopener noreferrer">Open {p!.provider_name} DNS</Button>}
                </div>
              ) : (
                <p className="text-body text-text-secondary">
                  Add it where {p?.zone ?? "the domain"}&apos;s DNS is managed. If the form adds the domain to the name for you, type just the part before it.
                </p>
              )}
              <RecordBlock
                label="CNAME record"
                purpose="Sends readers to the help center"
                type={d.record.type}
                name={known ? d.record.host : d.record.name}
                value={d.record.value}
                nameLabel={known ? p!.host_field || "Name" : "Name"}
                valueLabel={known ? p!.value_field || "Value" : "Value"}
                extra={known ? (p!.extras ?? []).map((x): [string, string] => [x.label, x.value]) : undefined}
                found={d.record_seen === null ? null : seen}
              />
              <p className="text-caption text-text-muted">It doesn&apos;t touch email or any other name. Markdrop issues and renews the HTTPS certificate itself.</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
