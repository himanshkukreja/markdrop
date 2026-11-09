"use client";

/**
 * Jira in the page editor (docs-editor node views; registered in views/pageItems.tsx MentionView and
 * views/media.tsx LeafView, the "/" items in blocks.ts, pasted links in menus/PasteMenu.tsx):
 *
 *   :jira[KEY]{site}          JiraMentionNode   an inline chip; empty → the issue picker opens
 *   ::jira{key site}          JiraLeafNode      the card; empty → the picker
 *   ::jira-list{…}            JiraLeafNode      the list, with its form (project / saved filter / JQL,
 *                                               columns, how many) and a live preview as the editor
 *
 * The page's host gives `pages.jiraPages` (useJiraEditorHost, PageEditor): the store (the same one
 * readers use) and "Create issue" (the AI draft + review dialog). Without it (Guides, signed out) the
 * nodes still show their key and keep their Markdown.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Button, Checkbox, Dialog, Field, Icon, IconButton, Input, SegmentedControl, Spinner, Tooltip } from "@/components/ui";
import { useHost } from "@/components/docs-editor/host";
import type { JiraCreated, JiraItemRef } from "@/lib/jira";
import {
  DEFAULT_COLS, JIRA_COLS, hostOf, jiraSearch, normKey, parseJiraUrl, specOf,
  type JiraCol, type JiraIssue, type JiraListSpec,
} from "@/lib/jiraPages";
import { ChipFace, ConnectJira, JiraCard, JiraInline, JiraList } from "./JiraBlocks";
import { useJiraPagesStore, useJiraState, type JiraPagesStore } from "./store";
import "./jiraPages.css";

const CreateIssueDialog = dynamic(() => import("../CreateIssueDialog").then((m) => m.CreateIssueDialog), { ssr: false, loading: () => null });

/** What a page's editor gives its Jira nodes (PagesEditorHost.jiraPages). */
export interface JiraEditorHost {
  store: JiraPagesStore;
  slug: string;
  /** "Create issue" from some text: the AI draft + review dialog; the new issue's key, or null. */
  create(text: string): Promise<{ key: string; site: string | null } | null>;
}

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

function useJiraHost(): JiraEditorHost | null {
  return (useHost().pages as { jiraPages?: JiraEditorHost | null } | undefined)?.jiraPages ?? null;
}

/**
 * The editor's Jira host and its dialog (PageEditor): the page's store (live over the page's socket)
 * and a promise-shaped "Create issue". `enabled`: a signed-in editor on markdrop.in.
 */
export function useJiraEditorHost({ slug, userId, subscribeLive, enabled, workspaceId }: {
  slug: string; userId: string | null; subscribeLive?: ((fn: (msg: Record<string, unknown>) => void) => () => void) | null; enabled: boolean; workspaceId: string | null;
}): { host: JiraEditorHost | null; dialog: ReactNode } {
  const store = useJiraPagesStore(slug, userId, subscribeLive, enabled);
  const [ask, setAsk] = useState<{ item: JiraItemRef; done: (r: { key: string; site: string | null } | null) => void } | null>(null);
  const host = useMemo<JiraEditorHost | null>(() => (store ? {
    store, slug,
    create: (text: string) => new Promise((done) => setAsk({ item: { slug, selection: text.slice(0, 4000) }, done })),
  } : null), [store, slug]);
  const dialog = ask ? (
    <CreateIssueDialog open item={ask.item} workspaceId={workspaceId}
      onClose={() => { ask.done(null); setAsk(null); }}
      onCreated={(c: JiraCreated) => { ask.done({ key: c.key, site: hostOf(c.url) }); setAsk(null); }} />
  ) : null;
  return { host, dialog };
}

/* ── The issue picker ────────────────────────────────────────────────────── */

