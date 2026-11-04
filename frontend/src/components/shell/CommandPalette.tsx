"use client";

/**
 * ⌘K global search. ⌘K / Ctrl+K (or the header's search field) opens it. It searches everything the
 * person can open (`GET /api/v1/search`, debounced 120 ms, results kept on screen while the next ones
 * load): pages, documents and files by title, headings, text and file contents, with typos, partial
 * words and any word order; folders, workspaces and Guides pages; and their Trash at the bottom
 * ("In Trash · Restore"). The current workspace ranks higher; a chip narrows to it.
 *
 * AI: "Ask AI ✦" (⌘↵) asks Claude Haiku 5.5 about the person's documents (`POST /search/ask`, SSE);
 * it also runs on its own once a query reads like a question or a description. The answer streams
 * into a card above the results, citing the items it used.
 *
 * Keyboard: ↑ ↓ move, ↵ opens, ⇧↵ opens in a new tab, ⌘↵ asks AI, Tab reaches the filters, Esc closes.
 * ARIA: a combobox input owning a grouped listbox (aria-activedescendant).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, Icon, Kbd, Spinner, useToast } from "@/components/ui";
import { AiAnswer, ResultBody, TrashBody, useAiSearch } from "@/components/search/parts";
import { listRecent, type PersonalItem } from "@/lib/me";
import {
  forgetSearches, hrefOf, newSearchSid, recentSearches, rememberSearch, search, searchAiStatus, searchClicked,
  type AiStatus, type SearchItem, type SearchKind, type SearchResponse, type TrashHit,
} from "@/lib/search";
import { looksLikeQuestion } from "@/lib/searchCore.mjs";
import { restoreFromTrash } from "@/lib/trash";
import { openHref } from "@/lib/workspaces";
import s from "./CommandPalette.module.css";

export interface PaletteAction {
  id: string;
  label: string;
  icon: string;
  where: string;
  run: () => void;
}

type Row =
  | { id: string; type: "item"; item: SearchItem; run: (newTab?: boolean) => void }
  | { id: string; type: "trash"; item: TrashHit; run: (newTab?: boolean) => void }
  | { id: string; type: "plain"; label: string; where?: string; icon: string; run: (newTab?: boolean) => void };

interface Group {
  name: string;
  rows: Row[];
}

const MIN = 2;
const DEBOUNCE_MS = 120;
const AUTO_AI_MS = 650;

const KIND_CHIPS: Array<{ value: SearchKind | null; label: string }> = [
  { value: null, label: "All" },
  { value: "page", label: "Pages" },
  { value: "doc", label: "Documents" },
  { value: "file", label: "Files" },
  { value: "folder", label: "Folders" },
  { value: "guide", label: "Guides" },
];

export default function CommandPalette({
  open, onClose, actions, workspace,
}: {
  open: boolean;
  onClose: () => void;
  /** Local actions for the folder in view ("Upload to Guides", …). */
  actions: PaletteAction[];
  /** The workspace the person is in: ranked higher, and a chip narrows the search to it. */
  workspace?: { id: string; name: string } | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<SearchKind | null>(null);
  const [here, setHere] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [resultsFor, setResultsFor] = useState("");
  const [recentQ, setRecentQ] = useState<string[]>([]);
  const [recentItems, setRecentItems] = useState<PersonalItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoAsked = useRef<string>("");
  const sid = useRef<string>("");
  const ai = useAiSearch();
  const { reset: resetAi, run: runAi } = ai;
  const uid = useId();
  const scope = here && workspace ? workspace.id : null;

  // Fresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setResults(null);
    setResultsFor("");
    setFailed(false);
    setActive(0);
    setKind(null);
    setHere(false);
    resetAi();
    autoAsked.current = "";
    sid.current = newSearchSid();
    setRecentQ(recentSearches());
    let live = true;
    listRecent().then((r) => live && setRecentItems(r.slice(0, 5))).catch(() => live && setRecentItems([]));
    searchAiStatus().then((st) => live && setAiStatus(st)).catch(() => live && setAiStatus(null));
    return () => { live = false; };
  }, [open, resetAi]);

  // Debounced search; what is on screen stays until the next answer lands (no flicker).
  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < MIN) { setResults(null); setResultsFor(""); setLoading(false); return; }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      search({ q: term, kind, scope, current: workspace?.id ?? null, limit: 8, sid: sid.current }, ctl.signal)
        .then((r) => { setResults(r); setResultsFor(term); setFailed(false); })
        .catch(() => { if (!ctl.signal.aborted) { setFailed(true); setResults(null); } })
        .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, kind, scope, open, workspace?.id, nonce]);

  const aiOn = aiStatus?.enabled !== false;
  const askAi = useCallback((question?: string) => {
    const term = (question ?? q).trim();
    if (term.length < MIN || !aiOn) return;
    autoAsked.current = term;
    setRecentQ(rememberSearch(term));
    runAi(term, scope, workspace?.id ?? null);
  }, [q, aiOn, runAi, scope, workspace?.id]);

  // AI runs on its own for a question or a description, once the person stops typing.
  useEffect(() => {
    const term = q.trim();
    if (!open || !aiOn || !looksLikeQuestion(term) || autoAsked.current === term) return;
    const t = setTimeout(() => askAi(term), AUTO_AI_MS);
    return () => clearTimeout(t);
  }, [q, open, aiOn, askAi]);

  // Typing something else (not another question) puts the last answer away.
  const askedFor = ai.state.question;
  const aiIdle = ai.state.status === "idle";
  useEffect(() => {
    const term = q.trim();
    if (!aiIdle && askedFor && term !== askedFor && !looksLikeQuestion(term)) resetAi();
  }, [q, aiIdle, askedFor, resetAi]);

  const openItem = useCallback((item: { url: string | null; kind?: string; slug?: string; encrypted?: boolean }, newTab?: boolean) => {
    if (!item.url) return;
    if (q.trim().length >= MIN) setRecentQ(rememberSearch(q));
    if (results && resultsFor === q.trim()) searchClicked(results.log_id);
    const { href, external } = hrefOf({ url: item.url, kind: (item.kind as SearchKind) || "doc", slug: item.slug, encrypted: item.encrypted });
    onClose();
    if (external || newTab) window.open(href, "_blank", "noopener,noreferrer");
    else router.push(href);
  }, [q, onClose, router, results, resultsFor]);

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

  const term = q.trim();
  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    if (term.length >= MIN && results) {
      for (const g of results.groups) {
        out.push({
          name: g.label,
          rows: g.items.map((item) => ({ id: `r:${item.key}`, type: "item" as const, item, run: (nt?: boolean) => openItem(item, nt) })),
        });
      }
      if (results.trash.length) {
        out.push({
          name: "In Trash",
          rows: results.trash.map((t) => ({ id: `t:${t.key}`, type: "trash" as const, item: t, run: () => { onClose(); router.push("/trash"); } })),
        });
      }
      const all = results.groups.reduce((n, g) => n + g.items.length, 0);
      if (all) {
        const qs = new URLSearchParams({ q: term });
        if (scope) qs.set("scope", scope);
        if (kind) qs.set("kind", kind);
        out.push({
          name: "More",
          rows: [{ id: "see-all", type: "plain", icon: "search", label: `See all results for “${term}”`, where: "Filters, more results",
            run: () => { rememberSearch(term); onClose(); router.push(`/search?${qs}`); } }],
        });
      }
    } else if (term.length < MIN) {
      if (recentQ.length) {
        out.push({
          name: "Recent searches",
          rows: recentQ.slice(0, 5).map((r) => ({ id: `rq:${r}`, type: "plain" as const, icon: "history", label: r, run: () => { setQ(r); inputRef.current?.focus(); } })),
        });
      }
      if (recentItems?.length) {
        out.push({
          name: "Recently opened",
          rows: recentItems.map((f) => ({
            id: `recent:${f.slug}`, type: "plain" as const, icon: f.kind === "artifact" ? "archive" : f.editor === "blocks" ? "lines" : "doc",
            label: (f.encrypted ? f.slug : f.title?.trim()) || f.slug,
            where: f.workspace?.name ?? "My files",
            run: (nt?: boolean) => {
              onClose();
              const href = openHref(f.slug, f.url, f.encrypted);
              if (nt || !href.startsWith("/")) window.open(href, "_blank", "noopener,noreferrer");
              else router.push(href);
            },
          })),
        });
      }
    }
    // The folder's actions stay on offer (CommandK board): they're about where you are.
    const acts = term.length >= MIN ? actions.filter((a) => a.label.toLowerCase().includes(term.toLowerCase())) : actions;
    if (acts.length) {
      out.push({
        name: "Actions",
        rows: acts.map((a) => ({ id: `act:${a.id}`, type: "plain" as const, icon: a.icon, label: a.label, where: a.where, run: () => { onClose(); a.run(); } })),
      });
    }
    return out;
  }, [term, results, recentQ, recentItems, actions, openItem, onClose, router, scope, kind]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  useEffect(() => { setActive(0); }, [resultsFor, kind, scope]);
  const current = flat[Math.min(active, flat.length - 1)];
  const optId = (r: Row) => `${uid}-opt-${r.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  const currentId = current ? optId(current) : null;
  useEffect(() => {
    if (currentId) document.getElementById(currentId)?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); askAi(); }
    else if (e.key === "Enter") { if (current) { e.preventDefault(); current.run(e.shiftKey); } }
  }

  const listId = `${uid}-list`;
  const nResults = results ? results.groups.reduce((n, g) => n + g.items.length, 0) + results.trash.length : 0;
  const statusText = term.length < MIN
    ? ""
    : loading && !results ? "Searching…" : failed ? "Search isn't available right now." : nResults ? `${nResults} results` : `No matches for “${term}”`;
  const stale = loading && !!results && resultsFor !== term;

  return (
    <Dialog open={open} onClose={onClose} title="Search" className={s.palette} initialFocus={inputRef}>
      {/* Replays: the field, results and status echo titles and the query: blocked or masked. */}
      <div className={`ph-no-capture ${s.field}`}>
        <span className={s.fieldIcon} aria-hidden>{loading ? <Spinner size={18} /> : <Icon name="search" size={18} />}</span>
        <input
          ref={inputRef}
          className={s.input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={workspace && here ? `Search ${workspace.name}, or ask a question` : "Search everything, or ask a question"}
          aria-label="Search everything, or ask a question"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? optId(current) : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          data-testid="search-input"
        />
        <button
          type="button"
          className={s.askBtn}
          onClick={() => askAi()}
          disabled={term.length < MIN || !aiOn}
          title={!aiOn ? aiStatus?.message ?? "AI search isn't available" : "Ask AI about your documents (⌘↵)"}
          data-testid="ask-ai"
        >
          <Icon name="sparkle" size={14} /> <span className={s.askLabel}>Ask AI</span>
        </button>
        <button type="button" className={s.closeBtn} onClick={onClose} aria-label="Close search">
          <Kbd className={s.escKey}>Esc</Kbd><span className={s.closeIcon} aria-hidden><Icon name="x" size={18} /></span>
        </button>
      </div>
      <div className={s.filters} role="toolbar" aria-label="Filters">
        {KIND_CHIPS.map((c) => (
          <button key={c.label} type="button" className={s.chip} aria-pressed={kind === c.value}
            onClick={() => { setKind(c.value); inputRef.current?.focus(); }}>
            {c.label}
          </button>
        ))}
        {workspace && (
          <button type="button" className={`${s.chip} ${s.scopeChip}`} aria-pressed={here}
            onClick={() => { setHere((h) => !h); inputRef.current?.focus(); }}
            title={here ? "Searching only this workspace" : "Search only this workspace"}>
            <Icon name="users" size={12} /> {here ? workspace.name : `Only ${workspace.name}`}
          </button>
        )}
      </div>
      <span className="ph-sensitive ph-mask md-visually-hidden" role="status" aria-live="polite">{statusText}</span>

      <div className={`ph-no-capture ${s.scroll}`}>
        {ai.state.status !== "idle" && (
          <AiAnswer compact state={ai.state} onOpen={openItem} onRetry={() => askAi(ai.state.question)} />
        )}
        <ul id={listId} role="listbox" aria-label="Results" className={`${s.list} ${stale ? s.stale : ""}`}>
          {groups.map((g) => (
            <li key={g.name} role="presentation">
              <p className={s.group} aria-hidden>{g.name}</p>
              <ul role="group" aria-label={g.name} className={s.rows}>
                {g.rows.map((r) => {
                  const on = current?.id === r.id;
                  return (
                    <li
                      key={r.id}
                      id={optId(r)}
                      role="option"
                      aria-selected={on}
                      className={`${s.option} ${r.type === "plain" ? s.optionPlain : ""}`}
                      data-kind={r.type === "item" ? r.item.kind : r.type}
                      onMouseMove={() => { const i = flat.indexOf(r); if (i !== active) setActive(i); }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => r.run(e.metaKey || e.ctrlKey || e.shiftKey)}
                    >
                      {r.type === "item" ? <ResultBody item={r.item} compact />
                        : r.type === "trash" ? <TrashBody item={r.item} restoring={restoring === r.item.key} onRestore={() => void restore(r.item)} />
                          : (
                            <>
                              <span className={s.plainIcon} aria-hidden><Icon name={r.icon} size={16} /></span>
                              <span className={s.plainLabel} dir="auto">{r.label}</span>
                              {r.where && <span className={s.where}>{r.where}</span>}
                            </>
                          )}
                      {on && r.type !== "trash" && <span className={s.enter} aria-hidden>↵</span>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {term.length >= MIN && !loading && !flat.length && (
            <li role="presentation" className={s.empty}>
              {failed ? "Search isn't available right now. Try again in a moment." : (
                <>
                  <span className={s.emptyTitle}>Nothing matches “{term}”</span>
                  <span>Try fewer words, another spelling, or {aiOn ? <button type="button" className={s.inlineBtn} onClick={() => askAi()}>ask AI ✦</button> : "a different filter"}.</span>
                </>
              )}
            </li>
          )}
          {term.length < MIN && !recentQ.length && !recentItems?.length && (
            <li role="presentation" className={s.empty}>
              <span className={s.emptyTitle}>Search everything you can open</span>
              <span>Pages, documents, files and what&apos;s inside them, folders, workspaces and guides.</span>
              <span className={s.tips}>Typos are fine · word order doesn&apos;t matter · ask a question for an AI answer</span>
            </li>
          )}
        </ul>
        {term.length < MIN && recentQ.length > 0 && (
          <button type="button" className={s.clearRecent} onClick={() => { forgetSearches(); setRecentQ([]); }}>Clear recent searches</button>
        )}
      </div>

      <div className={s.foot}>
        <span className={s.keys}><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span className={s.keys}><Kbd>↵</Kbd> open</span>
        <span className={`${s.keys} ${s.hideSm}`}><Kbd>⌘</Kbd><Kbd>↵</Kbd> ask AI</span>
        <span className={`${s.keys} ${s.hideSm}`}><Kbd>Tab</Kbd> filters</span>
        <span className={`${s.took} ${s.hideSm}`}>{results && term.length >= MIN && !loading ? `${results.took_ms} ms` : ""}</span>
      </div>
    </Dialog>
  );
}
