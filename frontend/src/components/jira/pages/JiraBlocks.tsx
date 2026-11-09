"use client";

/**
 * Jira inside pages, as readers (and the editor's node views) draw it:
 *
 *   JiraInline   :jira[KEY]{site}      "KEY · title" + the status for people whose Jira can open it; a
 *                                      click opens the issue's card with its actions
 *   JiraCard     ::jira{key site}      title, status, assignee, priority, type, due, sprint, updated + actions
 *   JiraList     ::jira-list{…}        a live table (under the viewer's own Jira), actions per row
 *
 * Who sees what: live details only through the viewer's own Jira (store.ts). Everyone else sees the
 * snapshot, "KEY · title", and a signed-in viewer without Jira gets "Connect Jira". Changes are made as
 * the viewer; Jira's refusal is shown as it is. Neutral visuals (no Atlassian marks).
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Avatar, Button, Dialog, Dropdown, Field, Icon, IconButton, Input, Popover, Select, Spinner, Textarea, useToast, type MenuEntry } from "@/components/ui";
import { CATEGORY_LABEL, connectMyJira } from "@/lib/jira";
import {
  JIRA_COLS, DEFAULT_COLS, jiraAssign, jiraAssignable, jiraComment, jiraEdit, jiraPageList, jiraPriorities, jiraTransition, jiraTransitions,
  linkText, specJql, type JiraCol, type JiraIssue, type JiraListPage, type JiraListSpec, type JiraPageItem, type JiraPersonOption, type JiraTransition,
} from "@/lib/jiraPages";
import { useJiraItem, useJiraState, type JiraPagesStore } from "./store";
import "../jira.css";
import "./jiraPages.css";

type Issue = JiraIssue & { sprint?: string | null };

function StatusPill({ issue }: { issue: Issue }) {
  const cat = issue.status.category;
  return (
    <span className={`jr-status jr-status--${cat}${issue.blocked && cat !== "done" ? " jr-status--blocked" : ""}`} title={CATEGORY_LABEL[cat]}>
      {issue.status.name || CATEGORY_LABEL[cat]}
    </span>
  );
}

function errText(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : iso;
}

function overdue(issue: Issue): boolean {
  return !!issue.due && issue.status.category !== "done" && issue.due < new Date().toISOString().slice(0, 10);
}

/** "Connect Jira" for a signed-in viewer without a (working) connection. */
export function ConnectJira({ broken, compact }: { broken?: boolean; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button size="sm" variant={compact ? "ghost" : "secondary"} iconLeft="link" loading={busy} data-testid="jira-connect"
      onClick={() => { setBusy(true); void connectMyJira().catch(() => setBusy(false)); }}>
      {broken ? "Reconnect Jira" : "Connect Jira"}
    </Button>
  );
}

/* ── Actions (as the viewer) ─────────────────────────────────────────────── */

interface ActCtx { store: JiraPagesStore | null; site: string; slug: string | null }

function useAct({ store, site, slug }: ActCtx) {
  const toast = useToast();
  return useCallback(async (what: string, fn: () => Promise<{ issue: JiraIssue | null }>) => {
    try {
      const r = await fn();
      store?.patch(site, r.issue);
      toast.success(what);
      return true;
    } catch (e) {
      toast.error(errText(e, "Jira didn't take that change."));
      return false;
    }
  }, [store, site, toast]);
  void slug;
}

