"use client";

/**
 * The ⌘K palette (board "Search"). The index is a static JSON file built from the content
 * (`/search-index.json`, sections + pages + changelog), fetched once when the page is idle and
 * searched in the browser with MiniSearch: nothing typed in Search mode is ever sent anywhere.
 * Ask AI mode (Tab switches) sends the question to Ask AI on Enter and streams a short answer
 * with its sources; "Continue in panel" moves it into the Ask AI panel's conversation.
 */
import type MiniSearch from "minisearch";
import type { SearchResult } from "minisearch";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, IconButton, Kbd, Spinner, cx } from "@/components/ui";
import type { SearchDoc } from "../types";
import { loadIndex } from "./searchIndex";
import { askInPalette, clearPalette, ensureStatus } from "./ask/store";

const PaletteAsk = dynamic(() => import("./ask/PaletteAsk"), { ssr: false, loading: () => <div className="dx-palette__status"><Spinner /> Loading…</div> });

type Mode = "search" | "ask";
import { SEARCH_EVENT, clearRecentSearches, openSearch, rememberSearch, useRecentSearches } from "./state";

type Hit = Pick<SearchDoc, "id" | "kind" | "title" | "where" | "href" | "snippet"> & { terms: string[] };

const GROUPS: Array<{ kind: SearchDoc["kind"]; title: string; icon: string; max: number }> = [
  { kind: "section", title: "Sections", icon: "link", max: 6 },
  { kind: "page", title: "Pages", icon: "doc", max: 5 },
  { kind: "change", title: "Changelog", icon: "clock", max: 3 },
];

function search(ms: MiniSearch<SearchDoc>, q: string): Hit[] {
  let res: SearchResult[] = ms.search(q, { combineWith: "AND" });
  if (res.length < 3) {
    const seen = new Set(res.map((r) => r.id));
    res = res.concat(ms.search(q, { combineWith: "OR" }).filter((r) => !seen.has(r.id)));
  }
  return res.map((r) => ({ id: String(r.id), kind: r.kind, title: r.title, where: r.where, href: r.href, snippet: r.snippet, terms: r.terms }));
}

