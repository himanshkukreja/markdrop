"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, EmptyState, Icon, Input, Progress, SegmentedControl, cx } from "@/components/ui";
import { LoadingBlock } from "../shared";
import { notConfigured, useJourneys, type NotConfigured, type PeopleRes, type PersonRow } from "./api";
import {
  DaysPicker, NavLink, PhErrorState, StaleNotice, Who, WhoDot, countryFlag, fmtDate, fmtNum, pageName, place, plural, timeAgo, useDays, useNav,
  useNow,
} from "./bits";
import { SetupCard } from "./SetupCard";

type SortKey = "who" | "last" | "first" | "sessions" | "pv" | "where";
const KINDS = [
  { value: "all", label: "Everyone" },
  { value: "identified", label: "Signed in" },
  { value: "anonymous", label: "Anonymous" },
] as const;

const whoOf = (p: PersonRow) => p.email || p.name || `anon ${(p.distinct_id || p.id).slice(-6)}`;

const SORTS: Record<SortKey, (p: PersonRow) => string | number> = {
  who: (p) => (p.email || p.name || `~${p.distinct_id ?? p.id}`).toLowerCase(),
  last: (p) => p.last_seen,
  first: (p) => p.first_seen ?? "",
  sessions: (p) => p.sessions,
  pv: (p) => p.pageviews,
  where: (p) => `${p.country ?? "~"}${p.city ?? ""}`,
};

/**
 * People: everyone with activity in the window (up to 300, most recent first), searchable by
 * email, name, id, city or country, and filterable by signed in or anonymous. A row opens the
 * person's journey.
 */
