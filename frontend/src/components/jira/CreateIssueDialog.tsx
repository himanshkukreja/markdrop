"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Checkbox, Dialog, Field, Input, MarkdropLoader, Select, Textarea, useToast } from "@/components/ui";
import { WsApiError } from "@/lib/workspaces";
import {
  connectMyJira, jiraCreate, jiraCreateBulk, jiraDraft, jiraDraftAll, jiraIssueTypes,
  type JiraCreated, type JiraCreateFields, type JiraDraft, type JiraItemRef, type JiraOption,
} from "@/lib/jira";
import { JiraMark } from "./JiraMark";
import "./jira.css";

type Phase = { kind: "loading" } | { kind: "connect"; message: string } | { kind: "error"; message: string } | { kind: "ready" };

function fieldsOf(d: JiraDraft["draft"]): JiraCreateFields & { assignee_name?: string | null } {
  return {
    project: d.project ?? "", issue_type: d.issue_type, summary: d.summary, description: d.description,
    priority: d.priority, assignee_user_id: d.assignee?.user_id ?? null, due: d.due, labels: d.labels,
  };
}

function needsConnect(e: unknown): string | null {
  if (e instanceof WsApiError && e.status === 409 && /Atlassian|Connect/i.test(e.message)) return e.message;
  return null;
}

/**
 * Create a Jira issue from an item (a meeting's action item, decision or open question, a list item,
 * selected text, a Team line): Markdrop AI drafts the fields, the person reviews and edits every one,
 * then it's created as them (their own Atlassian connection) and linked to the item. Not connected yet:
 * a Connect step first. Restricted pages say who the link back works for.
 */
