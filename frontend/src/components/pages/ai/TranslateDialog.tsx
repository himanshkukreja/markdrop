"use client";

/**
 * Translate page (SPEC.md feature 8): an editor picks a language, Markdrop creates a translated
 * copy next to this page ("Title (Español)", same blocks, embeds, properties and access), and
 * this page stays as it is. Self-contained: the ⋯ menu opens it with the page's slug and title.
 *
 * The request runs on the server (POST /ai/pages/{slug}/translate). It may stream progress, by
 * section; without it the bar runs indeterminate. Nothing is written to this page.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, Icon, Input } from "@/components/ui";
import { PageAiError, translatePage, type TranslateProgress, type TranslateResult } from "@/lib/pages-ai/ask";
import "./translate.css";

/** The API's names (the same list as the Guides editor's Translate), with each in its own words. */
export const LANGUAGES: { name: string; native: string }[] = [
  { name: "Spanish", native: "Español" },
  { name: "French", native: "Français" },
  { name: "German", native: "Deutsch" },
  { name: "Portuguese", native: "Português" },
  { name: "Italian", native: "Italiano" },
  { name: "Dutch", native: "Nederlands" },
  { name: "Japanese", native: "日本語" },
  { name: "Korean", native: "한국어" },
  { name: "Chinese (Simplified)", native: "简体中文" },
  { name: "Chinese (Traditional)", native: "繁體中文" },
  { name: "Hindi", native: "हिन्दी" },
  { name: "Arabic", native: "العربية" },
  { name: "Russian", native: "Русский" },
  { name: "Ukrainian", native: "Українська" },
  { name: "Polish", native: "Polski" },
  { name: "Turkish", native: "Türkçe" },
  { name: "Indonesian", native: "Bahasa Indonesia" },
  { name: "Vietnamese", native: "Tiếng Việt" },
  { name: "Thai", native: "ไทย" },
  { name: "Bengali", native: "বাংলা" },
  { name: "Hebrew", native: "עברית" },
  { name: "Greek", native: "Ελληνικά" },
  { name: "Swedish", native: "Svenska" },
  { name: "Danish", native: "Dansk" },
  { name: "Norwegian", native: "Norsk" },
  { name: "Finnish", native: "Suomi" },
  { name: "Czech", native: "Čeština" },
  { name: "Romanian", native: "Română" },
  { name: "Hungarian", native: "Magyar" },
  { name: "Malay", native: "Bahasa Melayu" },
  { name: "English", native: "English" },
];

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

type Phase =
  | { kind: "pick" }
  | { kind: "running"; progress: TranslateProgress }
  | { kind: "done"; result: TranslateResult }
  | { kind: "error"; message: string; limit: boolean };

export interface TranslateDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  title: string | null;
  /** The copy exists (e.g. to refresh the page tree). */
  onCreated?: (result: TranslateResult) => void;
}

