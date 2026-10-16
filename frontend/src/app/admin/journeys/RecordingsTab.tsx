"use client";

import { useEffect, useState } from "react";
import { Button, Input, Progress } from "@/components/ui";
import { notConfigured, useJourneys, type NotConfigured, type RecordingsRes } from "./api";
import { DaysPicker, FilterChips, PhErrorState, SkeletonRows, pageName, useDays, useNav } from "./bits";
import { RecordingList } from "./RecordingList";
import { SetupCard } from "./SetupCard";

const PAGE = 50;

/**
 * Recordings: every session replay in the window, newest first, 50 a page. Filter by a page the
 * session visited (`?path=`, an app route or a document) or by person (`?who=`).
 */
export function RecordingsTab({ token }: { token: string }) {
  const { state, go } = useNav();
  const { days } = useDays("7d");
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState(state.path && !state.path.startsWith("doc:") ? state.path : "");

  useEffect(() => setPage(0), [state.path, state.who, days]);
  useEffect(() => setDraft(state.path && !state.path.startsWith("doc:") ? state.path : ""), [state.path]);

  const { data, error, loading, refresh } = useJourneys<RecordingsRes | NotConfigured>(token, "/recordings", {
    days,
    offset: page * PAGE,
    path: state.path || undefined,
    person: state.who || undefined,
  });
  if (notConfigured(data)) return <SetupCard status={data.status} compact />;
  const res = data as RecordingsRes | undefined;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    go({ path: v ? (v.startsWith("/") || v.startsWith("doc:") ? v : `/${v}`) : null }, false);
  };

  const chips = [
    ...(state.who ? [{ key: "who", label: `person: ${state.who.slice(-8)}`, onRemove: () => go({ who: null }, false) }] : []),
    ...(state.path
      ? [{
          key: "path",
          label: `page: ${res?.filter_page ? pageName(res.filter_page) : state.path}`,
          onRemove: () => { setDraft(""); go({ path: null }, false); },
        }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={submit} className="flex w-full min-w-0 sm:w-auto" role="search" aria-label="Filter recordings by page">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Visited page, e.g. /new"
            aria-label="Filter by page path"
            prefix="filter"
            wrapClassName="min-w-0 flex-1 sm:w-64 sm:flex-none"
            className="font-mono"
          />
          <Button type="submit" variant="secondary" className="ml-2">Filter</Button>
        </form>
        <DaysPicker fallback="7d" />
      </div>
      <FilterChips chips={chips} onClearAll={() => { setDraft(""); go({ path: null, who: null }, false); }} />
      {state.path?.startsWith("doc:") && (
        <p className="font-mono text-micro text-text-muted">Sessions that opened this document. The document itself is never recorded: the replay pauses while it&apos;s on screen.</p>
      )}
      {loading && res && <Progress indeterminate size="sm" aria-label="Updating recordings" valueText="Loading" />}

      {error && !res ? (
        <PhErrorState error={error} onRetry={refresh} />
      ) : !res ? (
        <SkeletonRows n={6} height={74} label="Loading recordings" />
      ) : (
        <RecordingList
          token={token}
          recordings={res.recordings}
          empty={state.path ? `No recordings that visited ${res.filter_page ? pageName(res.filter_page) : state.path}` : "No recordings in this window"}
        />
      )}

      {res && (page > 0 || res.has_next) && (
        <nav aria-label="Recordings pages" className="flex items-center justify-between gap-3">
          <Button size="sm" variant="secondary" iconLeft="arrowLeft" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>Newer</Button>
          <span className="font-mono text-caption text-text-secondary">page {page + 1}</span>
          <Button size="sm" variant="secondary" iconRight="arrowRight" disabled={!res.has_next || loading} onClick={() => setPage((p) => p + 1)}>Older</Button>
        </nav>
      )}
    </div>
  );
}