export function JiraIssuePicker({ open, onClose, onPick, jira, title = "Add a Jira issue", startCreate = false }: {
  open: boolean; onClose: () => void; onPick: (key: string, site: string | null) => void; jira: JiraEditorHost | null; title?: string; startCreate?: boolean;
}) {
  const state = useJiraState(jira?.store ?? null);
  const site = jira?.store.siteFor(null) ?? null;
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<JiraIssue[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const listId = useId();
  const [creating, setCreating] = useState(false);
  const typed = parseJiraUrl(q.trim());
  const typedKey = typed?.key ?? (/^[A-Za-z][A-Za-z0-9_]{0,19}-\d+$/.test(q.trim()) ? normKey(q) : null);

  useEffect(() => {
    if (!open || !site || !state.connected) { setRows(null); return; }
    let gone = false;
    const t = window.setTimeout(() => {
      jiraSearch(site, q).then((r) => { if (!gone) { setRows(r.issues); setIndex(0); setErr(null); } })
        .catch((e) => !gone && setErr(e instanceof Error ? e.message : "Couldn't search Jira."));
    }, q ? 250 : 0);
    return () => { gone = true; window.clearTimeout(t); };
  }, [open, site, q, state.connected]);

  // The create dialog takes over (this one hides meanwhile); its issue is the pick, else this closes.
  const create = useCallback(async (text: string) => {
    if (!jira || creating) return;
    setCreating(true);
    const r = await jira.create(text);
    setCreating(false);
    if (r) onPick(r.key, r.site);
    else onClose();
  }, [jira, onPick, onClose, creating]);

  const options = rows ?? [];
  const choose = (i: number) => {
    const it = options[i];
    if (it) onPick(it.key, site);
    else if (typedKey) onPick(typedKey, typed?.site ?? site);
  };
  return (
    <Dialog open={open && !creating} onClose={onClose} size="md" title={startCreate ? "Create a Jira issue" : title}
      description={startCreate ? "Say what it's about: Markdrop drafts the issue for you to review, then it's created as you."
        : state.connected ? "Search your Jira, or paste an issue's key or link." : "Paste an issue's key or link."}>
      <div className="jp-pick" data-testid="jira-picker">
        <Input autoFocus prefix="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="PAY-123, a link, or words from the title"
          aria-label="Find a Jira issue" aria-controls={listId} aria-autocomplete="list"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, Math.max(0, options.length - 1))); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(options.length ? index : -1); }
          }} />
        {!state.signed_in ? null : !state.connected ? (
          <div className="jp-card__note"><span>Connect your Atlassian account to search your issues.</span><ConnectJira broken={state.broken} /></div>
        ) : err ? <p className="jp-err" role="alert">{err}</p> : rows === null ? (
          <p className="jp-muted"><Spinner size={14} /> Searching…</p>
        ) : null}
        <ul id={listId} role="listbox" aria-label="Jira issues">
          {options.map((it, i) => (
            <li key={it.key} role="option" aria-selected={i === index}>
              <button type="button" className="jp-pick__row" aria-selected={i === index} data-testid="jira-pick-row" onMouseEnter={() => setIndex(i)} onClick={() => choose(i)}>
                <span className="jp-chip__key">{it.key}</span>
                <span className="jp-ellipsis">{it.summary}</span>
                <span className={`jr-status jr-status--${it.status.category}`}>{it.status.name}</span>
              </button>
            </li>
          ))}
          {!options.length && typedKey && (
            <li role="option" aria-selected>
              <button type="button" className="jp-pick__row" aria-selected data-testid="jira-pick-typed" onClick={() => choose(-1)}>
                <span className="jp-chip__key">{typedKey}</span><span className="jp-ellipsis jp-muted">Add {typedKey}{typed?.site ? ` from ${typed.site}` : ""}</span>
              </button>
            </li>
          )}
          {rows && !rows.length && !typedKey && q && <li className="jp-muted">Nothing matches.</li>}
        </ul>
        {jira && state.connected && (
          <div>
            <Button size="sm" variant={startCreate ? "primary" : "secondary"} iconLeft="plus" disabled={!q.trim() || !!typedKey}
              onClick={() => void create(q.trim())} data-testid="jira-pick-create">
              {q.trim() && !typedKey ? `Create “${q.trim().slice(0, 40)}”` : "Create a new issue (type what it's about)"}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** After a picker dialog: the editor gets focus back (the dialog gave it to the page itself), once it has gone. */
function refocus(editor: ReactNodeViewProps["editor"], tries = 8) {
  window.setTimeout(() => {
    if (editor.isDestroyed || editor.view.hasFocus()) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      if (tries > 0) refocus(editor, tries - 1);
      return;
    }
    editor.commands.focus();
  }, 200);
}

/* ── The inline chip ─────────────────────────────────────────────────────── */

export function JiraMentionNode({ node, updateAttributes, deleteNode, selected, editor, getPos }: ReactNodeViewProps) {
  const host = useHost();
  const jira = useJiraHost();
  const key = normKey(String(node.attrs.label ?? "")) ?? null;
  const a = (node.attrs.attributes ?? {}) as Record<string, string>;
  const site = hostOf(a.site);
  const create = a.create === "1";
  const [picking, setPicking] = useState(!key && !host.readOnly);
  const asCard = () => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    const leaf = editor.schema.nodes.directiveLeaf;
    if (typeof pos !== "number" || !leaf || !key) return;
    // A block in place of the chip: after the paragraph it's in (or in its place when it's alone).
    const $p = editor.state.doc.resolve(pos);
    const para = $p.parent;
    const card = leaf.create({ name: "jira", attributes: { key, ...(site ? { site } : {}) } });
    const tr = editor.state.tr;
    if (para.childCount === 1 && para.isTextblock) tr.replaceWith($p.before(), $p.after(), card);
    else { tr.delete(pos, pos + node.nodeSize); tr.insert(tr.mapping.map($p.after()), card); }
    editor.view.dispatch(tr.scrollIntoView());
  };
  return (
    <NodeViewWrapper as="span" className={cx("dxe-mention-wrap", selected && "dxe-selected")} contentEditable={false}>
      {key ? (
        <span className="jp-inline-edit">
          <JiraInline store={jira?.store ?? null} site={site} issueKey={key} slug={jira?.slug ?? null} editing />
          {selected && !host.readOnly && (
            <Tooltip content="Show as a card">
              <IconButton icon="cards" label="Show as a card" size="sm" onClick={asCard} data-testid="jira-as-card" />
            </Tooltip>
          )}
        </span>
      ) : (
        <button type="button" className="jp-pending" onClick={() => setPicking(true)} disabled={host.readOnly} data-testid="jira-pending">
          <Icon name="checkSquare" size={12} /> Choose a Jira issue…
        </button>
      )}
      <JiraIssuePicker open={picking} jira={jira} startCreate={create && !key}
        onClose={() => { setPicking(false); if (!key) window.setTimeout(() => { if (!normKey(String(node.attrs.label ?? ""))) deleteNode(); }, 0); }}
        onPick={(k, s) => {
          setPicking(false);
          const def = jira?.store.state.default_site ?? null;
          updateAttributes({ label: k, attributes: s && s !== def ? { site: s } : {} });
          void jira?.store.ensure(s, k);
          refocus(editor);
        }} />
    </NodeViewWrapper>
  );
}

