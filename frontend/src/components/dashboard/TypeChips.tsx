"use client";

/**
 * The file type filter (lib/fileTypes) as a row of pill chips with counts — My files, Shared with
 * me, Recent and workspace folders. On a narrow screen the row scrolls sideways (never the page),
 * with a soft edge on the side that has more, and the selected chip is scrolled into view. Touch
 * screens get 44 px chips (ui/touch.css). `useTypeFilter` keeps the choice in the URL (?type=) and
 * remembers it per view on this device.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Tabs } from "@/components/ui";
import { useLocationSearch, useMounted } from "@/components/shell/useLocation";
import { track } from "@/lib/track";
import {
  TYPE_META, countFor, readRememberedType, readTypeParam, rememberType, shouldRestoreType, visibleTypeChips,
  type FileType, type TypeFilter,
} from "@/lib/fileTypes";
import styles from "./dashboard.module.css";

export type ByType = Partial<Record<FileType, number>>;

export interface TypeChipCounts {
  /** All (defaults to the sum of `byType`). */
  all?: number;
  /** "All files" (an old ?kind=artifact link on My files). */
  artifact?: number;
  /** Per type; "unknown" from an older server (every type gets a chip, without a number). */
  byType: ByType | "unknown";
}

export function TypeChips({ value, counts, onChange, className }: {
  value: TypeFilter;
  /** null until the counts arrive. */
  counts: TypeChipCounts | null;
  onChange: (f: TypeFilter) => void;
  className?: string;
}) {
  const byType = counts ? counts.byType : null;
  const known = byType && byType !== "unknown" ? byType : null;
  const all = counts ? counts.all ?? (known ? Object.values(known).reduce<number>((n, x) => n + (x ?? 0), 0) : undefined) : undefined;
  const items = visibleTypeChips(value, byType).map((t) => ({
    value: t,
    label: TYPE_META[t].chip,
    count: t === "all" ? all
      : t === "files" ? counts?.artifact
      : known ? countFor(t, { all: all ?? 0, artifact: counts?.artifact ?? 0, byType: known }) : undefined,
  }));

  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ start: false, end: false });
  const row = () => ref.current?.querySelector<HTMLElement>('[role="tablist"]') ?? null;
  const measure = useCallback(() => {
    const el = row();
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdge((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, []);
  useEffect(() => {
    const el = row();
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", measure); ro?.disconnect(); };
  }, [measure]);
  useEffect(() => {
    const el = row();
    const on = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && on) {
      // Only the row scrolls (scrollIntoView would move the page too).
      const left = on.offsetLeft - el.offsetLeft;
      if (left < el.scrollLeft || left + on.offsetWidth > el.scrollLeft + el.clientWidth) {
        el.scrollTo({ left: Math.max(0, left - 24) });
      }
    }
    measure();
  }, [value, items.length, measure]);

  return (
    <div ref={ref} className={[styles.typeChips, className].filter(Boolean).join(" ")} data-more-start={edge.start || undefined} data-more-end={edge.end || undefined} data-testid="type-chips">
      <Tabs variant="pill" size="sm" aria-label="File type" items={items} value={value} onChange={(v) => onChange(v as TypeFilter)} className="max-w-full min-w-0" />
    </div>
  );
}

/**
 * ?type= for a list that isn't My files (Shared with me, Recent, a folder): the selected type, a
 * setter (URL replace + remembered for `view`), and `ready` once a remembered type has been put
 * back on a bare visit — load after it, so the list doesn't load "All" first.
 */
export function useTypeFilter(view: string | null): { type: "all" | FileType; setType: (f: TypeFilter) => void; ready: boolean } {
  const router = useRouter();
  const mounted = useMounted();
  const search = useLocationSearch();
  const urlReady = mounted && typeof window !== "undefined" && search === window.location.search;
  const type = readTypeParam(new URLSearchParams(search));
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  const [pending, setPending] = useState<FileType | null>(null);

  const replace = useCallback((t: "all" | FileType) => {
    const p = new URLSearchParams(window.location.search);
    if (t === "all") p.delete("type");
    else p.set("type", t);
    const qs = p.toString();
    router.replace(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [router]);

  useEffect(() => {
    if (!urlReady || !view || restoredFor === view) return;
    const t = readRememberedType(storage(), view);
    if (t && shouldRestoreType(new URLSearchParams(window.location.search))) {
      setPending(t);
      replace(t);
    } else {
      setPending(null);
    }
    setRestoredFor(view);
  }, [urlReady, view, restoredFor, replace]);

  const setType = useCallback((f: TypeFilter) => {
    const t = f === "files" ? "all" : f;
    setPending(null);
    if (view) rememberType(storage(), t, view);
    track("files_type_filter", { type: t, view: view?.split(":")[0] ?? "" });
    replace(t);
  }, [view, replace]);

  // Ready once the restore ran for this view and the URL shows its result.
  const ready = urlReady && !!view && restoredFor === view && (!pending || type === pending);
  return { type, setType, ready };
}

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