export function CreateIssueDialog({ open, item, workspaceId, onClose, onCreated, loadDraft, submit, title = "Create Jira issue" }: {
  open: boolean; item: JiraItemRef | null; workspaceId: string | null; onClose: () => void; onCreated?: (c: JiraCreated) => void;
  /** Another source than an item (a comment thread, components/jira/pages): its draft, and how to create from it. */
  loadDraft?: (() => Promise<JiraDraft>) | null;
  submit?: ((fields: JiraCreateFields) => Promise<JiraCreated>) | null;
  title?: string;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [draft, setDraft] = useState<JiraDraft | null>(null);
  const [f, setF] = useState<JiraCreateFields | null>(null);
  const [types, setTypes] = useState<JiraOption[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !item) return;
    let gone = false;
    setPhase({ kind: "loading" });
    setDraft(null);
    (loadDraft ? loadDraft() : jiraDraft(item)).then((d) => {
      if (gone) return;
      setDraft(d);
      setF(fieldsOf(d.draft));
      setTypes(d.meta.issue_types);
      setPhase({ kind: "ready" });
    }).catch((e) => {
      if (gone) return;
      const c = needsConnect(e);
      setPhase(c ? { kind: "connect", message: c } : { kind: "error", message: e instanceof Error ? e.message : "Couldn't draft the issue." });
    });
    return () => { gone = true; };
  }, [open, item]); // eslint-disable-line react-hooks/exhaustive-deps

  async function changeProject(p: string) {
    if (!f) return;
    setF({ ...f, project: p });
    if (!workspaceId) return;
    try {
      const r = await jiraIssueTypes(workspaceId, p);
      setTypes(r.issue_types);
      if (!r.issue_types.some((t) => t.name === f.issue_type)) setF((x) => x && { ...x, project: p, issue_type: r.issue_types.find((t) => t.name === "Task")?.name ?? r.issue_types[0]?.name ?? "Task" });
    } catch { /* keep the list */ }
  }

  async function create() {
    if (!item || !f) return;
    setBusy(true);
    try {
      const fields = { ...f, labels: (f.labels ?? []).filter(Boolean) };
      const out = submit ? await submit(fields) : await jiraCreate(item, fields);
      toast.success(<>Created <a href={out.url} target="_blank" rel="noreferrer" className="font-semibold underline">{out.key}</a> in Jira.</>);
      onCreated?.(out);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Jira didn't create it.");
    } finally { setBusy(false); }
  }

  const ready = phase.kind === "ready" && draft && f;
  return (
    <Dialog open={open} onClose={onClose} size="lg" glyph={<JiraMark />} dismissible={!busy}
      title={title}
      description={ready ? <>From {draft.source.kind_label.toLowerCase()} · {draft.meta.site.name}</> : undefined}
      footer={ready ? (
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void create()} loading={busy} disabled={!f.summary.trim() || !f.project} data-testid="jira-create">Create issue</Button>
        </>
      ) : phase.kind === "connect" ? (
        <>
          <Button variant="secondary" onClick={onClose}>Not now</Button>
          <Button iconLeft="link" onClick={() => void connectMyJira()} data-testid="jira-dialog-connect">Connect my Atlassian account</Button>
        </>
      ) : <Button variant="secondary" onClick={onClose}>Close</Button>}>
      {phase.kind === "loading" && <div className="flex justify-center py-6"><MarkdropLoader label="Drafting the issue…" size="sm" /></div>}
      {phase.kind === "connect" && (
        <p className="text-body text-text-secondary" data-testid="jira-dialog-needs-connect">
          Markdrop creates issues as you, with your own Atlassian account, so Jira&apos;s permissions apply and you&apos;re the reporter.
          Connect it once; you come back here.
        </p>
      )}
      {phase.kind === "error" && <Alert tone="danger">{phase.message}</Alert>}
      {ready && (
        <div className="flex min-w-0 flex-col gap-4" data-testid="jira-dialog">
          <blockquote className="jr-quote">{draft.source.text}</blockquote>
          <p className="jr-back -mt-2">Markdrop adds this quote and “{draft.meta.backlink}” as a link back{draft.source.moment ? " to that moment" : ""}.</p>
          {draft.notice && <div data-testid="jira-restricted"><Alert tone="warning">{draft.notice}</Alert></div>}
          {draft.note && <Alert tone="info">{draft.note}</Alert>}
          {draft.ai && <p className="text-caption text-text-muted">Drafted by Markdrop AI. Check every field before you create it.</p>}
          <Field label="Summary" hint={`${f.summary.length}/255`}>
            <Input value={f.summary} maxLength={255} onChange={(e) => setF({ ...f, summary: e.target.value })} data-testid="jira-summary" />
          </Field>
          <Field label="Description">
            <Textarea rows={4} value={f.description ?? ""} onChange={(e) => setF({ ...f, description: e.target.value })} data-testid="jira-description" />
          </Field>
          <div className="jr-grid">
            <Field label="Project">
              <Select value={f.project} onChange={(e) => void changeProject(e.target.value)} data-testid="jira-project"
                options={draft.meta.projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }))} />
            </Field>
            <Field label="Issue type">
              <Select value={f.issue_type ?? ""} onChange={(e) => setF({ ...f, issue_type: e.target.value })} data-testid="jira-type"
                options={types.map((t) => ({ value: t.name, label: t.name }))} />
            </Field>
            <Field label="Priority">
              <Select value={f.priority ?? ""} onChange={(e) => setF({ ...f, priority: e.target.value || null })} data-testid="jira-priority"
                options={[{ value: "", label: "Project default" }, ...draft.meta.priorities.map((p) => ({ value: p.name, label: p.name }))]} />
            </Field>
            <Field label="Assignee">
              <Select value={f.assignee_user_id ?? ""} onChange={(e) => setF({ ...f, assignee_user_id: e.target.value || null })} data-testid="jira-assignee"
                options={[{ value: "", label: "Unassigned" }, ...draft.meta.people.map((p) => ({ value: p.user_id, label: p.name }))]} />
            </Field>
            <Field label="Due date">
              <Input type="date" value={f.due ?? ""} onChange={(e) => setF({ ...f, due: e.target.value || null })} data-testid="jira-due" />
            </Field>
            <Field label="Labels" hint="Comma separated">
              <Input value={(f.labels ?? []).join(", ")} onChange={(e) => setF({ ...f, labels: e.target.value.split(",").map((x) => x.trim()) })} data-testid="jira-labels" />
            </Field>
          </div>
          {draft.meta.people.length === 0 && <p className="text-caption text-text-muted">Only members Markdrop matched to a Jira account can be assigned.</p>}
        </div>
      )}
    </Dialog>
  );
}

