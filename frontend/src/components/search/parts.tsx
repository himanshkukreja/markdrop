"use client";

/**
 * Global search's shared pieces (the ⌘K palette and the /search page): highlighted text, a result
 * row, the AI answer card and the hook that streams it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FileIcon, Icon, Spinner } from "@/components/ui";
import { askSearch, type AskEvent, type Citation, type SearchItem, type TrashHit } from "@/lib/search";
import { citeSegments, highlight, KIND_LABELS, shortAgo, whereOf } from "@/lib/searchCore.mjs";
import s from "./search.module.css";

/** Text with the server's match ranges as <mark>. */
export function Marked({ text, marks, className }: { text: string; marks?: unknown; className?: string }) {
  return (
    <span className={className} dir="auto">
      {highlight(text, marks).map((seg, i) => (seg.mark ? <mark key={i} className={s.mark}>{seg.text}</mark> : <span key={i}>{seg.text}</span>))}
    </span>
  );
}

export function KindIcon({ item, size = 18 }: { item: Pick<SearchItem, "kind" | "mime" | "title" | "slug" | "icon">; size?: number }) {
  if (item.icon && item.kind === "page") return <span className={s.emoji} style={{ fontSize: size - 2 }} aria-hidden>{item.icon}</span>;
  switch (item.kind) {
    case "file": return <FileIcon name={item.title || item.slug || ""} mime={item.mime || ""} size={size} />;
    case "folder": return <Icon name="folder" size={size} />;
    case "workspace": return <Icon name="users" size={size} />;
    case "guide": return <Icon name="layers" size={size} />;
    case "page": return <Icon name="lines" size={size} />;
    default: return <Icon name="doc" size={size} />;
  }
}

export function titleOf(item: Pick<SearchItem, "title" | "slug" | "encrypted" | "kind">): string {
  if (item.encrypted) return item.slug ? `/${item.slug}` : "Encrypted document";
  return item.title?.trim() || (item.slug ? `/${item.slug}` : "Untitled");
}

/** One result: icon, highlighted title, the matched snippet, and where it lives. */
export function ResultBody({ item, compact }: { item: SearchItem; compact?: boolean }) {
  const title = titleOf(item);
  const where = whereOf(item);
  const ago = shortAgo(item.updated_at ?? null);
  const meta = [KIND_LABELS[item.kind] ?? item.kind, where, item.owner && !item.owner.is_you && item.owner.name ? item.owner.name : null, ago]
    .filter(Boolean).join(" · ");
  return (
    <>
      <span className={s.icon} aria-hidden><KindIcon item={item} /></span>
      <span className={s.body}>
        <span className={s.titleLine}>
          <Marked className={s.title} text={title} marks={item.encrypted ? [] : item.title_marks} />
          {item.has_password && <Icon name="lock" size={12} className={s.lock} aria-label="Password protected" />}
          {item.match === "heading" && <span className={s.tag}>Section</span>}
        </span>
        {item.snippet?.text ? (
          <Marked className={`${s.snippet} ${compact ? s.snippetCompact : ""}`} text={item.snippet.text} marks={item.snippet.marks} />
        ) : null}
        <span className={s.meta}>{meta}</span>
      </span>
    </>
  );
}

export function TrashBody({ item, onRestore, restoring }: { item: TrashHit; onRestore: () => void; restoring?: boolean }) {
  return (
    <>
      <span className={s.icon} aria-hidden><Icon name="trash" size={18} /></span>
      <span className={s.body}>
        <span className={s.titleLine}><Marked className={s.title} text={item.title} marks={item.title_marks} /></span>
        <span className={s.meta}>
          In Trash{item.workspace?.name ? ` · ${item.workspace.name}` : ""}{typeof item.days_left === "number" ? ` · ${item.days_left} days left` : ""}
        </span>
      </span>
      <button type="button" className={s.restore} onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onRestore(); }} disabled={restoring}>
        {restoring ? <Spinner size={12} /> : <Icon name="undo" size={12} />} Restore
      </button>
    </>
  );
}

// ── AI search ─────────────────────────────────────────────────────────────────

export interface AiState {
  status: "idle" | "running" | "done" | "limit" | "error";
  question: string;
  stage: "expanding" | "searching" | "answering" | null;
  text: string;
  answer: string;
  citations: Citation[];
  ranked: SearchItem[];
  message: string;
}

const IDLE: AiState = { status: "idle", question: "", stage: null, text: "", answer: "", citations: [], ranked: [], message: "" };

/** Runs AI search (one at a time: a new question aborts the last one). */
export function useAiSearch() {
  const [state, setState] = useState<AiState>(IDLE);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const reset = useCallback(() => { ctl.current?.abort(); ctl.current = null; setState(IDLE); }, []);

  const run = useCallback((question: string, scope: string | null, current: string | null) => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setState({ ...IDLE, status: "running", question, stage: "expanding" });
    const on = (e: AskEvent) => {
      if (c.signal.aborted) return;
      setState((st) => {
        switch (e.type) {
          case "status": return { ...st, stage: e.stage };
          case "results": return { ...st, ranked: e.items || [] };
          case "delta": return { ...st, stage: "answering", text: st.text + e.text };
          case "done": return { ...st, status: "done", stage: null, answer: e.answer || st.text, citations: e.citations || [] };
          case "limit": return { ...st, status: "limit", stage: null, message: e.message };
          case "error": return { ...st, status: "error", stage: null, message: e.detail || "AI search hit a problem. Try again." };
          default: return st;
        }
      });
    };
    void askSearch({ question, scope, current }, on, c.signal).then(() => {
      if (c.signal.aborted) return;
      setState((st) => (st.status === "running" ? { ...st, status: st.text ? "done" : "error", answer: st.answer || st.text, message: st.text ? "" : "AI search stopped early. Try again." } : st));
    });
  }, []);

  return { state, run, reset };
}

