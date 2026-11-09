"use client";

/**
 * Comments ↔ Jira (CONTRACT §11.3 slots; registered from components/comments/slots.ts):
 *
 *   threadActions   "Create Jira issue" (the AI draft of the discussion + review; created as you, and
 *                   the issue links back to the discussion) and "Link a Jira issue"
 *   threadSections  the linked issue under the first message: "KEY · title" for everyone who sees the
 *                   discussion, its status (and every workflow step) through your own Jira, and the
 *                   linkage: resolving the discussion offers to move the issue to Done; an issue that's
 *                   Done in Jira offers to resolve the discussion.
 *
 * One GET …/threads per page, shared by every thread (a small store by slug), read again after a
 * change and on the page's live `{type: "jira"}` nudges.
 */
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Dialog, Field, Icon, Input, Spinner, useToast } from "@/components/ui";
import type { Thread } from "@/lib/comments";
import type { CommentSlots } from "@/components/comments/slots";
import type { CommentsCtx } from "@/components/comments/context";
import {
  hostOf, jiraThreadCreate, jiraThreadDraft, jiraThreadLink, jiraThreadLinks, jiraThreadUnlink, jiraTransition, jiraTransitions, linkText, normKey,
  type JiraThreadLink,
} from "@/lib/jiraPages";
import { StatusMenu } from "./JiraBlocks";
import "../jira.css";
import "./jiraPages.css";

const CreateIssueDialog = dynamic(() => import("../CreateIssueDialog").then((m) => m.CreateIssueDialog), { ssr: false, loading: () => null });

interface State { loaded: boolean; threads: Record<string, JiraThreadLink>; canCreate: boolean; connected: boolean; open: { thread: string; kind: "create" | "link" } | null }
const EMPTY: State = { loaded: false, threads: {}, canCreate: false, connected: false, open: null };

class LinkStore {
  state: State = EMPTY;
  private fns = new Set<() => void>();
  private busy: Promise<void> | null = null;
  constructor(readonly slug: string) {}
  subscribe = (fn: () => void) => { this.fns.add(fn); return () => this.fns.delete(fn); };
  set(next: Partial<State>) { this.state = { ...this.state, ...next }; for (const f of this.fns) f(); }
  load(): Promise<void> {
    this.busy ??= jiraThreadLinks(this.slug)
      .then((r) => this.set({ loaded: true, threads: r.threads, canCreate: !!(r as { can_create?: boolean }).can_create, connected: !!(r as { connected?: boolean }).connected }))
      .catch(() => this.set({ loaded: true }))
      .finally(() => { this.busy = null; });
    return this.busy;
  }
}
const stores = new Map<string, LinkStore>();
function storeFor(slug: string): LinkStore {
  let s = stores.get(slug);
  if (!s) {
    stores.set(slug, (s = new LinkStore(slug)));
    void s.load();
  }
  return s;
}

function useLinks(slug: string): [LinkStore, State] {
  const store = storeFor(slug);
  const state = useSyncExternalStore(store.subscribe, () => store.state, () => EMPTY);
  return [store, state];
}

