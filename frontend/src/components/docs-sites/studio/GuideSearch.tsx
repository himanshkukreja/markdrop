"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Dialog, Icon, IconButton, Kbd, cx } from "@/components/ui";
import type { SiteSummary } from "@/lib/docsSites";
import { SiteTile } from "../SiteBar";
import { siteBase } from "../routes";
import { addressOf, matches, stateOf, touched } from "../home/model";
import { useStudio } from "./StudioContext";

const MAX = 8;

/** Typing in a field, or in the editor (its own ⌘K adds a link): leave the shortcut to it. */
function editable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !el.dataset.guideSearch);
}

/** The matching guides, newest first, and the combobox wiring around an input. */
function useResults(query: string) {
  const { all } = useStudio();
  return useMemo(() => {
    const sites = [...(all?.sites ?? [])].sort((a, b) => touched(b) - touched(a));
    const hits = sites.filter((s) => matches(s, query));
    return { hits: hits.slice(0, MAX), more: Math.max(0, hits.length - MAX), loaded: !!all };
  }, [all, query]);
}

function ResultRow({ site, active, id, onPick }: { site: SiteSummary; active: boolean; id: string; onPick: () => void }) {
  const st = stateOf(site);
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={cx("flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2", active ? "bg-surface-active" : "hover:bg-surface-hover")}
    >
      <SiteTile site={site} size={26} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="ph-sensitive ph-mask truncate text-body-strong text-text" dir="auto" title={site.name}>{site.name}</span>
        <span className="ph-sensitive ph-mask truncate font-mono text-[12px] leading-4 text-text-muted" title={addressOf(site)}>{addressOf(site)}</span>
      </span>
      <Badge tone={st.tone} size="sm" dot>{st.label}</Badge>
    </li>
  );
}

/** The results under the field (a listbox), or what to say when there are none. */
function Results({ listId, query, hits, more, loaded, active, optionId, onPick, className }: {
  listId: string; query: string; hits: SiteSummary[]; more: number; loaded: boolean; active: number;
  optionId: (i: number) => string; onPick: (s: SiteSummary) => void; className?: string;
}) {
  return (
    <div className={cx("ph-no-capture", className)}>
      {hits.length > 0 ? (
        <ul id={listId} role="listbox" aria-label="Guides" className="flex flex-col gap-0.5">
          {hits.map((s, i) => <ResultRow key={s.id} site={s} id={optionId(i)} active={i === active} onPick={() => onPick(s)} />)}
        </ul>
      ) : (
        <p id={listId} className="px-2.5 py-3 text-body text-text-muted">
          {!loaded ? "Loading your guides…" : query.trim() ? <>No guide matches <span className="ph-sensitive ph-mask">“{query.trim()}”</span>.</> : "No guides yet."}
        </p>
      )}
      {more > 0 && <p className="px-2.5 pb-1 pt-2 text-caption text-text-muted">{more} more: keep typing to narrow it down.</p>}
    </div>
  );
}

/**
 * Search guides in the studio header: a field on tablets and up (⌘K / Ctrl+K focuses it), a search
 * button opening the same search in a dialog on phones. Matches each guide you can open by its
 * name and addresses (client side, over the listing the studio already has) and opens its editor.
 */
export function GuideSearch({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialogInput = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const { hits, more, loaded } = useResults(query);
  // The field's list and the dialog's are separate elements: separate ids.
  const ids = (where: "f" | "d") => ({ listId: `${uid}-${where}-list`, optionId: (i: number) => `${uid}-${where}-opt-${i}` });
  const [mac, setMac] = useState(true);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      if (e.defaultPrevented || editable(e.target)) return;
      e.preventDefault();
      const field = input.current;
      if (field && field.offsetParent !== null) {
        field.focus();
        field.select();
        setOpen(true);
      } else {
        setDialog(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => setActive(0), [query]);

  const pick = (s: SiteSummary) => {
    setOpen(false);
    setDialog(false);
    setQuery("");
    input.current?.blur();
    router.push(siteBase(s.id));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (hits.length ? (i + 1) % hits.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0));
    } else if (e.key === "Enter") {
      const s = hits[active];
      if (s) {
        e.preventDefault();
        pick(s);
      }
    } else if (e.key === "Escape") {
      if (query) setQuery("");
      else {
        setOpen(false);
        e.currentTarget.blur();
      }
    }
  };

  const combo = (ref: React.RefObject<HTMLInputElement | null>, expanded: boolean, where: "f" | "d") => {
    const { listId, optionId } = ids(where);
    return {
    ref,
    role: "combobox" as const,
    "aria-expanded": expanded,
    "aria-controls": listId,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant": expanded && hits[active] ? optionId(active) : undefined,
    "aria-label": "Search guides",
    placeholder: "Search guides",
    autoComplete: "off",
    spellCheck: false,
    value: query,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setQuery(e.target.value); setOpen(true); },
    onKeyDown,
    className: "ph-no-capture min-w-0 flex-1 border-0 bg-transparent text-body text-text outline-none placeholder:text-text-muted",
    };
  };

  return (
    <>
      <div
        ref={wrap}
        className={cx("relative hidden md:block", compact ? "w-[200px] xl:w-[240px]" : "w-[220px] lg:w-[280px]")}
        onBlur={(e) => { if (!wrap.current?.contains(e.relatedTarget as Node)) setOpen(false); }}
      >
        <label className="flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-surface-inset px-2.5 text-text-muted focus-within:border-border-focus focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-border-focus">
          <Icon name="search" size={16} className="shrink-0" />
          <input {...combo(input, open, "f")} data-guide-search="1" onFocus={() => setOpen(true)} />
          {!query && <Kbd className="shrink-0">{mac ? "⌘K" : "Ctrl K"}</Kbd>}
        </label>
        {open && (
          <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[min(420px,calc(100vw-32px))] rounded-xl border border-border bg-surface p-1.5 shadow-lg">
            <Results {...ids("f")} query={query} hits={hits} more={more} loaded={loaded} active={active} onPick={pick} />
          </div>
        )}
      </div>
      <IconButton icon="search" label="Search guides" className="md:hidden" aria-haspopup="dialog" onClick={() => setDialog(true)} />
      <Dialog open={dialog} onClose={() => { setDialog(false); setQuery(""); }} title="Search guides" initialFocus={dialogInput} size="md">
        <div className="flex flex-col gap-3">
          <label className="flex h-11 items-center gap-2 rounded-lg border border-border-strong bg-surface-inset px-3 text-text-muted focus-within:border-border-focus">
            <Icon name="search" size={16} className="shrink-0" />
            <input {...combo(dialogInput, dialog, "d")} data-guide-search="1" />
          </label>
          <Results {...ids("d")} query={query} hits={hits} more={more} loaded={loaded} active={active} onPick={pick} className="max-h-[60dvh] overflow-y-auto" />
        </div>
      </Dialog>
    </>
  );
}

export default GuideSearch;