/* ── Cards and lists ─────────────────────────────────────────────────────── */

export function JiraLeafNode(props: ReactNodeViewProps) {
  return String(props.node.attrs.name) === "jira-list" ? <ListNode {...props} /> : <CardNode {...props} />;
}

function CardNode({ node, updateAttributes, deleteNode, selected, editor }: ReactNodeViewProps) {
  const host = useHost();
  const jira = useJiraHost();
  const a = (node.attrs.attributes ?? {}) as Record<string, string>;
  const key = normKey(a.key || String(node.attrs.label ?? "")) ?? null;
  const site = hostOf(a.site);
  const [picking, setPicking] = useState(!key && !host.readOnly);
  const bar = !host.readOnly ? (
    <div className="jp-edit" contentEditable={false}>
      <Icon name="checkSquare" size={12} /> Jira issue
      <span className="jp-edit__spacer" />
      <Button size="sm" variant="ghost" onClick={() => setPicking(true)} data-testid="jira-card-change">Change</Button>
      <IconButton icon="trash" label="Remove the Jira card" size="sm" onClick={() => deleteNode()} />
    </div>
  ) : null;
  return (
    <NodeViewWrapper className={cx("dxe-block", selected && "dxe-selected")} data-drag-handle="">
      <div contentEditable={false}>
        {key ? (
          <JiraCard store={jira?.store ?? null} site={site} issueKey={key} slug={jira?.slug ?? null} editing extra={bar} />
        ) : (
          <div className="jp-card not-prose">{bar}<div className="jp-empty"><Icon name="checkSquare" size={16} /> Choose the Jira issue this card shows. <Button size="sm" onClick={() => setPicking(true)}>Choose</Button></div></div>
        )}
      </div>
      <JiraIssuePicker open={picking} jira={jira} title={key ? "Show another Jira issue" : "Add a Jira card"}
        onClose={() => { setPicking(false); if (!key) window.setTimeout(() => { const n = (node.attrs.attributes ?? {}) as Record<string, string>; if (!n.key) deleteNode(); }, 0); }}
        onPick={(k, s) => {
          setPicking(false);
          const def = jira?.store.state.default_site ?? null;
          updateAttributes({ label: null, attributes: { key: k, ...(s && s !== def ? { site: s } : {}) } });
          void jira?.store.ensure(s, k);
          refocus(editor);
        }} />
    </NodeViewWrapper>
  );
}

type Source = "project" | "filter" | "jql";