const STAGE: Record<string, string> = {
  expanding: "Understanding your question…",
  searching: "Searching everything you can open…",
  answering: "Writing an answer…",
};

/** Inline Markdown for an answer line: **bold**, `code`, and [n] citation chips. */
function Inline({ text, known, cite }: { text: string; known: number[]; cite: (n: number) => React.ReactNode }) {
  return (
    <>
      {citeSegments(text, known).map((seg, i) => {
        if (seg.cite !== undefined) return <span key={i}>{cite(seg.cite)}</span>;
        const parts = (seg.text || "").split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
        return (
          <span key={i}>
            {parts.map((p, j) => (p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <strong key={j}>{p.slice(2, -2)}</strong>
              : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code key={j}>{p.slice(1, -1)}</code> : <span key={j}>{p}</span>))}
          </span>
        );
      })}
    </>
  );
}

/** The answer card: streams in, cites the items it used, and says plainly when AI can't run. */
export function AiAnswer({ state, onOpen, onRetry, compact }: {
  state: AiState;
  onOpen: (item: { url: string | null; kind?: string; slug?: string; encrypted?: boolean }, newTab?: boolean) => void;
  onRetry?: () => void;
  compact?: boolean;
}) {
  if (state.status === "idle") return null;
  const byN = new Map<number, { title: string; url: string | null; kind: string; slug?: string; where?: string }>();
  for (const it of state.ranked) if (typeof it.n === "number") byN.set(it.n, { title: titleOf(it), url: it.url, kind: it.kind, slug: it.slug, where: whereOf(it) });
  for (const c of state.citations) if (!byN.has(c.n)) byN.set(c.n, { title: c.title || "Untitled", url: c.url, kind: c.kind, slug: c.slug ?? undefined });
  const known = [...byN.keys()];
  const order = new Map<number, number>();
  const body = state.answer || state.text;
  for (const seg of citeSegments(body, known)) if (seg.cite !== undefined && !order.has(seg.cite)) order.set(seg.cite, order.size + 1);
  const cite = (n: number) => {
    const ref = byN.get(n);
    return (
      <button type="button" className={s.cite} title={ref?.title} onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => ref?.url && onOpen({ url: ref.url, kind: ref.kind, slug: ref.slug }, e.metaKey || e.ctrlKey)}>
        {order.get(n) ?? n}
      </button>
    );
  };
  const sources = [...order.keys()].map((n) => ({ n, label: order.get(n)!, ...byN.get(n)! })).filter((x) => x.title);
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  return (
    <section className={`${s.ai} ${compact ? s.aiCompact : ""}`} aria-live="polite" aria-busy={state.status === "running"}
      aria-label="AI answer">
      <header className={s.aiHead}>
        <span className={s.aiBadge}><Icon name="sparkle" size={14} /> AI answer</span>
        {state.status === "running" && <span className={s.aiStage}><Spinner size={12} /> {STAGE[state.stage || "searching"]}</span>}
      </header>
      {state.status === "limit" || state.status === "error" ? (
        <p className={s.aiNote}>
          {state.message}
          {state.status === "error" && onRetry && <button type="button" className={s.linkBtn} onClick={onRetry}>Try again</button>}
        </p>
      ) : (
        <div className={s.aiBody}>
          {blocks.length ? blocks.map((b, i) => {
            const lines = b.split("\n");
            if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
              return <ul key={i}>{lines.map((l, j) => <li key={j}><Inline text={l.replace(/^\s*[-*]\s+/, "")} known={known} cite={cite} /></li>)}</ul>;
            }
            return <p key={i}><Inline text={lines.join(" ")} known={known} cite={cite} /></p>;
          }) : <p className={s.aiPlaceholder}><span className={s.shimmer} /><span className={s.shimmer} style={{ width: "62%" }} /></p>}
          {state.status === "running" && blocks.length > 0 && <span className={s.caret} aria-hidden />}
        </div>
      )}
      {sources.length > 0 && (
        <ol className={s.sources} aria-label="Sources">
          {sources.map((src) => (
            <li key={src.n}>
              <button type="button" className={s.source} onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => src.url && onOpen({ url: src.url, kind: src.kind, slug: src.slug }, e.metaKey || e.ctrlKey)}>
                <span className={s.sourceN}>{src.label}</span>
                <span className={s.sourceTitle}>{src.title}</span>
                {src.where && <span className={s.sourceWhere}>{src.where}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
      {state.status === "done" && <p className={s.aiFoot}>AI can be wrong; check the sources. Only items you can open were read.</p>}
    </section>
  );
}