function highlight(text: string, terms: string[]): React.ReactNode {
  const ts = terms.filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!ts.length || !text) return text;
  const re = new RegExp(`(${ts.join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

export function SearchPalette({ suggestions = [] }: { suggestions?: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [ms, setMs] = useState<MiniSearch<SearchDoc> | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<Mode>("search");
  const recent = useRecentSearches();
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const uid = useId().replace(/:/g, "");

  // Load the index once the page is idle, so the first ⌘K is instant (and works offline after).
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    const go = () => loadIndex().then(setMs, () => setFailed(true));
    if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 4000 });
    else setTimeout(go, 1500);
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ query?: string; mode?: Mode }>).detail;
      const q = detail?.query ?? "";
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery(q);
      setActive(0);
      setMode(detail?.mode === "ask" ? "ask" : "search");
      setOpen(true);
      if (!ms) loadIndex().then(setMs, () => setFailed(true));
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else openSearch();
      } else if (e.key === "/" && !typing && !open && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener(SEARCH_EVENT, onOpen);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(SEARCH_EVENT, onOpen);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ms]);

  // Scroll lock + focus while open; focus returns to whatever opened it.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    input.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      const back = returnTo.current;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [open]);

  const q = query.trim();
  const hits = useMemo(() => (ms && q ? search(ms, q) : []), [ms, q]);
  const groups = useMemo(
    () => GROUPS.map((g) => ({ ...g, items: hits.filter((h) => h.kind === g.kind).slice(0, g.max) })).filter((g) => g.items.length),
    [hits],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const emptyRows = q ? [] : (recent.length ? recent : suggestions).slice(0, 6);
  const rowCount = q ? flat.length : emptyRows.length;

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = useCallback(() => {
    clearPalette();
    setOpen(false);
  }, []);
  const switchMode = useCallback((m: Mode) => {
    setMode(m);
    setActive(0);
    if (m === "ask") void ensureStatus();
    input.current?.focus();
  }, []);
  const ask = useCallback((question: string) => {
    const text = question.trim();
    if (!text) return;
    setQuery(text);
    setMode("ask");
    askInPalette(text);
  }, []);
  /** "Continue in panel": the answer moves first (so closing doesn't stop it), then focus goes to the panel. */
  const continueInPanel = useCallback(() => {
    returnTo.current = null;
    setOpen(false);
  }, []);
  const go = useCallback(
    (hit: Hit) => {
      rememberSearch(query);
      close();
      router.push(hit.href);
    },
    [query, router, close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab" && !e.shiftKey && e.target === input.current) {
      // Tab in the box switches between Search and Ask AI (board "Search").
      e.preventDefault();
      switchMode(mode === "search" ? "ask" : "search");
    } else if (mode === "ask") {
      if (e.key === "Enter" && e.target === input.current && !e.nativeEvent.isComposing) {
        e.preventDefault();
        ask(query);
      } else if (e.key === "Tab") trapTab(e);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rowCount) setActive((a) => (a + 1) % rowCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rowCount) setActive((a) => (a - 1 + rowCount) % rowCount);
    } else if (e.key === "Enter") {
      if (q && flat[active]) {
        e.preventDefault();
        go(flat[active]);
      } else if (!q && emptyRows[active]) {
        e.preventDefault();
        setQuery(emptyRows[active]);
      }
    } else if (e.key === "Tab") trapTab(e);
  };

  // Keep focus inside the dialog.
  function trapTab(e: React.KeyboardEvent) {
    const f = Array.from(panel.current?.querySelectorAll<HTMLElement>("input, textarea, button:not([disabled]), a[href]") ?? []).filter((el) => el.tabIndex >= 0);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
  }

  if (!open || typeof document === "undefined") return null;
  const optionId = (i: number) => `${uid}-opt-${i}`;
  let index = -1;

  const asking = mode === "ask";
  return createPortal(
    <div className="dx-palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Search the docs or ask" className={cx("dx-palette", asking && "dx-palette--ask")} onKeyDown={onKeyDown}>
        <div className="dx-palette__head">
          <Icon name={asking ? "zap" : "search"} className={cx("dx-palette__glyph", asking && "dx-palette__glyph--ask")} />
          <input
            ref={input}
            autoFocus
            className="dx-palette__input"
            type="text"
            role={asking ? undefined : "combobox"}
            aria-expanded={asking ? undefined : rowCount > 0}
            aria-controls={asking ? undefined : `${uid}-list`}
            aria-activedescendant={!asking && rowCount ? optionId(active) : undefined}
            aria-autocomplete={asking ? undefined : "list"}
            aria-label={asking ? "Ask a question about Markdrop" : "Search the docs"}
            placeholder={asking ? "Ask a question about Markdrop" : "Search the docs"}
            autoComplete="off"
            spellCheck={false}
            maxLength={asking ? 2000 : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div role="radiogroup" aria-label="Mode" className="dx-seg">
            <button type="button" role="radio" aria-checked={!asking} className="dx-seg__opt" data-on={!asking ? "" : undefined} onClick={() => switchMode("search")}>
              Search
            </button>
            <button type="button" role="radio" aria-checked={asking} className="dx-seg__opt" data-on={asking ? "" : undefined} onClick={() => switchMode("ask")}>
              <Icon name="zap" />
              Ask AI
            </button>
          </div>
          <IconButton icon="x" label="Close search" size="sm" onClick={close} className="dx-palette__close" />
        </div>

        {asking ? (
          <div className="dx-palette__body dx-palette__body--ask">
            <PaletteAsk
              suggestions={suggestions}
              onAsk={ask}
              onContinued={continueInPanel}
              onNavigate={() => {
                returnTo.current = null;
                close();
              }}
            />
          </div>
        ) : (
          <div ref={listRef} id={`${uid}-list`} role="listbox" aria-label={q ? "Results" : recent.length ? "Recent searches" : "Suggestions"} className="dx-palette__body">
            {q && (
              <button type="button" className="dx-palette__askrow" onClick={() => ask(query)}>
                <Icon name="zap" className="dx-palette__askicon" />
                <span className="dx-palette__main">
                  <strong className="dx-palette__title">Ask AI: “{q}”</strong>
                  <span className="dx-palette__snippet">An answer from these docs, with links to the sections it used</span>
                </span>
                <Kbd>Tab</Kbd>
              </button>
            )}
            {!q && emptyRows.length > 0 && (
              <div className="dx-palette__group">
                <div className="dx-palette__grouphead">
                  <span className="dx-eyebrow">{recent.length ? "Recent searches" : "Try"}</span>
                  {recent.length > 0 && (
                    <button type="button" className="dx-palette__clear" onClick={clearRecentSearches}>
                      Clear
                    </button>
                  )}
                </div>
                {emptyRows.map((r, i) => (
                  <div
                    key={r}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    className="dx-palette__row"
                    onMouseMove={() => setActive(i)}
                    onClick={() => setQuery(r)}
                  >
                    <Icon name={recent.length ? "clock" : "search"} className="dx-palette__icon" />
                    <span className="dx-palette__main">
                      <span className="dx-palette__title">{r}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {q && !ms && !failed && (
              <div className="dx-palette__status">
                <Spinner /> Loading the index…
              </div>
            )}
            {q && failed && !ms && <div className="dx-palette__status">Search couldn&apos;t load. Check your connection and try again.</div>}
            {q && ms && !flat.length && (
              <div className="dx-palette__status">
                No results for “{q}”. Try fewer words, or a word from the page title.
              </div>
            )}
            {groups.map((g) => (
              <div key={g.kind} className="dx-palette__group" role="group" aria-label={g.title}>
                <div className="dx-palette__grouphead">
                  <span className="dx-eyebrow">{g.title}</span>
                </div>
                {g.items.map((h) => {
                  index++;
                  const i = index;
                  return (
                    <a
                      key={h.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      data-index={i}
                      href={h.href}
                      tabIndex={-1}
                      className="dx-palette__row"
                      onMouseMove={() => setActive(i)}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        go(h);
                      }}
                    >
                      <Icon name={g.icon} className="dx-palette__icon" />
                      <span className="dx-palette__main">
                        <span className="dx-palette__title">{highlight(h.title, h.terms)}</span>
                        {h.snippet && <span className="dx-palette__snippet">{highlight(h.snippet, h.terms)}</span>}
                      </span>
                      <span className="dx-palette__where">{h.where}</span>
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className="dx-palette__foot">
          {!asking && (
            <span>
              <Kbd>↑↓</Kbd>move
            </span>
          )}
          <span>
            <Kbd>↵</Kbd>
            {asking ? "ask" : "open"}
          </span>
          <span>
            <Kbd>Tab</Kbd>
            {asking ? "back to results" : "ask AI instead"}
          </span>
          <span>
            <Kbd>esc</Kbd>close
          </span>
          <span className="dx-palette__spacer" />
          <span className="dx-palette__note">{asking ? "Your question is sent to Ask AI. Answers come only from these docs." : "Search runs in your browser. Nothing you type is sent."}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The header's search box (a button that looks like one). */
export function SearchTrigger({ variant = "box" }: { variant?: "box" | "icon" }) {
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)), []);
  if (variant === "icon") return <IconButton icon="search" label="Search the docs" onClick={() => openSearch()} className="dx-searchicon" />;
  return (
    <button type="button" className={cx("dx-searchbox")} onClick={() => openSearch()} aria-label="Search the docs" aria-keyshortcuts="Meta+K Control+K">
      <Icon name="search" />
      <span className="dx-searchbox__ph">Search or ask…</span>
      <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>
    </button>
  );
}