function ListNode({ node, updateAttributes, deleteNode, selected }: ReactNodeViewProps) {
  const host = useHost();
  const jira = useJiraHost();
  const a = (node.attrs.attributes ?? {}) as Record<string, string>;
  const spec = useMemo(() => specOf(a), [JSON.stringify(a)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState(!spec && !host.readOnly);
  const bar = !host.readOnly ? (
    <div className="jp-edit" contentEditable={false}>
      <Icon name="list" size={12} /> Jira list · each reader sees it through their own Jira
      <span className="jp-edit__spacer" />
      <Button size="sm" variant="ghost" onClick={() => setEditing((x) => !x)} data-testid="jira-list-edit">{editing ? "Done" : "Edit list"}</Button>
      <IconButton icon="trash" label="Remove the Jira list" size="sm" onClick={() => deleteNode()} />
    </div>
  ) : null;
  return (
    <NodeViewWrapper className={cx("dxe-block", selected && "dxe-selected")} data-drag-handle="">
      <div contentEditable={false}>
        {editing || !spec ? (
          <div className="jp-list not-prose">
            {bar}
            <ListForm initial={a} onSave={(next) => { updateAttributes({ attributes: next }); setEditing(false); }} />
            {spec && <JiraList store={jira?.store ?? null} spec={spec} slug={jira?.slug ?? null} />}
          </div>
        ) : (
          <JiraList store={jira?.store ?? null} spec={spec} slug={jira?.slug ?? null} extra={bar} />
        )}
      </div>
    </NodeViewWrapper>
  );
}

function ListForm({ initial, onSave }: { initial: Record<string, string>; onSave: (attrs: Record<string, string>) => void }) {
  const [source, setSource] = useState<Source>(initial.jql ? "jql" : initial.filter ? "filter" : "project");
  const [value, setValue] = useState(initial.jql || initial.filter || initial.project || "");
  const [title, setTitle] = useState(initial.title ?? "");
  const [cols, setCols] = useState<JiraCol[]>(() => {
    const c = (initial.cols ?? "").split(",").filter((x): x is JiraCol => JIRA_COLS.some((y) => y.id === x));
    return c.length ? c : DEFAULT_COLS;
  });
  const [limit, setLimit] = useState(initial.limit ?? "");
  const id = useId();
  const v = value.trim();
  const valid = source === "jql" ? v.length > 0 && v.length <= 1500 : source === "project" ? /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(v) : /^\d{1,12}$/.test(v);
  const save = () => {
    if (!valid) return;
    const out: Record<string, string> = {};
    if (source === "jql") out.jql = v.replace(/\s+/g, " ");
    else if (source === "project") out.project = v.toUpperCase();
    else out.filter = v;
    if (initial.site) out.site = initial.site;
    if (cols.join(",") !== DEFAULT_COLS.join(",")) out.cols = cols.join(",");
    const n = Number(limit);
    if (n && n !== 25) out.limit = String(Math.max(1, Math.min(100, Math.round(n))));
    if (title.trim()) out.title = title.trim().slice(0, 120);
    onSave(out);
  };
  return (
    <form className="jp-listform" onSubmit={(e) => { e.preventDefault(); save(); }} data-testid="jira-list-form">
      <SegmentedControl<Source> size="sm" value={source} onChange={setSource} aria-label="Issues from"
        options={[{ value: "project", label: "Project" }, { value: "filter", label: "Saved filter" }, { value: "jql", label: "JQL" }]} />
      <div className="jp-listform__row">
        <Field label={source === "project" ? "Project key" : source === "filter" ? "Filter id" : "JQL"} htmlFor={`${id}-v`}
          hint={source === "jql" ? "Runs as each reader: nobody sees an issue their own Jira hides." : undefined}>
          <Input id={`${id}-v`} value={value} onChange={(e) => setValue(e.target.value)} autoFocus mono={source === "jql"}
            placeholder={source === "project" ? "PAY" : source === "filter" ? "10042" : 'project = PAY AND status != Done ORDER BY priority DESC'} data-testid="jira-list-value" />
        </Field>
        <Field label="Title" htmlFor={`${id}-t`}><Input id={`${id}-t`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Jira issues" maxLength={120} /></Field>
        <Field label="Per page" htmlFor={`${id}-l`}><Input id={`${id}-l`} type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="25" /></Field>
      </div>
      <fieldset className="jp-cols" aria-label="Columns">
        {JIRA_COLS.map((c) => (
          <Checkbox key={c.id} label={c.label} checked={cols.includes(c.id)}
            onChange={(e) => setCols((x) => (e.target.checked ? JIRA_COLS.map((y) => y.id).filter((y) => y === c.id || x.includes(y)) : x.filter((y) => y !== c.id)))} />
        ))}
      </fieldset>
      <div className="jp-form__end"><Button size="sm" type="submit" disabled={!valid} data-testid="jira-list-save">Show issues</Button></div>
    </form>
  );
}

/** The chip's face for a drag preview or a read-only list (no store). */
export function StaticChip({ issueKey }: { issueKey: string }) {
  return <span className="jp-chip"><ChipFace issueKey={issueKey} title={null} issue={null} /></span>;
}

export type { JiraListSpec };