export function TranslateDialog({ open, onClose, slug, title, onCreated }: TranslateDialogProps) {
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const ctrl = useRef<AbortController | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: "pick" });
    setQuery("");
  }, [open]);
  useEffect(() => () => ctrl.current?.abort(), []);

  const shown = useMemo(() => {
    const q = fold(query.trim());
    return q ? LANGUAGES.filter((l) => fold(l.name).includes(q) || fold(l.native).includes(q)) : LANGUAGES;
  }, [query]);
  const picked = LANGUAGES.find((l) => l.name === lang) ?? null;
  const pageTitle = title?.trim() || "Untitled";

  const run = async () => {
    if (!picked) return;
    const c = new AbortController();
    ctrl.current = c;
    setPhase({ kind: "running", progress: {} });
    try {
      const result = await translatePage(slug, picked.name, (p) => setPhase({ kind: "running", progress: p }), c.signal);
      setPhase({ kind: "done", result });
      onCreated?.(result);
    } catch (e) {
      if (c.signal.aborted) return;
      setPhase({ kind: "error", message: e instanceof PageAiError ? e.message : "The translation failed. Try again.", limit: e instanceof PageAiError && !!e.reason });
    } finally {
      if (ctrl.current === c) ctrl.current = null;
    }
  };

  // ↑/↓ move through the list from the search field; Enter translates the one picked.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    e.preventDefault();
    if (e.key === "Enter") {
      if (picked && shown.includes(picked)) void run();
      else if (shown[0]) setLang(shown[0].name);
      return;
    }
    const at = shown.findIndex((l) => l.name === lang);
    const next = shown[Math.max(0, Math.min(shown.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    setLang(next.name);
    list.current?.querySelector<HTMLElement>(`[data-lang="${CSS.escape(next.name)}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const running = phase.kind === "running";
  const copyTitle = phase.kind === "done" ? phase.result.title?.trim() || `${pageTitle} (${picked?.native ?? ""})` : null;
  const p = phase.kind === "running" ? phase.progress : null;
  const pct = p?.total ? Math.max(4, Math.min(100, Math.round(((p.done ?? 0) / p.total) * 100))) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!running}
      hideClose={running}
      size="md"
      className="pt-dialog"
      glyph={<Icon name="globe" />}
      title={phase.kind === "done" ? "Translated" : "Translate page"}
      description={
        phase.kind === "done"
          ? undefined
          : `Creates a translated copy next to “${pageTitle}”, with the same blocks and access. This page doesn't change.`
      }
      initialFocus={phase.kind === "pick" ? search : undefined}
      footer={
        phase.kind === "pick" ? (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => void run()} disabled={!picked} iconLeft="sparkle">
              {picked ? `Translate to ${picked.native}` : "Translate"}
            </Button>
          </>
        ) : phase.kind === "running" ? null : phase.kind === "done" ? (
          <>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button href={`/${encodeURIComponent(phase.result.slug)}`} iconRight="arrowRight" onClick={onClose}>Open the copy</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            {!phase.limit && <Button onClick={() => void run()} iconLeft="refresh">Try again</Button>}
          </>
        )
      }
    >
      {phase.kind === "pick" && (
        <div className="pt-pick">
          <Input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search languages"
            aria-label="Search languages"
            aria-controls="pt-langs"
            iconPrefix="search"
          />
          <div ref={list} id="pt-langs" className="pt-langs" role="listbox" aria-label="Language">
            {shown.length === 0 && <p className="pt-none">No language matches “{query}”.</p>}
            {shown.map((l) => {
              const on = l.name === lang;
              return (
                <button
                  key={l.name}
                  type="button"
                  role="option"
                  aria-selected={on}
                  data-lang={l.name}
                  className="pt-lang"
                  onClick={() => setLang(l.name)}
                >
                  <span className="pt-lang__native" lang="" dir="auto">{l.native}</span>
                  {l.native !== l.name && <span className="pt-lang__name">{l.name}</span>}
                  <Icon name="check" className="pt-lang__check" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {phase.kind === "running" && (
        <div className="pt-run" role="status" aria-live="polite">
          <div className="pt-run__lang">
            <span className="pt-run__glyph" aria-hidden><Icon name="sparkle" /></span>
            <div>
              <p className="pt-run__title">Translating into {picked?.native}…</p>
              <p className="pt-run__sub">
                {p?.total ? `Section ${Math.min((p.done ?? 0) + 1, p.total)} of ${p.total}` : "Text only: blocks, embeds, links and code stay exactly as they are."}
              </p>
            </div>
          </div>
          <div className={`pt-bar${pct === null ? " pt-bar--indeterminate" : ""}`} role="progressbar" aria-label="Translation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <span style={pct === null ? undefined : { transform: `scaleX(${pct / 100})` }} />
          </div>
          <p className="pt-run__hint">A long page can take a minute. Keep this open until it&apos;s done.</p>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="pt-done">
          <span className="pt-done__glyph" aria-hidden><Icon name="check" /></span>
          <p className="pt-done__title">
            Created <strong className="ph-mask">“{copyTitle}”</strong>
          </p>
          <p className="pt-done__sub">It sits next to this page, with the same access. Check the translation before you share it: AI can make mistakes.</p>
        </div>
      )}

      {phase.kind === "error" && (
        <div className={`pt-error${phase.limit ? " pt-error--limit" : ""}`} role="alert">
          <Icon name={phase.limit ? "clock" : "alertCircle"} className="pt-error__icon" />
          <p>{phase.message}</p>
        </div>
      )}
    </Dialog>
  );
}

export default TranslateDialog;
