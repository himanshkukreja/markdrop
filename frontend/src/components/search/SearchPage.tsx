"use client";

/**
 * /search: every result for a query, with filters (kind, workspace, owner, updated), the AI answer
 * card (on its own for a question, or "Ask AI ✦"), "Load more", and the Trash hits at the end.
 * The URL holds the query and filters (?q=&kind=&scope=&owner=&updated=), so a search can be shared
 * with yourself or reloaded. Results come from the server already limited to what the person can open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, EmptyState, Icon, Kbd, SegmentedControl, Select, Spinner, useToast } from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { useAuth } from "@/contexts/AuthContext";
import { listWorkspaces } from "@/lib/workspaces";
import { teamsSlot, useTeamsSidebar } from "@/lib/teamsStore";
import {
  hrefOf, newSearchSid, rememberSearch, search, searchAiStatus, searchClicked, type AiStatus, type SearchItem, type SearchKind,
  type SearchResponse, type TrashHit,
} from "@/lib/search";
import { looksLikeQuestion } from "@/lib/searchCore.mjs";
import { restoreFromTrash } from "@/lib/trash";
import { AiAnswer, ResultBody, TrashBody, useAiSearch } from "./parts";
import p from "./page.module.css";

type KindValue = "all" | SearchKind;
const KINDS: Array<{ value: KindValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "page", label: "Pages" },
  { value: "doc", label: "Documents" },
  { value: "file", label: "Files" },
  { value: "folder", label: "Folders" },
  { value: "workspace", label: "Workspaces" },
  { value: "guide", label: "Guides" },
];

function readParams(search: string) {
  const u = new URLSearchParams(search);
  const kind = (u.get("kind") || "all") as KindValue;
  return {
    q: u.get("q") || "",
    kind: KINDS.some((k) => k.value === kind) ? kind : "all",
    scope: u.get("scope") || "all",
    space: u.get("space") || "",
    owner: (u.get("owner") === "me" ? "me" : "anyone") as "me" | "anyone",
    updated: (["week", "month"].includes(u.get("updated") || "") ? u.get("updated") : "any") as "any" | "week" | "month",
  };
}

export default function SearchPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const mounted = useMounted();
  const toast = useToast();
  const locSearch = useLocationSearch();
  const initial = useMemo(() => readParams(locSearch), [locSearch]);
  // The URL is only readable after mount (the server renders without it): take the query and
  // filters from it once, then keep it in step with them.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (authLoading || !mounted || user) return;
    router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [authLoading, mounted, user, router]);

  const [q, setQ] = useState(initial.q);
  const [kind, setKind] = useState<KindValue>(initial.kind);
  const [scope, setScope] = useState(initial.scope);
  // Teams: within a workspace, one team's space or company-wide only ("" = all of it).
  const [space, setSpace] = useState(initial.space);
  useTeamsSidebar(scope !== "all" ? [scope] : []);
  const wsTeams = scope !== "all" ? teamsSlot(scope) : undefined;
  const teamChoices = wsTeams ? wsTeams.teams : [];
  const [owner, setOwner] = useState(initial.owner);
  const [updated, setUpdated] = useState(initial.updated);
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [items, setItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoAsked = useRef("");
  const sid = useRef(typeof window === "undefined" ? "" : newSearchSid());
  const ai = useAiSearch();
  const { run: runAi, reset: resetAi } = ai;
  const term = q.trim();
  const aiOn = aiStatus?.enabled !== false;

  useEffect(() => {
    if (!user) return;
    listWorkspaces().then((ws) => setWorkspaces(ws.map((w) => ({ id: w.id, name: w.name })))).catch(() => setWorkspaces([]));
    searchAiStatus().then(setAiStatus).catch(() => setAiStatus(null));
  }, [user]);

  useEffect(() => {
    if (!mounted || ready) return;
    const r = readParams(window.location.search);
    setQ(r.q);
    setKind(r.kind);
    setScope(r.scope);
    setSpace(r.space);
    setOwner(r.owner);
    setUpdated(r.updated);
    setReady(true);
  }, [mounted, ready]);

  // The URL follows the query and filters (replace: typing isn't history).
  useEffect(() => {
    if (!ready) return;
    const u = new URLSearchParams();
    if (term) u.set("q", term);
    if (kind !== "all") u.set("kind", kind);
    if (scope !== "all") u.set("scope", scope);
    if (scope !== "all" && space) u.set("space", space);
    if (owner !== "anyone") u.set("owner", owner);
    if (updated !== "any") u.set("updated", updated);
    const next = `/search${u.toString() ? `?${u}` : ""}`;
    if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, "", next);
  }, [term, kind, scope, space, owner, updated, ready]);

  const params = useMemo(() => ({
    q: term, kind: kind === "all" ? null : kind, scope: scope === "all" ? null : scope, space: scope !== "all" && space ? space : null, owner, updated, limit: 20,
  }), [term, kind, scope, space, owner, updated]);

  useEffect(() => {
    if (!user || !ready || term.length < 2) { setRes(null); setItems([]); setMore(false); return; }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      search({ ...params, sid: sid.current }, ctl.signal)
        .then((r) => { setRes(r); setItems(r.items); setMore(!!r.next_cursor); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Search isn't available right now."); })
        .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    }, 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [params, user, ready, term.length, nonce]);

  const loadMore = useCallback(async () => {
    if (!res?.next_cursor) return;
    setLoading(true);
    try {
      const r = await search({ ...params, cursor: res.next_cursor });
      setRes(r);
      setItems((xs) => [...xs, ...r.items.filter((i) => !xs.some((x) => x.key === i.key))]);
      setMore(!!r.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load more.");
    } finally {
      setLoading(false);
    }
  }, [res, params]);

  const askAi = useCallback((question?: string) => {
    const t = (question ?? term).trim();
    if (t.length < 2 || !aiOn) return;
    autoAsked.current = t;
    rememberSearch(t);
    runAi(t, scope === "all" ? null : scope, null);
  }, [term, aiOn, runAi, scope]);

  useEffect(() => {
    if (!user || !ready || !aiOn || !looksLikeQuestion(term) || autoAsked.current === term) return;
    const t = setTimeout(() => askAi(term), 650);
    return () => clearTimeout(t);
  }, [term, user, ready, aiOn, askAi]);

  const askedFor = ai.state.question;
  const aiIdle = ai.state.status === "idle";
  useEffect(() => {
    if (!aiIdle && askedFor && term !== askedFor && !looksLikeQuestion(term)) resetAi();
  }, [term, aiIdle, askedFor, resetAi]);

  const openItem = useCallback((item: { url: string | null; kind?: string; slug?: string; encrypted?: boolean }, newTab?: boolean) => {
    if (!item.url) return;
    if (term.length >= 2) rememberSearch(term);
    if (res && res.query === term) searchClicked(res.log_id);
    const { href, external } = hrefOf({ url: item.url, kind: (item.kind as SearchKind) || "doc", slug: item.slug, encrypted: item.encrypted });
    if (external || newTab) window.open(href, "_blank", "noopener,noreferrer");
    else router.push(href);
  }, [router, term, res]);

  const restore = useCallback(async (t: TrashHit) => {
    setRestoring(t.key);
    try {
      await restoreFromTrash(t.key);
      toast.success(`Restored “${t.title}”`);
      setNonce((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't restore it. Try again from Trash.");
    } finally {
      setRestoring(null);
    }
  }, [toast]);

  if (!user) return null;
  const trash = res?.trash ?? [];

  return (
    <div className={p.page}>
      <PageHeader title="Search" description="Everything you can open: pages, documents, files and what's inside them, folders, workspaces and guides." />

      <form className={p.bar} role="search" onSubmit={(e) => { e.preventDefault(); if (looksLikeQuestion(term)) askAi(); }}>
        <span className={p.barIcon} aria-hidden>{loading ? <Spinner size={18} /> : <Icon name="search" size={18} />}</span>
        <input
          ref={inputRef}
          className={`ph-no-capture ${p.input}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); askAi(); } }}
          placeholder="Search everything, or ask a question"
          aria-label="Search everything, or ask a question"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          data-testid="search-page-input"
        />
        <button type="button" className={p.ask} onClick={() => askAi()} disabled={term.length < 2 || !aiOn}
          title={!aiOn ? aiStatus?.message ?? "AI search isn't available" : "Ask AI about your documents (⌘↵)"} data-testid="ask-ai">
          <Icon name="sparkle" size={14} /> Ask AI
        </button>
      </form>

      <div className={p.filters}>
        <SegmentedControl<KindValue> size="sm" value={kind} onChange={setKind} options={KINDS} aria-label="Kind" className={p.kinds} />
        <div className={p.selects}>
          <Select aria-label="Where" value={scope} onChange={(e) => { setScope(e.target.value); setSpace(""); }}
            options={[{ value: "all", label: "Everywhere" }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]} />
          {teamChoices.length > 0 && (
            <Select aria-label="Team" value={space} onChange={(e) => setSpace(e.target.value)} data-testid="search-team"
              options={[{ value: "", label: "All teams" }, { value: "company", label: "Company-wide only" }, ...teamChoices.map((t) => ({ value: `team:${t.id}`, label: t.name }))]} />
          )}
          <Select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value as "me" | "anyone")}
            options={[{ value: "anyone", label: "Anyone's" }, { value: "me", label: "Mine" }]} />
          <Select aria-label="Updated" value={updated} onChange={(e) => setUpdated(e.target.value as "any" | "week" | "month")}
            options={[{ value: "any", label: "Any time" }, { value: "week", label: "Past week" }, { value: "month", label: "Past month" }]} />
        </div>
      </div>

      <div className="ph-no-capture">
        {ai.state.status !== "idle" && <AiAnswer state={ai.state} onOpen={openItem} onRetry={() => askAi(ai.state.question)} />}

        {term.length < 2 ? (
          <EmptyState icon="search" title="Search everything you can open"
            description="Typos are fine and word order doesn't matter. Ask a question to get an AI answer from your documents." />
        ) : error ? (
          <EmptyState icon="alert" title="Search isn't available right now" description={error}
            actions={<Button size="sm" onClick={() => setNonce((n) => n + 1)}>Try again</Button>} />
        ) : res && !items.length && !trash.length && !loading ? (
          <EmptyState icon="search" title={`Nothing matches “${term}”`}
            description="Try fewer words, another spelling or a wider filter."
            actions={aiOn ? <Button size="sm" variant="secondary" onClick={() => askAi()}><Icon name="sparkle" size={14} /> Ask AI</Button> : undefined} />
        ) : (
          <>
            {res && (
              <p className={p.count} role="status">
                {res.total != null ? `${res.total} result${res.total === 1 ? "" : "s"}` : `${items.length}+ results`}
                <span className={p.took}> · {res.took_ms} ms</span>
              </p>
            )}
            <ul className={`${p.results} ${loading ? p.loading : ""}`} aria-label="Results">
              {items.map((item) => (
                <li key={item.key}>
                  <a className={p.row} href={hrefOf(item).href} data-kind={item.kind}
                    onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); openItem(item); }}>
                    <ResultBody item={item} />
                  </a>
                </li>
              ))}
            </ul>
            {more && (
              <div className={p.more}><Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loading}>Load more</Button></div>
            )}
            {trash.length > 0 && (
              <section className={p.trash} aria-label="In Trash">
                <h2 className={p.trashHead}>In Trash</h2>
                <ul className={p.results}>
                  {trash.map((t) => (
                    <li key={t.key} className={p.row} data-kind="trash">
                      <TrashBody item={t} restoring={restoring === t.key} onRestore={() => void restore(t)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      <p className={p.hint}><Kbd>⌘</Kbd><Kbd>K</Kbd> searches from anywhere · <Kbd>⌘</Kbd><Kbd>↵</Kbd> asks AI</p>
    </div>
  );
}