/** The status button: every step of the issue's workflow open to the viewer (Jira's transitions). */
export function StatusMenu({ issue, ctx, size = "sm" }: { issue: Issue; ctx: ActCtx; size?: "sm" | "xs" }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<JiraTransition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<JiraTransition | null>(null);
  const act = useAct(ctx);
  useEffect(() => {
    if (!open) return;
    let gone = false;
    setSteps(null);
    setError(null);
    jiraTransitions(ctx.site, issue.key).then((r) => !gone && setSteps(r.transitions)).catch((e) => !gone && setError(errText(e, "Couldn't load the workflow.")));
    return () => { gone = true; };
  }, [open, ctx.site, issue.key]);
  const take = (t: JiraTransition) => {
    if (t.fields.some((f) => f.required)) return setNeeds(t);
    void act(`${issue.key} → ${t.to.name || t.name}`, () => jiraTransition(ctx.site, issue.key, t.id, null, ctx.slug));
  };
  const items: MenuEntry[] = error ? [{ header: error }]
    : steps === null ? [{ custom: <span className="jp-menu-wait"><Spinner size={14} /> Loading steps…</span> }]
    : steps.length ? [{ header: "Move to" }, ...steps.map((t) => ({
      label: <span className="jp-step"><span className={`jp-dot jp-dot--${t.to.category}`} aria-hidden />{t.name}{t.to.name && t.to.name !== t.name ? <span className="jp-step__to"> → {t.to.name}</span> : null}</span>,
      onClick: () => take(t), caption: t.fields.some((f) => f.required) ? "Asks for more" : undefined,
    }))]
    : [{ header: "Jira offers you no step for this issue." }];
  return (
    <>
      <Dropdown open={open} onOpenChange={setOpen} align="left" portal minWidth={220} aria-label={`Change status of ${issue.key}`} items={items}
        trigger={
          <button type="button" className={`jp-statusbtn jp-statusbtn--${size} md-focus`} data-testid="jira-status" aria-label={`Status: ${issue.status.name}. Change it`}>
            <StatusPill issue={issue} />
            <Icon name="chevronDown" size={12} aria-hidden />
          </button>
        } />
      {needs && <TransitionDialog step={needs} issue={issue} ctx={ctx} onClose={() => setNeeds(null)} />}
    </>
  );
}

/** A step whose screen asks for fields (a resolution, a comment…). */
function TransitionDialog({ step, issue, ctx, onClose }: { step: JiraTransition; issue: Issue; ctx: ActCtx; onClose: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = useAct(ctx);
  const fields = step.fields;
  const missing = fields.some((f) => f.required && !vals[f.key]);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await jiraTransition(ctx.site, issue.key, step.id, vals, ctx.slug);
      ctx.store?.patch(ctx.site, r.issue);
      onClose();
      void act;
    } catch (e) {
      setErr(errText(e, "Jira didn't take that step."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} size="sm" title={`${step.name}: ${issue.key}`} description={`Jira needs a little more to move it to ${step.to.name || step.name}.`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void go()} loading={busy} disabled={missing} data-testid="jira-step-go">{step.name}</Button></>}>
      <div className="jp-form">
        {fields.map((f) => (
          <Field key={f.key} label={f.name} required={f.required}>
            {f.options.length ? (
              <Select value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} data-testid={`jira-field-${f.key}`}
                options={[{ value: "", label: "Choose…" }, ...f.options.map((o) => ({ value: o.id, label: o.name }))]} />
            ) : f.type === "date" ? (
              <Input type="date" value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            ) : (
              <Input value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
            )}
          </Field>
        ))}
        {err && <p className="jp-err" role="alert">{err}</p>}
      </div>
    </Dialog>
  );
}