export function PeopleTab({ token }: { token: string }) {
  const { state, go } = useNav();
  const now = useNow(60_000);
  const { days } = useDays("30d");
  const [draft, setDraft] = useState(state.q);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Back/forward or a chip can change ?q under us.
  useEffect(() => setDraft(state.q), [state.q]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onSearch = (v: string) => {
    setDraft(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go({ q: v.trim() || null }, false), 350);
  };

  const { data, error, loading, refresh, stale } = useJourneys<PeopleRes | NotConfigured>(token, "/people", { days, kind: state.kind, q: state.q || undefined });
  const res = notConfigured(data) ? undefined : (data as PeopleRes | undefined);

  const rows = useMemo(() => {
    const list = res?.people ?? [];
    if (!sort) return list;
    const f = SORTS[sort.key];
    const out = [...list].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return sort.dir === "desc" ? out.reverse() : out;
  }, [res, sort]);

  if (notConfigured(data)) return <SetupCard status={data.status} compact />;

  const identified = res?.people.filter((p) => p.identified).length ?? 0;
  const anon = (res?.people.length ?? 0) - identified;
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: key === "who" || key === "where" ? "asc" : "desc" }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={draft}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Email, name, id, city…"
          aria-label="Search people"
          prefix="search"
          wrapClassName="w-full sm:w-72"
        />
        <SegmentedControl
          aria-label="Who"
          value={state.kind}
          onChange={(v) => go({ kind: v === "all" ? null : v }, false)}
          options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
        <DaysPicker fallback="30d" />
      </div>

      {res && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-caption text-text-secondary" aria-live="polite">
          <span>
            {fmtNum(res.people.length)}{res.capped ? "+" : ""} {res.people.length === 1 ? "person" : "people"} · last {days === 1 ? "24 h" : `${days} days`}
          </span>
          <Badge size="sm" tone="info">{fmtNum(identified)} signed in</Badge>
          <Badge size="sm" tone="neutral">{fmtNum(anon)} anonymous</Badge>
        </div>
      )}
      {loading && res && <Progress indeterminate size="sm" aria-label="Updating people" valueText="Loading" />}
      <StaleNotice stale={stale} error={res ? error : null} />

      {error && !res ? (
        <PhErrorState error={error} onRetry={refresh} />
      ) : !res ? (
        <LoadingBlock size="md" label="Loading people" minHeight={360} />
      ) : (
        <>
          {/* Wide screens: a dense, sortable table. */}
          <div className="hidden md:block">
            <div className="md-table-wrap">
              <table className="md-table md-table--compact md-table--hover min-w-225">
                <caption className="md-visually-hidden">People, most recently active first</caption>
                <thead>
                  <tr>
                    <Th k="who" sort={sort} onSort={toggleSort}>Person</Th>
                    <Th k="last" sort={sort} onSort={toggleSort}>Last seen</Th>
                    <Th k="first" sort={sort} onSort={toggleSort}>First seen</Th>
                    <Th k="sessions" sort={sort} onSort={toggleSort} right>Sessions</Th>
                    <Th k="pv" sort={sort} onSort={toggleSort} right>Pages</Th>
                    <Th k="where" sort={sort} onSort={toggleSort}>Where · device</Th>
                    <th scope="col">Top pages</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={7} className="md-table__empty">{state.q ? `Nobody matches “${state.q}”` : "No visitors in this window"}</td></tr>
                  )}
                  {rows.map((p) => (
                    <tr key={p.id} onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) go({ person: p.id }, true); }} className="cursor-pointer">
                      <td className="max-w-65">
                        <Who who={whoOf(p)} identified={p.identified} personId={p.id} />
                        {p.name && p.email && <p className="truncate pl-3.5 text-micro text-text-muted" dir="auto">{p.name}</p>}
                      </td>
                      <td className="whitespace-nowrap font-mono text-caption text-text" title={fmtDate(p.last_seen, true)}>{timeAgo(p.last_seen, now)}</td>
                      <td className="whitespace-nowrap font-mono text-caption" title={fmtDate(p.first_seen, true)}>{timeAgo(p.first_seen, now)}</td>
                      <td className="md-td--num">{fmtNum(p.sessions)}</td>
                      <td className="md-td--num">{fmtNum(p.pageviews)}</td>
                      <td className="max-w-50">
                        <p className="truncate text-caption text-text">{place(p.city, p.country)}</p>
                        <p className="truncate font-mono text-micro text-text-muted">{[p.device, p.browser].filter(Boolean).join(" · ").toLowerCase() || "—"}</p>
                      </td>
                      <td className="w-58 max-w-58">
                        {p.top_pages.length ? (
                          <ul className="flex flex-col">
                            {p.top_pages.slice(0, 3).map((pg) => (
                              <li key={pg.key} className="truncate font-mono text-micro text-text-secondary" title={pageName(pg)}>{pageName(pg)}</li>
                            ))}
                          </ul>
                        ) : <span className="text-text-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phones: cards. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.length === 0
                ? <li><EmptyState icon="users" title={state.q ? "Nobody matches" : "No visitors in this window"} description={state.q ? `Nothing for “${state.q}”. Try an email, a city or a country code.` : undefined} /></li>
                : rows.map((p) => (
                    <li key={p.id}>
                      <NavLink to={{ person: p.id }} className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface p-3 hover:bg-surface-hover">
                        <span className="flex min-w-0 items-center justify-between gap-3">
                          <span className={cx("inline-flex min-w-0 items-center gap-1.5 font-mono text-caption", p.identified ? "text-text" : "text-text-secondary")}>
                            <WhoDot identified={p.identified} />
                            <span className="truncate">{whoOf(p)}</span>
                          </span>
                          <span className="shrink-0 font-mono text-micro text-text-muted">{timeAgo(p.last_seen, now)}</span>
                        </span>
                        <span className="truncate font-mono text-micro text-text-secondary">
                          {plural(p.sessions, "session")} · {plural(p.pageviews, "page")} · {countryFlag(p.country)} {p.city || p.country || "unknown"}
                        </span>
                        {p.top_pages.length > 0 && (
                          <span className="truncate font-mono text-micro text-text-muted">{p.top_pages.slice(0, 2).map(pageName).join("  ·  ")}</span>
                        )}
                      </NavLink>
                    </li>
                  ))}
          </ul>
        </>
      )}

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-micro text-text-muted">
        <span className="inline-flex items-center gap-1.5"><WhoDot identified />signed in (their Markdrop account)</span>
        <span className="inline-flex items-center gap-1.5"><WhoDot identified={false} />anonymous visitor</span>
        <span className="inline-flex items-center gap-1.5"><Icon name="info" size={12} />only visitors who accepted analytics appear by person</span>
      </p>
    </div>
  );
}

function Th({ k, sort, onSort, right, children }: {
  k: SortKey; sort: { key: SortKey; dir: "asc" | "desc" } | null; onSort: (k: SortKey) => void; right?: boolean; children: React.ReactNode;
}) {
  const on = sort?.key === k;
  return (
    <th scope="col" aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"} style={right ? { textAlign: "right" } : undefined}>
      <button type="button" onClick={() => onSort(k)} className={cx("md-focus -mx-1 inline-flex items-center gap-1 rounded-sm px-1 uppercase hover:text-text", on && "text-text")}>
        {children}
        <span aria-hidden className="font-mono">{on ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}