/** The linked issue, the linkage offers, and the create / link dialogs for this thread. */
function ThreadIssue({ thread, ctx }: { thread: Thread; ctx: CommentsCtx }) {
  const [store, state] = useLinks(ctx.slug);
  const toast = useToast();
  const link = state.threads[thread.id];
  const [busy, setBusy] = useState(false);
  // The thread changed (resolved, reopened, a reply): read the links again (not on first show: the store just did).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void store.load();
  }, [store, thread.status, thread.updated_at]);
  const issue = link?.issue ?? null;
  const site = link?.site ?? null;
  const open = state.open?.thread === thread.id ? state.open.kind : null;
  const close = () => store.set({ open: null });

  async function toDone() {
    if (!link || !site) return;
    setBusy(true);
    try {
      const steps = (await jiraTransitions(site, link.key)).transitions;
      const done = steps.find((t) => t.to.category === "done" && !t.fields.some((f) => f.required));
      if (!done) {
        toast.info?.(steps.some((t) => t.to.category === "done") ? `Jira asks for more to close ${link.key}: use its status menu.` : `Jira offers you no step to Done for ${link.key}.`);
        return;
      }
      await jiraTransition(site, link.key, done.id, null, ctx.slug);
      toast.success(`${link.key} → ${done.to.name}`);
      await store.load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Jira didn't take that step.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {link && (
        <div className="jp-thread" data-testid="jira-thread" data-key={link.key}>
          <div className="jp-thread__row">
            <span className="jp-card__glyph" aria-hidden><Icon name="checkSquare" size={12} /></span>
            <a className="jp-chip__key md-focus" href={link.url ?? undefined} target="_blank" rel="noreferrer">{link.key}</a>
            <span className="jp-ellipsis">{issue?.summary ?? link.title ?? ""}</span>
            {issue && site && <StatusMenu issue={issue} ctx={{ store: { patch: (_s, it) => it && store.set({ threads: { ...store.state.threads, [thread.id]: { ...link, issue: it } } }) }, site, slug: ctx.slug }} size="xs" />}
          </div>
          {issue && thread.status === "resolved" && issue.status.category !== "done" && (
            <div className="jp-thread__offer">
              <span>Discussion resolved. Close {link.key} in Jira too?</span>
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void toDone()} data-testid="jira-thread-done">Move to Done</Button>
            </div>
          )}
          {issue && thread.status === "open" && issue.status.category === "done" && thread.can.resolve && (
            <div className="jp-thread__offer">
              <span>{link.key} is Done in Jira.</span>
              <Button size="sm" variant="secondary" onClick={() => void ctx.resolve(thread.id)} data-testid="jira-thread-resolve">Resolve discussion</Button>
            </div>
          )}
        </div>
      )}
      {open === "create" && (
        <CreateIssueDialog open item={{ slug: ctx.slug }} workspaceId={null} title="Create Jira issue from this discussion" onClose={close}
          loadDraft={() => jiraThreadDraft(ctx.slug, thread.id)}
          submit={async (fields) => {
            const r = await jiraThreadCreate(ctx.slug, thread.id, fields);
            await store.load();
            return { key: r.key, url: r.url ?? "", issue: r.issue, link: null };
          }} />
      )}
      {open === "link" && <LinkDialog slug={ctx.slug} thread={thread} onClose={close} onDone={() => void store.load()} />}
    </>
  );
}

function LinkDialog({ slug, thread, onClose, onDone }: { slug: string; thread: Thread; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = normKey(value);
  async function go() {
    if (!key) return;
    setBusy(true);
    setErr(null);
    try {
      await jiraThreadLink(slug, thread.id, key, hostOf(value.includes("/") ? value : null));
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't link it.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} size="sm" title="Link a Jira issue" description="The discussion shows the issue; resolving one offers to resolve the other."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button onClick={() => void go()} loading={busy} disabled={!key} data-testid="jira-thread-link-go">Link</Button></>}>
      <form className="jp-form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Field label="Issue key or link"><Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="PAY-123" data-testid="jira-thread-link-key" /></Field>
        {err && <p className="jp-err" role="alert">{err}</p>}
      </form>
    </Dialog>
  );
}

function canAct(t: Thread, c: CommentsCtx): boolean {
  const s = storeFor(c.slug).state;
  return !!c.user && c.perms.comment && s.loaded && s.canCreate && !s.threads[t.id];
}

export function register(slots: CommentSlots): void {
  slots.threadSections.push({ id: "jira", Component: ThreadIssue });
  slots.threadActions.push(
    { id: "jira-create", label: "Create Jira issue", icon: "checkSquare", when: canAct, run: (t, c) => storeFor(c.slug).set({ open: { thread: t.id, kind: "create" } }) },
    { id: "jira-link", label: "Link a Jira issue", icon: "link", when: canAct, run: (t, c) => storeFor(c.slug).set({ open: { thread: t.id, kind: "link" } }) },
    {
      id: "jira-unlink", label: "Unlink the Jira issue", icon: "x",
      when: (t, c) => !!c.user && c.perms.comment && !!storeFor(c.slug).state.threads[t.id],
      run: async (t, c) => {
        await jiraThreadUnlink(c.slug, t.id).catch(() => null);
        await storeFor(c.slug).load();
      },
    },
  );
}

export { linkText, Spinner };