/** Assign: people Jira lets this issue be assigned to (searched as you type). */
function AssigneeButton({ issue, ctx }: { issue: Issue; ctx: ActCtx }) {
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<JiraPersonOption[] | null>(null);
  const [open, setOpen] = useState(false);
  const act = useAct(ctx);
  useEffect(() => {
    if (!open) return;
    let gone = false;
    const t = window.setTimeout(() => {
      jiraAssignable(ctx.site, issue.key, q).then((r) => !gone && setPeople(r.people)).catch(() => !gone && setPeople([]));
    }, 200);
    return () => { gone = true; window.clearTimeout(t); };
  }, [open, q, ctx.site, issue.key]);
  const pick = (p: JiraPersonOption | null, close: () => void) => {
    close();
    void act(p ? `${issue.key} assigned to ${p.name}` : `${issue.key} unassigned`, () => jiraAssign(ctx.site, issue.key, p?.account_id ?? null, ctx.slug));
  };
  return (
    <Popover open={open} onOpenChange={setOpen} portal width={260} aria-label={`Assign ${issue.key}`}
      trigger={
        <button type="button" className="jp-fieldbtn md-focus" data-testid="jira-assignee" aria-label={issue.assignee ? `Assignee: ${issue.assignee.name}. Change` : "Assign"}>
          {issue.assignee ? <><Avatar name={issue.assignee.name} src={issue.assignee.avatar ?? undefined} size="sm" /> <span className="jp-ellipsis">{issue.assignee.name}</span></> : <span className="jp-muted">Unassigned</span>}
        </button>
      }>
      {({ close }) => (
        <div className="jp-people">
          <Input autoFocus size="sm" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" iconLeft="search" />
          <ul role="listbox" aria-label="People">
            {issue.assignee && <li><button type="button" className="jp-person" onClick={() => pick(null, close)}><Icon name="userX" size={16} /> Unassign</button></li>}
            {people === null ? <li className="jp-muted"><Spinner size={14} /> Searching…</li>
              : people.length ? people.map((p) => (
                <li key={p.account_id}><button type="button" className="jp-person" data-testid="jira-person" onClick={() => pick(p, close)}><Avatar name={p.name} src={p.avatar ?? undefined} size="sm" /> {p.name}</button></li>
              )) : <li className="jp-muted">Nobody matches.</li>}
          </ul>
        </div>
      )}
    </Popover>
  );
}

function CommentButton({ issue, ctx }: { issue: Issue; ctx: ActCtx }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const act = useAct(ctx);
  return (
    <Popover portal width={320} title={`Comment on ${issue.key} in Jira`} trap
      trigger={<Button size="sm" variant="ghost" iconLeft="message" data-testid="jira-comment">Comment</Button>}>
      {({ close }) => (
        <form className="jp-form" onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          const ok = await act(`Commented on ${issue.key}`, () => jiraComment(ctx.site, issue.key, text, ctx.slug));
          setBusy(false);
          if (ok) { setText(""); close(); }
        }}>
          <Textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Added in Jira as you" aria-label="Comment" maxLength={5000} />
          <div className="jp-form__end"><Button size="sm" type="submit" loading={busy} disabled={!text.trim()} data-testid="jira-comment-send">Add comment</Button></div>
        </form>
      )}
    </Popover>
  );
}

function EditButton({ issue, ctx }: { issue: Issue; ctx: ActCtx }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" iconLeft="edit" onClick={() => setOpen(true)} data-testid="jira-edit">Edit</Button>
      {open && <EditDialog issue={issue} ctx={ctx} onClose={() => setOpen(false)} />}
    </>
  );
}

