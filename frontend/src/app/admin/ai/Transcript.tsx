"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Disclosure, Drawer, Icon, MarkdropMark, copyText, useToast } from "@/components/ui";
import { LoadingBlock, fmtDateTime, plural } from "../shared";
import { LIMIT_LABEL, n0, secs, tokensShort, usd, useAiFetch } from "./common";
import { Reply, citationHref, citationNumbers } from "./Reply";
import {
  ActorBadge, ScopeChip, WhoMark, personFilterOf, stamp, type Conversation, type PersonFilter, type Turn, type Who,
} from "./requestsShared";

/**
 * One conversation as a transcript: who asked what, in order, and how Markdrop replied (rendered as
 * they saw it, with numbered source chips), plus what each call cost. A drawer on wide screens,
 * full screen on phones (the kit's Drawer). Copy as markdown / Export use the API's transcript.
 */

export function TranscriptDrawer({ token, id, onClose, onPerson, onWorkspace }: {
  token: string; id: string | null; onClose: () => void;
  onPerson: (p: PersonFilter) => void; onWorkspace: (w: { value: string; label: string }) => void;
}) {
  const get = useAiFetch(token);
  const toast = useToast();
  const [state, setState] = useState<{ id?: string; data?: Conversation; error?: string }>({});
  const [busy, setBusy] = useState<"copy" | "export" | null>(null);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    if (!id) return;
    let live = true;
    setState((s) => (s.id === id && s.data ? s : { id }));
    get<Conversation>(`log/conversations/${encodeURIComponent(id)}`)
      .then((data) => live && setState({ id, data }))
      .catch((e) => live && setState({ id, error: e instanceof Error && /not found/i.test(e.message) ? "That conversation isn't in the log any more." : "Couldn't load this conversation." }));
    return () => { live = false; };
  }, [get, id, bump]);

  const d = state.id === id ? state.data : undefined;

  async function markdown() {
    if (!id) throw new Error("no id");
    return get<{ filename: string; markdown: string }>(`log/conversations/${encodeURIComponent(id)}/markdown`);
  }
  async function copy() {
    setBusy("copy");
    try {
      const m = await markdown();
      if (await copyText(m.markdown)) toast.success("Transcript copied as Markdown");
      else toast.error("Couldn't copy");
    } catch {
      toast.error("Couldn't get the transcript");
    } finally {
      setBusy(null);
    }
  }
  async function exportMd() {
    setBusy("export");
    try {
      const m = await markdown();
      const url = URL.createObjectURL(new Blob([m.markdown], { type: "text/markdown;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = m.filename || "ai-conversation.md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast.error("Couldn't export the transcript");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Drawer open={!!id} onClose={onClose} width={820} title={d?.title ?? "Conversation"}
      description={d ? [d.label, d.workspace_name].filter(Boolean).join(" · ") || undefined : undefined}
      bodyClassName="flex flex-col gap-5">
      {state.error ? (
        <Alert tone="danger" actions={<Button size="sm" variant="secondary" onClick={() => setBump((b) => b + 1)}>Try again</Button>}>{state.error}</Alert>
      ) : !d ? <LoadingBlock label="Loading conversation" minHeight={280} /> : (
        <>
          <Header d={d} busy={busy} onCopy={copy} onExport={exportMd}
            onPerson={(p) => { onPerson(p); onClose(); }}
            onWorkspace={(w) => { onWorkspace(w); onClose(); }} />
          {!d.content && (
            <Alert tone="info">Content capture was off for this conversation, so only who, when and what it cost were kept.</Alert>
          )}
          <ol className="flex flex-col gap-6" aria-label="Transcript">
            {d.turns_list.map((t, i) => <TurnView key={t.request_id || i} t={t} first={i === 0} prev={i > 0 ? d.turns_list[i - 1] : null} />)}
          </ol>
        </>
      )}
    </Drawer>
  );
}

function Header({ d, busy, onCopy, onExport, onPerson, onWorkspace }: {
  d: Conversation; busy: "copy" | "export" | null; onCopy: () => void; onExport: () => void;
  onPerson: (p: PersonFilter) => void; onWorkspace: (w: { value: string; label: string }) => void;
}) {
  const person = personFilterOf(d.who);
  return (
    <section aria-label="About this conversation" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-inset p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <WhoMark who={d.who} size={34} />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5 text-body-strong text-text">
              <span className="truncate">{d.who.name}</span>
              <ActorBadge who={d.who} />
            </p>
            {d.who.sub && <p className="truncate text-caption text-text-secondary">{d.who.sub}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" iconLeft="copy" loading={busy === "copy"} onClick={onCopy}>Copy as markdown</Button>
          <Button size="sm" variant="secondary" iconLeft="download" loading={busy === "export"} onClick={onExport}>Export</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-caption text-text-secondary">
        {d.scope_label && <ScopeChip>{d.scope_label}</ScopeChip>}
        {d.label && <Badge size="sm" tone="neutral">{d.label}</Badge>}
        {d.workspace_id && d.workspace_name && (
          <Button size="sm" variant="ghost" iconLeft="folder" onClick={() => onWorkspace({ value: d.workspace_id!, label: d.workspace_name! })}
            aria-label={`Show only workspace ${d.workspace_name}`}>{d.workspace_name}</Button>
        )}
        {d.has_error && <Badge size="sm" tone="danger">Has errors</Badge>}
      </div>
      <dl className="grid grid-cols-2 gap-2 text-caption sm:grid-cols-4">
        {[
          ["Turns", n0(d.turns)],
          ["Cost", usd(d.cost_usd)],
          ["Tokens in / out", `${tokensShort(d.tokens_in)} / ${tokensShort(d.tokens_out)}`],
          ["When", d.first_ts ? fmtDateTime(d.first_ts) : "—"],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-micro text-text-muted">{k}</dt>
            <dd className="truncate tabular-nums text-text">{v}</dd>
          </div>
        ))}
      </dl>
      {person && (
        <div>
          <Button size="sm" variant="link" iconLeft="filter" onClick={() => onPerson(person)}>Everything from {person.label}</Button>
        </div>
      )}
    </section>
  );
}

const isSystemTurn = (t: Turn) => t.who.kind === "system" || (!t.input && !!t.description);

function TurnView({ t, first, prev }: { t: Turn; first: boolean; prev: Turn | null }) {
  const scopeChanged = t.scope_label && (first || t.scope_label !== prev?.scope_label);
  return (
    <li className="flex flex-col gap-3" data-testid="ai-turn">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-text-muted">
        <time dateTime={t.ts ?? undefined} title={t.ts ? fmtDateTime(t.ts) : undefined}>{stamp(t.ts)}</time>
        {t.label && <span>· {t.label}</span>}
        {scopeChanged && <ScopeChip>{t.scope_label}</ScopeChip>}
        {t.page_title && t.page_title !== t.scope_label && <span className="truncate">· {t.page_title}</span>}
      </div>

      {isSystemTurn(t) ? <SystemLine t={t} /> : <Asked t={t} />}
      <Replied t={t} />
      <Meta t={t} />
    </li>
  );
}

function SystemLine({ t }: { t: Turn }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-2 text-caption text-text-secondary">
        <Icon name="server" size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0"><span className="font-medium text-text">{t.who.job || t.who.name}</span>
          {t.description ? <>: {t.description}</> : t.label ? <>: {t.label}</> : null}
          {t.who.sub ? <span className="text-text-muted"> · {t.who.sub}</span> : null}
        </span>
      </p>
      {t.input && (
        <Disclosure summary={<span className="text-caption">Input sent{t.input_truncated ? " (cut)" : ""}</span>}>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-inset p-3 text-micro text-text">{t.input}</pre>
        </Disclosure>
      )}
    </div>
  );
}

function Asked({ t }: { t: Turn }) {
  const who: Who = t.who;
  return (
    <div className="flex flex-col items-end gap-1">
      <p className="flex items-center gap-1.5 text-micro text-text-muted">
        <span><span className="font-medium text-text-secondary">{who.name}</span> asked</span>
        <WhoMark who={who} size={20} />
      </p>
      <div className="max-w-[min(85%,36rem)] rounded-2xl rounded-tr-md bg-accent-soft px-3.5 py-2.5 text-body text-text">
        {t.selection && (
          <blockquote className="mb-2 border-l-2 border-accent pl-2.5 text-caption text-text-secondary">
            <span className="mb-0.5 block text-micro font-medium uppercase tracking-wide text-text-muted">Selected text</span>
            <span className="line-clamp-6 whitespace-pre-wrap break-words">{t.selection}</span>
          </blockquote>
        )}
        {t.input ? (
          <p className="whitespace-pre-wrap break-words">{t.input}{t.input_truncated && <span className="text-micro text-text-muted"> (cut)</span>}</p>
        ) : (
          <p className="text-caption italic text-text-muted">{t.content ? "No question text." : "Not captured."}</p>
        )}
      </div>
    </div>
  );
}

function Status({ t }: { t: Turn }) {
  if (t.outcome_kind === "ok") return null;
  if (t.outcome_kind === "limit") {
    return <Alert tone="info" title="Limited">{t.limit_reason ? LIMIT_LABEL[t.limit_reason] ?? t.limit_reason : "A cap or limit stopped this request."}{t.limit_reason && LIMIT_LABEL[t.limit_reason] ? <span className="text-text-muted"> ({t.limit_reason})</span> : null}</Alert>;
  }
  if (t.outcome_kind === "refused") {
    return <Alert tone="warning" title="Refused">{t.limit_reason || t.error_code || t.outcome || "The request was refused."}</Alert>;
  }
  return <Alert tone="danger" title="Error">{t.error_code || t.outcome || "The call failed."}{t.stop_reason ? <span className="text-text-muted"> · stop: {t.stop_reason}</span> : null}</Alert>;
}

function Replied({ t }: { t: Turn }) {
  const order = useMemo(() => citationNumbers(t.output ?? "", t.citations), [t.output, t.citations]);
  const sources = useMemo(() => t.citations.map((c, i) => ({ c, n: order.byIndex[i] })).sort((a, b) => a.n - b.n), [t.citations, order]);
  const hasResults = t.results && Object.keys(t.results).length > 0;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="flex items-center gap-1.5 text-micro text-text-muted">
        <span className="inline-grid size-5 place-items-center rounded-full border border-border bg-surface"><MarkdropMark size={12} /></span>
        <span><span className="font-medium text-text-secondary">Markdrop</span> replied</span>
      </p>
      <div className="flex w-full max-w-[min(100%,44rem)] flex-col gap-3 rounded-2xl rounded-tl-md border border-border bg-surface px-3.5 py-3">
        <Status t={t} />
        {t.output ? (
          <>
            <Reply text={t.output} format={t.output_format} citations={t.citations} />
            {t.output_truncated && <p className="text-micro text-text-muted">(cut: the reply was longer than the log keeps)</p>}
          </>
        ) : t.outcome_kind === "ok" ? (
          <p className="text-caption italic text-text-muted">{t.content ? "No reply text." : "Content capture was off."}</p>
        ) : null}

        {sources.length > 0 && (
          <section aria-label="Sources" className="flex flex-col gap-1.5">
            <p className="text-micro font-medium uppercase tracking-wide text-text-muted">Sources</p>
            <ol className="flex flex-col gap-1">
              {sources.map(({ c, n }) => {
                const href = citationHref(c);
                const sub = [c.subtitle, c.moment, c.page].filter(Boolean).join(" · ");
                const body = (
                  <>
                    <span aria-hidden className="inline-grid h-[18px] min-w-[19px] shrink-0 place-items-center rounded-md bg-accent-soft px-1 text-[11px] font-bold tabular-nums text-accent-text">{n}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-caption text-text">{c.title || c.url || c.label || "Source"}</span>
                      {sub && <span className="block truncate text-micro text-text-muted">{sub}</span>}
                      {c.quote && <span className="mt-0.5 block line-clamp-2 text-micro italic text-text-secondary">“{c.quote}”</span>}
                    </span>
                  </>
                );
                return (
                  <li key={`${n}-${c.label ?? c.id ?? ""}`}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="md-focus flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-hover"
                        aria-label={`Source ${n}: ${c.title || href} (opens in a new tab)`}>{body}</a>
                    ) : <div className="flex items-start gap-2 px-1.5 py-1">{body}</div>}
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {t.context && (t.context.summary || t.context.items.length > 0) && (
          <Disclosure summary={<span className="text-caption">Context sent: {t.context.summary || plural(t.context.items.length, "item")}</span>}>
            <ul className="mt-1 flex flex-col gap-1 text-caption">
              {t.context.items.map((it, i) => {
                const href = it.url ? citationHref({ url: it.url }) : null;
                return (
                  <li key={`${it.id ?? it.title ?? ""}-${i}`} className="flex min-w-0 items-baseline gap-2">
                    {it.kind && <Badge size="sm" tone="neutral">{it.kind}</Badge>}
                    {href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="truncate text-accent-text underline underline-offset-2">{it.title || it.slug || href}</a>
                      : <span className="truncate text-text">{it.title || it.slug || it.label || it.id || "—"}</span>}
                    {it.subtitle && <span className="truncate text-micro text-text-muted">{it.subtitle}</span>}
                  </li>
                );
              })}
              {t.context.more > 0 && <li className="text-micro text-text-muted">and {plural(t.context.more, "more item")}</li>}
            </ul>
          </Disclosure>
        )}

        {hasResults && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Results">
            <span className="text-micro font-medium uppercase tracking-wide text-text-muted">Results</span>
            {Object.entries(t.results!).map(([k, v]) => (
              <span key={k} className="rounded-full border border-border px-2 py-0.5 text-micro text-text-secondary">
                {k.replace(/_/g, " ")}: <span className="font-medium text-text">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
              </span>
            ))}
          </div>
        )}
        {t.actions && t.actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Actions">
            <span className="text-micro font-medium uppercase tracking-wide text-text-muted">Actions</span>
            {t.actions.map((a, i) => <Badge key={`${a}-${i}`} size="sm" tone="info">{a}</Badge>)}
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ t }: { t: Turn }) {
  const toast = useToast();
  const bits = [
    t.feature_label || t.feature,
    t.model,
    t.calls ? plural(t.calls, "call") : null,
    `${tokensShort(t.tokens.prompt)} in / ${tokensShort(t.tokens.output)} out`,
    usd(t.cost_usd),
    t.latency_ms !== null ? secs(t.latency_ms) : null,
    t.via ? `via ${t.via}` : null,
  ].filter(Boolean);
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-micro text-text-muted">
      <span>{bits.join(" · ")}</span>
      {t.request_id && (
        <button type="button" className="md-focus inline-flex items-center gap-1 rounded-sm font-mono hover:text-text"
          aria-label={`Copy request id ${t.request_id}`} title="Copy request id"
          onClick={() => { void copyText(String(t.request_id)).then((ok) => (ok ? toast.success("Request id copied") : toast.error("Couldn't copy"))); }}>
          · {String(t.request_id).slice(0, 12)}{String(t.request_id).length > 12 ? "…" : ""}<Icon name="copy" size={11} />
        </button>
      )}
    </p>
  );
}
