"use client";

/**
 * The "/jira …" commands (docs-editor/blocks.ts JIRA_ITEMS) for a page's or a Markdown document's editor.
 *
 * Offered to every signed-in editor. Someone who can't use Jira here yet gets the way to it instead:
 *   connect   not connected (or the connection broke): "Connect Jira", back to this page in Edit, and the
 *             command goes in where it was typed (?jira_add=<action>~<pos>)
 *   site      the page's workspace has no Jira site: who sets one up, and where
 *   tenant    on a workspace's own domain (Jira changes stay on markdrop.in): the same page there, in Edit,
 *             and the command goes in there
 * Then: a chip or card (the picker opens in the node), a list (its form), a preset (blocks.ts JIRA_PRESETS:
 * a ::jira-list with a JQL, editable afterwards; sprint/bugs/recent ask for the project, epic for the epic),
 * a new issue (drafted, reviewed, created as you) and "from text" (the line becomes a new issue's chip).
 * In a Markdown document (mode "doc") issues go in as links: "KEY · title".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Editor, Range } from "@tiptap/core";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Button, Dialog, Field, Input, Select } from "@/components/ui";
import { JIRA_PRESETS, JIRA_PROJECT_RX, type JiraAction, type JiraPresetAttrs, type JiraSlash } from "@/components/docs-editor/blocks";
import { PRIMARY_HOST } from "@/lib/hosts";
import { browseUrl, jiraIssue, linkText, normKey } from "@/lib/jiraPages";
import type { JiraEditorHost } from "./editor";
import { JiraIssuePicker } from "./editor";

type Why = "connect" | "broken" | "site" | "tenant" | "off";
type ProjectAction = "sprint" | "bugs" | "recent";

/** A position that follows the document's edits while a dialog is open. */
interface Spot { pos: number; stop: () => void }
function spot(editor: Editor, pos: number): Spot {
  const box = { pos, stop: () => editor.off("transaction", on) };
  function on({ transaction }: { transaction: Transaction }) {
    box.pos = transaction.mapping.map(box.pos, -1);
  }
  editor.on("transaction", on);
  return box;
}

/** The line a "from text" command takes: its text and where it is, else the block above's text. */
interface Line { text: string; from: Spot | null; to: Spot | null }

type Ask =
  | { kind: "gate"; why: Why; action: JiraAction; editor: Editor; at: Spot }
  | { kind: "project"; action: ProjectAction; editor: Editor; at: Spot }
  | { kind: "pick"; action: "epic" | "issue" | "create"; editor: Editor; at: Spot };

const WHAT: Record<JiraAction, string> = {
  issue: "a Jira issue", card: "a Jira card", list: "a Jira list", mine: "your Jira issues", sprint: "a sprint's issues",
  bugs: "a project's open bugs", recent: "recently updated issues", epic: "an epic and its issues", create: "a new Jira issue",
  "from-text": "a new Jira issue",
};
const ACTIONS = Object.keys(WHAT) as JiraAction[];

/** "?jira_add=<action>~<pos>" (after connecting, or on markdrop.in): what to put in once the editor is back. */
export function readJiraAdd(v: string | null): { action: JiraAction; pos: number | null } | null {
  const m = /^([a-z-]+)(?:~(\d{1,7}))?$/.exec(v ?? "");
  if (!m || !ACTIONS.includes(m[1] as JiraAction)) return null;
  return { action: m[1] as JiraAction, pos: m[2] ? Number(m[2]) : null };
}

/** `base` (a path) opening in Edit, with the command to put in (none: just Edit). */
function hrefWithAdd(base: string, action: JiraAction | null, pos: number): string {
  const u = new URL(base, "https://x.invalid");
  u.searchParams.set("edit", "1");
  if (action) u.searchParams.set("jira_add", `${action}~${pos}`);
  else u.searchParams.delete("jira_add");
  u.searchParams.delete("jira");
  return `${u.pathname}${u.search}`;
}