function EditDialog({ issue, ctx, onClose }: { issue: Issue; ctx: ActCtx; onClose: () => void }) {
  const [summary, setSummary] = useState(issue.summary ?? "");
  const [priority, setPriority] = useState(issue.priority ?? "");
  const [due, setDue] = useState(issue.due ?? "");
  const [prios, setPrios] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    jiraPriorities(ctx.site).then((r) => setPrios(r.priorities.map((p) => p.name))).catch(() => setPrios([]));
  }, [ctx.site]);
  async function save() {
    const changes: { summary?: string; priority?: string; due?: string | null } = {};
    if (summary.trim() !== (issue.summary ?? "")) changes.summary = summary.trim();
    if (priority && priority !== (issue.priority ?? "")) changes.priority = priority;
    if (due !== (issue.due ?? "")) changes.due = due || null;
    if (!Object.keys(changes).length) return onClose();
    setBusy(true);
    setErr(null);
    try {
      const r = await jiraEdit(ctx.site, issue.key, changes, ctx.slug);
      ctx.store?.patch(ctx.site, r.issue);
      onClose();
    } catch (e) {
      setErr(errText(e, "Jira didn't save it."));
    } finally {
      setBusy(false);
    }
  }
  const pid = useId();
  return (
    <Dialog open onClose={onClose} size="sm" title={`Edit ${issue.key}`} description="Saved in Jira as you."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void save()} loading={busy} disabled={!summary.trim()} data-testid="jira-edit-save">Save</Button></>}>
      <div className="jp-form">
        <Field label="Title" htmlFor={`${pid}-t`}><Input id={`${pid}-t`} value={summary} maxLength={255} onChange={(e) => setSummary(e.target.value)} data-testid="jira-edit-summary" /></Field>
        <Field label="Priority" htmlFor={`${pid}-p`}>
          <Select id={`${pid}-p`} value={priority} onChange={(e) => setPriority(e.target.value)}
            options={[...(priority && !prios.includes(priority) ? [priority] : []), ...prios].map((p) => ({ value: p, label: p })).concat(priority ? [] : [{ value: "", label: "None" }])} />
        </Field>
        <Field label="Due date" htmlFor={`${pid}-d`}><Input id={`${pid}-d`} type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        {err && <p className="jp-err" role="alert">{err}</p>}
      </div>
    </Dialog>
  );
}

/* ── The inline chip ─────────────────────────────────────────────────────── */

/** Its look alone (also the editor's drag preview): key, title, and the status when known. */
export function ChipFace({ issueKey, title, issue }: { issueKey: string; title: string | null; issue: Issue | null }) {
  const t = issue?.summary ?? title;
  return (
    <>
      <span className="jp-chip__glyph" aria-hidden><Icon name="checkSquare" size={12} /></span>
      <span className="jp-chip__key">{issueKey}</span>
      {t && <span className="jp-chip__title">{t}</span>}
      {issue && <StatusPill issue={issue} />}
    </>
  );
}

export function JiraInline({ store, site, issueKey, slug, editing }: { store: JiraPagesStore | null; site: string | null; issueKey: string; slug: string | null; editing?: boolean }) {
  const { item, state } = useJiraItem(store, site, issueKey);
  const s = item?.site ?? store?.siteFor(site) ?? site;
  const url = item?.url ?? (s ? `https://${s}/browse/${issueKey}` : null);
  const issue = (item?.issue as Issue | null) ?? null;
  const label = issue ? `${issueKey}: ${issue.summary ?? ""} (${issue.status.name})` : linkText(issueKey, item?.title);
  // Nobody to act for (anonymous, or no Jira): a plain link to the issue.
  if (!state.signed_in || !s) {
    return (
      <a className="jp-chip not-prose md-focus" href={url ?? undefined} target="_blank" rel="noreferrer" data-testid="jira-inline" data-key={issueKey} aria-label={`Jira issue ${label}`}>
        <ChipFace issueKey={issueKey} title={item?.title ?? null} issue={null} />
      </a>
    );
  }
  return (
    <Popover portal width={360} aria-label={`Jira issue ${issueKey}`} placement="bottom-start"
      trigger={
        <button type="button" className="jp-chip not-prose md-focus" data-testid="jira-inline" data-key={issueKey} aria-label={`Jira issue ${label}. Open its card`} contentEditable={false}>
          <ChipFace issueKey={issueKey} title={item?.title ?? null} issue={issue} />
        </button>
      }>
      <CardBody store={store} item={item} site={s} issueKey={issueKey} slug={slug} pop editing={editing} />
    </Popover>
  );
}

/* ── The card ────────────────────────────────────────────────────────────── */