/** "Draft issues for all action items": every open action item without an issue, drafted in one go; pick and create. */
export function BulkIssuesDialog({ open, slug, onClose, onDone }: { open: boolean; slug: string; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [items, setItems] = useState<Array<{ d: JiraDraft; on: boolean; summary: string }>>([]);
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState(0);

  useEffect(() => {
    if (!open) return;
    let gone = false;
    setPhase({ kind: "loading" });
    jiraDraftAll(slug).then((r) => {
      if (gone) return;
      setItems(r.items.map((d) => ({ d, on: true, summary: d.draft.summary })));
      setProjects(r.meta.projects);
      setProject(r.items[0]?.draft.project ?? r.meta.projects[0]?.key ?? "");
      setSkipped(r.skipped);
      setPhase({ kind: "ready" });
    }).catch((e) => {
      if (gone) return;
      const c = needsConnect(e);
      setPhase(c ? { kind: "connect", message: c } : { kind: "error", message: e instanceof Error ? e.message : "Couldn't draft the issues." });
    });
    return () => { gone = true; };
  }, [open, slug]);

  const chosen = items.filter((x) => x.on && x.summary.trim());
  async function createAll() {
    setBusy(true);
    try {
      const out = await jiraCreateBulk(slug, chosen.map((x) => ({
        block: x.d.source.block!, fields: { ...fieldsOf(x.d.draft), project, summary: x.summary.trim() },
      })));
      const failed = out.results.filter((r) => !r.ok);
      if (out.created) toast.success(`Created ${out.created} Jira ${out.created === 1 ? "issue" : "issues"}.`);
      if (failed.length) toast.error(`${failed.length} not created: ${failed[0].detail ?? "Jira refused it."}`);
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Jira didn't create them.");
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} size="lg" glyph={<JiraMark />} dismissible={!busy} title="Draft Jira issues for action items"
      footer={phase.kind === "ready" && items.length ? (
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void createAll()} loading={busy} disabled={!chosen.length || !project} data-testid="jira-bulk-create">
            Create {chosen.length} {chosen.length === 1 ? "issue" : "issues"}
          </Button>
        </>
      ) : phase.kind === "connect" ? (
        <>
          <Button variant="secondary" onClick={onClose}>Not now</Button>
          <Button iconLeft="link" onClick={() => void connectMyJira()}>Connect my Atlassian account</Button>
        </>
      ) : <Button variant="secondary" onClick={onClose}>Close</Button>}>
      {phase.kind === "loading" && <div className="flex justify-center py-6"><MarkdropLoader label="Drafting issues…" size="sm" /></div>}
      {phase.kind === "connect" && <p className="text-body text-text-secondary">{phase.message}</p>}
      {phase.kind === "error" && <Alert tone="danger">{phase.message}</Alert>}
      {phase.kind === "ready" && (items.length === 0 ? (
        <p className="text-body text-text-secondary">No open action items without an issue{skipped ? ` (${skipped} already have one)` : ""}.</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3" data-testid="jira-bulk">
          {items[0]?.d.notice && <Alert tone="warning">{items[0].d.notice}</Alert>}
          {items[0]?.d.note && <Alert tone="info">{items[0].d.note}</Alert>}
          <div className="max-w-[320px]">
            <Field label="Project">
              <Select value={project} onChange={(e) => setProject(e.target.value)} options={projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }))} />
            </Field>
          </div>
          <ul className="jr-bulk">
            {items.map((x, i) => (
              <li key={x.d.source.block ?? i} className="jr-bulk__item" data-testid="jira-bulk-item">
                <Checkbox aria-label="Create this one" checked={x.on} onChange={(e) => setItems((xs) => xs.map((y, j) => j === i ? { ...y, on: e.target.checked } : y))} />
                <Input value={x.summary} maxLength={255} aria-label="Summary"
                  onChange={(e) => setItems((xs) => xs.map((y, j) => j === i ? { ...y, summary: e.target.value } : y))} />
                <span className="jr-bulk__meta">
                  {[x.d.draft.assignee?.name ?? "Unassigned", x.d.draft.due && `due ${x.d.draft.due}`, x.d.draft.priority].filter(Boolean).join(" · ")}
                  {" — "}“{x.d.source.text.slice(0, 120)}”
                </span>
              </li>
            ))}
          </ul>
          <p className="text-caption text-text-muted">Each issue is created as you and linked to its action item; ticking one later moves its issue to Done.</p>
        </div>
      ))}
    </Dialog>
  );
}