export function useJiraSlash({ mode, slug, workspaceId, tenant, jira, editor, flush, ready = true }: {
  mode: "page" | "doc";
  slug: string;
  workspaceId: string | null;
  /** On a workspace's own domain. */
  tenant: boolean;
  /** The editor's Jira (its store and "Create issue"); null on a workspace's own domain. */
  jira: JiraEditorHost | null;
  /** The editor, for a command to put in after coming back (?jira_add). */
  editor?: Editor | null;
  /** Saves what's pending before leaving the page. */
  flush?: (() => Promise<unknown>) | null;
  /** The editor can be changed (a command waiting from ?jira_add goes in only then). */
  ready?: boolean;
}): { slash: JiraSlash; dialog: ReactNode } {
  const [ask, setAsk] = useState<Ask | null>(null);
  const jiraRef = useRef(jira);
  jiraRef.current = jira;

  /** Why this command can't run here yet (null: it can); "wait" until the page's Jira has loaded. */
  const whyNow = useCallback((action: JiraAction): Why | null | "wait" => {
    if (tenant) return "tenant";
    const store = jiraRef.current?.store;
    if (!store) return "off";
    if (!store.loaded) return "wait";
    const st = store.state;
    if (!st.configured) return "off";
    if (st.broken) return "broken";
    if (!st.connected) return "connect";
    // A new issue goes to the page's workspace's site; the rest need a site to search or list.
    const needsWorkspace = action === "create" || action === "from-text";
    if (needsWorkspace ? !st.default_site : !store.siteFor(null)) return "site";
    return null;
  }, [tenant]);

  const why = useCallback(async (action: JiraAction): Promise<Why | null> => {
    const w = whyNow(action);
    if (w !== "wait") return w;
    await jiraRef.current?.store.load();
    const again = whyNow(action);
    return again === "wait" ? "off" : again;
  }, [whyNow]);

  /** Puts content in at a spot (a block where a whole empty line was: in its place). */
  const put = useCallback((editor: Editor, at: Spot, content: object | object[]) => {
    at.stop();
    if (editor.isDestroyed) return;
    const sel = caretAt(editor.state.doc, at.pos, false);
    editor.chain().focus().command(({ tr }) => { tr.setSelection(sel); return true; }).insertContent(content).run();
  }, []);

  const putLink = useCallback(async (editor: Editor, at: Spot | null, key: string, site: string | null, range?: { from: Spot; to: Spot; text: string } | null) => {
    const s = site ?? jiraRef.current?.store.siteFor(null) ?? null;
    let title: string | null = null;
    if (s) {
      try { title = (await jiraIssue(s, key)).issue.summary ?? null; } catch { /* the key alone */ }
    }
    const node = s ? { type: "text", text: linkText(key, title), marks: [{ type: "link", attrs: { href: browseUrl(s, key) } }] } : { type: "text", text: key };
    replaceOrPut(editor, at, range, [node, { type: "text", text: " " }]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const putChip = useCallback((editor: Editor, at: Spot | null, key: string, site: string | null, range?: { from: Spot; to: Spot; text: string } | null) => {
    const def = jiraRef.current?.store.state.default_site ?? null;
    replaceOrPut(editor, at, range, [{ type: "mention", attrs: { name: "jira", label: key, attributes: site && site !== def ? { site } : {} } }, { type: "text", text: " " }]);
    void jiraRef.current?.store.ensure(site, key);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** In place of the line's text when it's still what it was; else where the command was typed. */
  function replaceOrPut(editor: Editor, at: Spot | null, range: { from: Spot; to: Spot; text: string } | null | undefined, content: object[]) {
    if (range) {
      range.from.stop();
      range.to.stop();
      const same = !editor.isDestroyed && range.to.pos > range.from.pos && clean(editor.state.doc.textBetween(range.from.pos, range.to.pos, " ", " ")) === range.text;
      if (same) {
        at?.stop();
        // The line's text becomes the chip (no space after it: nothing follows on that line).
        const bare = content.filter((c) => !((c as { type?: string; text?: string }).type === "text" && (c as { text?: string }).text === " "));
        editor.chain().focus().insertContentAt({ from: range.from.pos, to: range.to.pos }, bare).run();
        return;
      }
    }
    if (at) put(editor, at, content);
  }

  const leaf = (name: string, attributes: Record<string, string>) => ({ type: "directiveLeaf", attrs: { name, attributes } });
  const listOf = (p: JiraPresetAttrs) => leaf("jira-list", listAttrs(p));

  /** The command itself, once Jira is there. */
  const go = useCallback(async (editor: Editor, action: JiraAction, at: Spot, line: Line | null) => {
    const j = jiraRef.current;
    if (action === "from-text") {
      if (!line?.text || !j) return setAsk({ kind: "pick", action: "create", editor, at });
      const r = await j.create(line.text.slice(0, 4000));
      const range = line.from && line.to ? { from: line.from, to: line.to, text: line.text } : null;
      if (!r) { at.stop(); range?.from.stop(); range?.to.stop(); return; }
      if (mode === "doc") return void putLink(editor, at, r.key, r.site, range);
      return putChip(editor, at, r.key, r.site, range);
    }
    if (mode === "doc") {
      if (action === "issue" || action === "create") return setAsk({ kind: "pick", action, editor, at });
      at.stop();
      return;
    }
    switch (action) {
      case "issue": return put(editor, at, [{ type: "mention", attrs: { name: "jira", label: "", attributes: {} } }, { type: "text", text: " " }]);
      case "create": return put(editor, at, [{ type: "mention", attrs: { name: "jira", label: "", attributes: { create: "1" } } }, { type: "text", text: " " }]);
      case "card": return put(editor, at, leaf("jira", {}));
      case "list": return put(editor, at, leaf("jira-list", {}));
      case "mine": return put(editor, at, listOf(JIRA_PRESETS.mine()));
      case "sprint": case "bugs": case "recent": return setAsk({ kind: "project", action, editor, at });
      case "epic": return setAsk({ kind: "pick", action: "epic", editor, at });
    }
  }, [mode, put, putChip, putLink]);

  const run = useCallback((editor: Editor, r: Range, action: JiraAction) => {
    const line = action === "from-text" ? lineAt(editor, r) : null;
    editor.chain().focus().deleteRange(r).run();
    const at = spot(editor, r.from);
    const fromLine = line && line.from !== null ? { text: line.text, from: spot(editor, line.from), to: spot(editor, line.to!) } : line ? { text: line.text, from: null, to: null } : null;
    void why(action).then((w) => {
      if (w) {
        fromLine?.from?.stop();
        fromLine?.to?.stop();
        return setAsk({ kind: "gate", why: w, action, editor, at });
      }
      return go(editor, action, at, fromLine);
    });
  }, [why, go]);

  const slash = useMemo<JiraSlash>(() => ({ mode, run }), [mode, run]);

  // Back after connecting (or here from a workspace's own domain): the command goes in where it was typed.
  const resumed = useRef(false);
  const state = jira?.store ? jira.store : null;
  const [loaded, setLoaded] = useState(!!state?.loaded);
  useEffect(() => {
    if (!state) return;
    setLoaded(state.loaded);
    const off = state.subscribe(() => setLoaded(state.loaded));
    return () => { off(); };
  }, [state]);
  useEffect(() => {
    if (resumed.current || !editor || editor.isDestroyed || !loaded || !ready || typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const add = readJiraAdd(q.get("jira_add"));
    if (!q.has("jira_add")) return;
    resumed.current = true;
    q.delete("jira_add");
    q.delete("jira");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
    if (!add || mode !== "page" || whyNow(add.action) !== null) return;
    // The page as saved may differ a little from the editor it was typed in (an empty line isn't kept):
    // the end of the line that position is in, never the middle of someone's sentence.
    window.setTimeout(() => {
      if (editor.isDestroyed) return;
      const pos = caretAt(editor.state.doc, add.pos ?? editor.state.doc.content.size, true).from;
      void go(editor, add.action, spot(editor, pos), null);
    }, 300);
  }, [editor, loaded, ready, mode, whyNow, go]);

  const close = useCallback(() => {
    setAsk((a) => {
      a?.at.stop();
      if (a) window.setTimeout(() => { if (!a.editor.isDestroyed) a.editor.commands.focus(); }, 0);
      return null;
    });
  }, []);

  let dialog: ReactNode = null;
  if (ask?.kind === "gate") {
    const a = ask;
    const onRetry = async () => {
      await jiraRef.current?.store.load();
      const w = whyNow(a.action);
      if (w === null) {
        setAsk(null);
        void go(a.editor, a.action, a.at, null);
      } else if (w !== "wait") setAsk({ ...a, why: w });
    };
    dialog = <GateDialog ask={ask} slug={slug} workspaceId={workspaceId} mode={mode} flush={flush} broken={ask.why === "broken"} onClose={close} onRetry={onRetry} />;
  } else if (ask?.kind === "project") {
    dialog = (
      <ProjectDialog action={ask.action} workspaceId={workspaceId} onClose={close}
        onPick={(p) => {
          const preset = JIRA_PRESETS[ask.action](p);
          const a = ask;
          setAsk(null);
          if (preset) put(a.editor, a.at, listOf(preset));
          else a.at.stop();
        }} />
    );
  } else if (ask?.kind === "pick") {
    const a = ask;
    dialog = (
      <JiraIssuePicker open jira={jira} startCreate={a.action === "create"}
        title={a.action === "epic" ? "Choose the epic" : "Add a Jira issue"}
        onClose={close}
        onPick={(key, site) => {
          setAsk(null);
          const k = normKey(key);
          if (!k) return a.at.stop();
          if (a.action === "epic") {
            const preset = JIRA_PRESETS.epic(k);
            const def = jiraRef.current?.store.state.default_site ?? null;
            const s: Record<string, string> = site && site !== def ? { site } : {};
            put(a.editor, a.at, [leaf("jira", { key: k, ...s }), ...(preset ? [leaf("jira-list", { ...listAttrs(preset), ...s })] : [])]);
            void jiraRef.current?.store.ensure(site, k);
          } else if (mode === "doc") {
            void putLink(a.editor, a.at, k, site);
          } else {
            putChip(a.editor, a.at, k, site);
          }
        }} />
    );
  }
  return { slash, dialog };
}

/** A caret at `pos` (clamped); not in text: the nearest text before it. `lineEnd`: the end of its line. */
function caretAt(doc: import("@tiptap/pm/model").Node, pos: number, lineEnd: boolean): Selection {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($p.parent.inlineContent) return TextSelection.create(doc, lineEnd ? $p.end() : $p.pos);
  return Selection.findFrom($p, -1, true) ?? Selection.findFrom($p, 1, true) ?? Selection.atEnd(doc);
}

const listAttrs = (p: JiraPresetAttrs): Record<string, string> => ({ jql: p.jql, title: p.title, ...(p.cols ? { cols: p.cols } : {}) });
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** "from text": the text of the line "/" was typed on (without the command), else the block above's. */
function lineAt(editor: Editor, r: Range): { text: string; from: number | null; to: number | null } {
  const { doc } = editor.state;
  const $f = doc.resolve(r.from);
  if ($f.parent.isTextblock) {
    const start = $f.start();
    const end = $f.end();
    const text = clean(`${doc.textBetween(start, r.from, " ", " ")} ${doc.textBetween(Math.min(r.to, end), end, " ", " ")}`);
    // Positions once "/…" is gone: the line's end moves back by the command's length.
    if (text) return { text, from: start, to: end - (r.to - r.from) };
    if ($f.depth >= 1) {
      const i = $f.index($f.depth - 1);
      const prev = i > 0 ? $f.node($f.depth - 1).child(i - 1) : null;
      const t = prev ? clean(prev.textContent) : "";
      if (t) return { text: t, from: null, to: null };
    }
  }
  return { text: "", from: null, to: null };
}

/* ── Not yet: the way to Jira ─────────────────────────────────────────────── */

function GateDialog({ ask, slug, workspaceId, mode, flush, broken, onClose, onRetry }: {
  ask: Extract<Ask, { kind: "gate" }>; slug: string; workspaceId: string | null; mode: "page" | "doc";
  flush?: (() => Promise<unknown>) | null; broken: boolean; onClose: () => void;
  /** A document (its edits aren't saved yet) connects in a new tab, then continues here. */
  onRetry: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retry = () => { setRetrying(true); void onRetry().finally(() => setRetrying(false)); };
  const what = WHAT[ask.action];
  const leave = async (to: () => void | Promise<void>) => {
    setBusy(true);
    try { await flush?.(); } catch { /* the page keeps its draft */ }
    try { await to(); } catch { setBusy(false); }
  };
  const here = typeof window !== "undefined" ? window.location.pathname + window.location.search : `/${slug}`;
  const back = hrefWithAdd(here, mode === "page" ? ask.action : null, ask.at.pos);

  if ((ask.why === "connect" || ask.why === "broken") && mode === "doc") {
    return (
      <Dialog open onClose={onClose} size="sm" title={broken ? "Reconnect Jira" : "Connect Jira"}
        description={`To add ${what}, connect your Atlassian account. It opens in a new tab, so nothing you've written here is lost.`}
        footer={<>
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          {opened
            ? <Button loading={retrying} onClick={retry} data-testid="jira-slash-continue">I&apos;ve connected: continue</Button>
            : <Button iconLeft="external" href="/settings/account#jira" target="_blank" rel="noopener" onClick={() => setOpened(true)} data-testid="jira-slash-connect">{broken ? "Reconnect Jira" : "Connect Jira"}</Button>}
        </>}>
        <p className="text-body-sm text-text-muted" data-testid="jira-slash-gate" data-why={ask.why}>Connect in Settings › Account › Jira, then come back here and continue.</p>
      </Dialog>
    );
  }
  if (ask.why === "connect" || ask.why === "broken") {
    return (
      <Dialog open onClose={onClose} size="sm" title={broken ? "Reconnect Jira" : "Connect Jira"}
        description={broken ? "Your Jira connection stopped working. Connect again to add Jira here." : `To add ${what}, connect your Atlassian account. Everything in Jira is done as you, with your own permissions.`}
        footer={<>
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button iconLeft="link" loading={busy} data-testid="jira-slash-connect"
            onClick={() => void leave(async () => {
              const { connectMyJira } = await import("@/lib/jira");
              await connectMyJira(back, workspaceId);
            })}>{broken ? "Reconnect Jira" : "Connect Jira"}</Button>
        </>}>
        <p className="text-body-sm text-text-muted" data-testid="jira-slash-gate" data-why={ask.why}>
          You come back to this page and it goes in where you typed it.
        </p>
      </Dialog>
    );
  }
  if (ask.why === "tenant") {
    const proto = /^(localhost|127\.)/.test(PRIMARY_HOST) ? "http" : "https";
    const to = `${proto}://${PRIMARY_HOST}${hrefWithAdd(`/${encodeURIComponent(slug)}`, mode === "page" ? ask.action : null, ask.at.pos)}`;
    return (
      <Dialog open onClose={onClose} size="sm" title="Add Jira on markdrop.in"
        description={`Jira is added and changed from the editor on markdrop.in. Open this page there to add ${what}: it goes in where you typed it.`}
        footer={<>
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button iconLeft="external" loading={busy} data-testid="jira-slash-open"
            onClick={() => void (mode === "doc" ? window.open(to, "_blank", "noopener") : leave(() => { window.location.href = to; }))}>Open on markdrop.in</Button>
        </>}>
        <p className="text-body-sm text-text-muted" data-testid="jira-slash-gate" data-why="tenant">Readers here still see the page&apos;s Jira issues, live through their own Jira.</p>
      </Dialog>
    );
  }
  if (ask.why === "site") {
    return (
      <Dialog open onClose={onClose} size="sm" title="No Jira site yet"
        description={workspaceId
          ? `This page's workspace isn't connected to a Jira site. A workspace admin connects one in Settings › Workspaces › Integrations; then ${what} can go in here.`
          : `Jira lists and new issues need a page in a workspace that's connected to Jira. Move this page into one to add ${what}.`}
        footer={<>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {workspaceId && (
            <Button iconLeft="settings" href={`/settings/workspaces/${encodeURIComponent(workspaceId)}?tab=integrations`} data-testid="jira-slash-settings">Jira settings</Button>
          )}
        </>}>
        <p className="text-body-sm text-text-muted" data-testid="jira-slash-gate" data-why="site">Each person then connects their own Atlassian account, so everyone sees only what their Jira lets them.</p>
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} size="sm" title="Jira isn't available here"
      description="Jira isn't switched on for this Markdrop yet."
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      <p className="text-body-sm text-text-muted" data-testid="jira-slash-gate" data-why="off">Ask the person who runs your Markdrop to set it up.</p>
    </Dialog>
  );
}

/* ── Which project (sprint, bugs, recently updated) ───────────────────────── */

const PROJECT_TITLE: Record<ProjectAction, string> = { sprint: "Current sprint", bugs: "Open bugs", recent: "Recently updated" };
const LAST = "md:jira-slash-project";

function ProjectDialog({ action, workspaceId, onClose, onPick }: { action: ProjectAction; workspaceId: string | null; onClose: () => void; onPick: (project: string) => void }) {
  const [projects, setProjects] = useState<Array<{ key: string; name: string }> | null>(null);
  const [value, setValue] = useState(() => {
    try { return window.localStorage.getItem(LAST) ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    if (!workspaceId) { setProjects([]); return; }
    let gone = false;
    import("@/lib/jira").then((m) => m.jiraProjects(workspaceId))
      .then((r) => { if (!gone) { setProjects(r.projects); setValue((v) => v || r.projects[0]?.key || ""); } })
      .catch(() => { if (!gone) setProjects([]); });
    return () => { gone = true; };
  }, [workspaceId]);
  const key = value.trim().toUpperCase();
  const valid = JIRA_PROJECT_RX.test(key);
  const pick = () => {
    if (!valid) return;
    try { window.localStorage.setItem(LAST, key); } catch { /* fine */ }
    onPick(key);
  };
  const preview = valid ? JIRA_PRESETS[action](key)?.jql : null;
  return (
    <Dialog open onClose={onClose} size="sm" title={PROJECT_TITLE[action]} description="Which project? The list's JQL can be changed afterwards (Edit list)."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!valid} onClick={pick} data-testid="jira-slash-project-add">Add list</Button>
      </>}>
      <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); pick(); }} data-testid="jira-slash-project">
        {projects && projects.length > 0 ? (
          <Field label="Project">
            <Select value={projects.some((p) => p.key === key) ? key : ""} onChange={(e) => setValue(e.target.value)}
              options={[...(projects.some((p) => p.key === key) ? [] : [{ value: "", label: key ? `${key} (typed)` : "Choose a project" }]), ...projects.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }))]} />
          </Field>
        ) : null}
        <Field label={projects && projects.length ? "Or a project key" : "Project key"}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="PAY" mono autoFocus={!projects?.length} data-testid="jira-slash-project-key" />
        </Field>
        {preview && <p className="m-0 break-words font-mono text-caption text-text-muted">{preview}</p>}
      </form>
    </Dialog>
  );
}