function CardBody({ store, item, site, issueKey, slug, pop, editing }: { store: JiraPagesStore | null; item: JiraPageItem | null; site: string; issueKey: string; slug: string | null; pop?: boolean; editing?: boolean }) {
  const state = useJiraState(store);
  const issue = (item?.issue as Issue | null) ?? null;
  const url = item?.url ?? `https://${site}/browse/${issueKey}`;
  const ctx: ActCtx = { store, site, slug };
  const title = issue?.summary ?? item?.title ?? null;
  void editing;
  return (
    <div className={`jp-card__body${pop ? " jp-card__body--pop" : ""}`}>
      <div className="jp-card__head">
        <span className="jp-card__glyph" aria-hidden><Icon name="checkSquare" size={14} /></span>
        <a className="jp-card__key md-focus" href={url} target="_blank" rel="noreferrer">{issueKey}</a>
        {issue?.type && <span className="jp-card__type">{issue.type}</span>}
        <a className="jp-card__open md-focus" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${issueKey} in Jira`} title="Open in Jira"><Icon name="external" size={14} /></a>
      </div>
      <p className="jp-card__title">{title || <span className="jp-muted">{issueKey}</span>}</p>
      {issue ? (
        <>
          <dl className="jp-card__fields">
            <div><dt>Status</dt><dd><StatusMenu issue={issue} ctx={ctx} /></dd></div>
            <div><dt>Assignee</dt><dd><AssigneeButton issue={issue} ctx={ctx} /></dd></div>
            <div><dt>Priority</dt><dd>{issue.priority ?? <span className="jp-muted">None</span>}</dd></div>
            <div><dt>Due</dt><dd className={overdue(issue) ? "jp-late" : undefined}>{issue.due ? fmtDay(issue.due) : <span className="jp-muted">None</span>}{overdue(issue) ? " · overdue" : ""}</dd></div>
            {issue.sprint && <div><dt>Sprint</dt><dd>{issue.sprint}</dd></div>}
            {issue.updated && <div><dt>Updated</dt><dd>{fmtDay(issue.updated)}</dd></div>}
          </dl>
          <div className="jp-card__actions">
            <CommentButton issue={issue} ctx={ctx} />
            <EditButton issue={issue} ctx={ctx} />
          </div>
        </>
      ) : !state.signed_in ? null : !state.connected ? (
        <div className="jp-card__note"><span>Connect your Atlassian account to see its status and change it here.</span><ConnectJira broken={state.broken} /></div>
      ) : store?.loaded ? (
        <p className="jp-card__note jp-muted">Your Jira can't open this issue.</p>
      ) : (
        <p className="jp-card__note jp-muted"><Spinner size={14} /> Loading…</p>
      )}
    </div>
  );
}

export function JiraCard({ store, site, issueKey, slug, editing, extra }: { store: JiraPagesStore | null; site: string | null; issueKey: string; slug: string | null; editing?: boolean; extra?: ReactNode }) {
  const { item } = useJiraItem(store, site, issueKey);
  const s = item?.site ?? store?.siteFor(site) ?? site ?? "";
  return (
    <div className="jp-card not-prose" data-testid="jira-card" data-key={issueKey}>
      {extra}
      <CardBody store={store} item={item} site={s} issueKey={issueKey} slug={slug} editing={editing} />
    </div>
  );
}

/* ── The live list ───────────────────────────────────────────────────────── */

function Cell({ col, issue, ctx }: { col: JiraCol; issue: Issue; ctx: ActCtx }) {
  switch (col) {
    case "status": return <StatusMenu issue={issue} ctx={ctx} size="xs" />;
    case "assignee": return issue.assignee ? <span className="jp-who"><Avatar name={issue.assignee.name} src={issue.assignee.avatar ?? undefined} size="sm" /><span className="jp-ellipsis">{issue.assignee.name}</span></span> : <span className="jp-muted">—</span>;
    case "priority": return <>{issue.priority ?? "—"}</>;
    case "type": return <>{issue.type ?? "—"}</>;
    case "due": return <span className={overdue(issue) ? "jp-late" : undefined}>{issue.due ? fmtDay(issue.due) : "—"}</span>;
    case "sprint": return <>{issue.sprint ?? "—"}</>;
    case "updated": return <>{issue.updated ? fmtDay(issue.updated) : "—"}</>;
  }
}

export function JiraList({ store, spec, slug, extra }: { store: JiraPagesStore | null; spec: JiraListSpec; slug: string | null; extra?: ReactNode }) {
  const state = useJiraState(store);
  const [rows, setRows] = useState<Issue[] | null>(null);
  const [page, setPage] = useState<JiraListPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const specKey = JSON.stringify(spec);
  const version = store?.version ?? 0;
  const site = store?.siteFor(spec.site) ?? spec.site ?? null;
  const ok = !!store && state.signed_in && state.connected && !!site;
  const seq = useRef(0);
  useEffect(() => {
    if (!ok || !slug) return;
    const n = ++seq.current;
    setErr(null);
    jiraPageList(slug, { ...spec, site }).then((r) => {
      if (n !== seq.current) return;
      setPage(r);
      setRows(r.issues);
    }).catch((e) => n === seq.current && setErr(errText(e, "Jira couldn't run this list.")));
  }, [ok, slug, specKey, version, site]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = (page?.cols ?? spec.cols ?? DEFAULT_COLS) as JiraCol[];
  const title = spec.title || "Jira issues";
  const jql = specJql(spec);
  const searchHref = site ? `https://${site}/issues/?jql=${encodeURIComponent(jql)}` : undefined;
  const ctx: ActCtx = { store, site: site ?? "", slug };
  async function loadMore() {
    if (!page?.next || !slug) return;
    setMore(true);
    try {
      const r = await jiraPageList(slug, { ...spec, site }, page.next);
      setRows((x) => [...(x ?? []), ...r.issues]);
      setPage({ ...r, issues: [] });
    } catch (e) {
      setErr(errText(e, "Couldn't load more."));
    } finally {
      setMore(false);
    }
  }
  return (
    <section className="jp-list not-prose" data-testid="jira-list" aria-label={title}>
      {extra}
      <header className="jp-list__head">
        <span className="jp-card__glyph" aria-hidden><Icon name="list" size={14} /></span>
        <h4 className="jp-list__title">{title}</h4>
        <code className="jp-list__jql" title={jql}>{jql}</code>
        {searchHref && <a className="jp-card__open md-focus" href={searchHref} target="_blank" rel="noreferrer" aria-label="Open this list in Jira" title="Open in Jira"><Icon name="external" size={14} /></a>}
      </header>
      {!state.signed_in ? (
        <p className="jp-list__note jp-muted">Sign in and connect Jira to see these issues.</p>
      ) : !state.connected ? (
        <div className="jp-list__note"><span>These issues show through your own Jira.</span><ConnectJira broken={state.broken} /></div>
      ) : !site ? (
        <p className="jp-list__note jp-muted">Your Jira doesn&apos;t reach this list&apos;s site.</p>
      ) : err && !rows ? (
        <p className="jp-list__note jp-err" role="alert">{err}</p>
      ) : rows === null ? (
        <p className="jp-list__note jp-muted"><Spinner size={14} /> Loading issues…</p>
      ) : !rows.length ? (
        <p className="jp-list__note jp-muted">No issues match.</p>
      ) : (
        <div className="jp-list__scroll">
          <table className="jp-table">
            <thead>
              <tr><th scope="col">Key</th><th scope="col">Summary</th>{cols.map((c) => <th key={c} scope="col">{JIRA_COLS.find((x) => x.id === c)?.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((it) => (
                <tr key={it.key} data-testid="jira-list-row" data-key={it.key}>
                  <td><a className="jp-chip__key md-focus" href={it.url ?? undefined} target="_blank" rel="noreferrer">{it.key}</a></td>
                  <td className="jp-table__summary">{it.summary}</td>
                  {cols.map((c) => <td key={c}><Cell col={c} issue={it} ctx={ctx} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {page?.next && <div className="jp-list__more"><Button size="sm" variant="secondary" loading={more} onClick={() => void loadMore()} data-testid="jira-list-more">Load more</Button></div>}
        </div>
      )}
    </section>
  );
}

export { IconButton };
