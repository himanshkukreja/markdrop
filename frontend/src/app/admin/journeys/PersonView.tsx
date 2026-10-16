"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Icon, SegmentedControl, Skeleton, cx } from "@/components/ui";
import StatTile from "@/components/kit/StatTile";
import { notConfigured, useJourneys, type Kind, type NotConfigured, type PersonRes, type Recording, type TimelineEvent } from "./api";
import {
  DaysPicker, DocLink, eventDetail, ExtLink, Field, KindMark, NavLink, Panel, PhErrorState, clock, dayKey, dayLabel, fmtDate, fmtNum, hhmm, labelClass,
  pageName, place, timeAgo, useDays, useNav, useNow,
} from "./bits";
import { RecordingList } from "./RecordingList";
import { ReplayPlayer } from "./ReplayPlayer";
import { SetupCard } from "./SetupCard";

const FILTERS: { id: string; label: string; kinds: Kind[] | null }[] = [
  { id: "all", label: "Everything", kinds: null },
  { id: "key", label: "Key moments", kinds: ["pageview", "read", "publish", "share", "export", "connect", "signin", "cta", "play", "error", "rage"] },
  { id: "create", label: "Creating & reading", kinds: ["publish", "read", "share", "export", "connect"] },
];

type SessionBlock = { id: string; start: string; end: string; events: TimelineEvent[]; recording: Recording | null };
type DayBlock = { key: string; first: string; sessions: SessionBlock[] };

/** Events newest-first → days (newest first) → sessions (newest first), events oldest-first in a session. */
function group(events: TimelineEvent[], recs: Map<string, Recording>): DayBlock[] {
  const days: DayBlock[] = [];
  let day: DayBlock | null = null;
  let session: SessionBlock | null = null;
  for (const e of events) {
    const dk = dayKey(e.t);
    if (!day || day.key !== dk) {
      day = { key: dk, first: e.t, sessions: [] };
      days.push(day);
      session = null;
    }
    const sid = e.session || "no-session";
    if (!session || session.id !== sid) {
      session = { id: sid, start: e.t, end: e.t, events: [], recording: recs.get(sid) ?? null };
      day.sessions.push(session);
    }
    session.events.push(e);
    session.start = e.t; // descending input: the last one seen is the earliest
  }
  for (const d of days) for (const s of d.sessions) s.events.reverse();
  return days;
}

/**
 * One person's journey: who they are, then everything they did, by day and session (documents by
 * title, clicks by element text, reading, publishing, sharing, sign-in), a Watch button per
 * session that plays its replay inline, and their recordings.
 */
export function PersonView({ token, id }: { token: string; id: string }) {
  const { days } = useDays("30d");
  const now = useNow();
  const [filter, setFilter] = useState("key");
  const [watching, setWatching] = useState<string | null>(null);
  const { data, error, refresh } = useJourneys<PersonRes | NotConfigured>(token, "/person", { id, days });
  const res = notConfigured(data) ? undefined : (data as PersonRes | undefined);

  const recs = useMemo(() => new Map((res?.recordings ?? []).map((r) => [r.id, r])), [res]);
  const blocks = useMemo(() => {
    if (!res) return [];
    const kinds = FILTERS.find((f) => f.id === filter)?.kinds;
    return group(kinds ? res.events.filter((e) => kinds.includes(e.kind)) : res.events, recs);
  }, [res, filter, recs]);

  if (notConfigured(data)) return <SetupCard status={data.status} />;
  if (error && !res) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <PhErrorState error={error} onRetry={refresh} title={error.status === 404 ? "No PostHog events for this person" : "Couldn't load this journey"} />
      </div>
    );
  }
  if (!res) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <BackLink />
        <span className="md-visually-hidden">Loading this journey</span>
        <Skeleton variant="rect" height={144} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="rect" height={88} />)}</div>
        <Skeleton variant="rect" height={384} />
      </div>
    );
  }

  const p = res.person;
  const sessions = new Set(res.events.map((e) => e.session).filter(Boolean)).size;
  const pageviews = res.events.filter((e) => e.kind === "pageview").length;
  const name = p.name || p.email || `Visitor ${(p.distinct_id || p.id).slice(-6)}`;

  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      <section className="rounded-xl border border-border bg-surface" aria-labelledby="journey-person">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {p.identified ? <Badge size="sm" tone="info" dot>signed in</Badge> : <Badge size="sm" tone="neutral">anonymous</Badge>}
              <span className="font-mono text-micro text-text-muted" title={p.id}>#{p.id.slice(-12)}</span>
            </div>
            <h1 id="journey-person" className="mt-1.5 break-words text-h1 text-text" dir="auto">{name}</h1>
            {p.name && p.email && <p className="font-mono text-caption text-text-secondary">{p.email}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DaysPicker fallback="30d" size="sm" />
            <ExtLink href={p.app_url}>PostHog person</ExtLink>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="First seen" title={fmtDate(p.created_at, true)}>{p.created_at ? `${fmtDate(p.created_at)} · ${timeAgo(p.created_at, now)}` : "—"}</Field>
          <Field label="Last seen">{res.events[0] ? timeAgo(res.events[0].t, now) : "—"}</Field>
          <Field label="Where">{place(p.city, p.country)}</Field>
          <Field label="Device">{[p.device, p.os].filter(Boolean).join(" · ") || "—"}</Field>
          <Field label="Browser">{p.browser || "—"}</Field>
          <Field label="First referrer">{p.referrer || "—"}</Field>
        </dl>
        {p.account && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-2.5 text-caption text-text-secondary">
            <Icon name="user" size={14} className="text-text-muted" />
            <span>Markdrop account since {fmtDate(p.account.created_at)}</span>
            <span aria-hidden className="text-text-muted">·</span>
            <span>{fmtNum(p.account.documents)} {p.account.documents === 1 ? "document" : "documents"}</span>
          </p>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile size="md" label="Sessions" value={fmtNum(sessions)} caption={`last ${days === 1 ? "24 h" : `${days} days`}`} />
        <StatTile size="md" label="Pages viewed" value={fmtNum(pageviews)} />
        <StatTile size="md" label="Events" value={`${fmtNum(res.events.length)}${res.truncated ? "+" : ""}`} />
        <StatTile size="md" label="Recordings" value={fmtNum(res.recordings.length)} />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel
          eyebrow="Timeline"
          title="What they did"
          titleId="journey-timeline"
          pad={false}
          action={<SegmentedControl size="sm" aria-label="Show" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.id, label: f.label }))} />}
        >
          {blocks.length ? (
            <div className="flex flex-col">
              {blocks.map((d) => {
                const label = dayLabel(d.first, now);
                return (
                  <section key={d.key} aria-label={label} className="border-b border-border last:border-0">
                    <h3 className="sticky top-14 z-10 border-b border-border bg-surface/95 px-4 py-2 text-eyebrow uppercase text-text-muted backdrop-blur lg:top-0">
                      {label}{label === "Today" || label === "Yesterday" ? ` · ${fmtDate(d.first)}` : ""}
                    </h3>
                    <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
                      {d.sessions.map((s, si) => {
                        const k = `${d.key}:${s.id}:${si}`;
                        return <SessionCard key={k} token={token} s={s} watching={watching === k} onWatch={(on) => setWatching(on ? k : null)} />;
                      })}
                    </div>
                  </section>
                );
              })}
              {res.truncated && (
                <p className="border-t border-border px-4 py-3 font-mono text-micro text-text-muted">showing the latest 1,500 events · narrow the range to see older ones</p>
              )}
            </div>
          ) : (
            <p className="px-4 py-10 text-center font-mono text-caption text-text-muted">Nothing in this window{filter !== "all" ? " for this filter" : ""}.</p>
          )}
        </Panel>

        <Panel
          eyebrow="Session replays"
          title={`Recordings (${res.recordings.length})`}
          action={res.recordings.length ? (
            <NavLink to={{ jt: "recordings", who: p.id, person: null, path: null }} className="font-mono text-micro text-text-secondary hover:text-accent-text hover:underline">
              all →
            </NavLink>
          ) : undefined}
        >
          {res.recordings_error ? (
            <PhErrorState error={res.recordings_error.error} scope={res.recordings_error.scope} onRetry={refresh} />
          ) : (
            <RecordingList token={token} recordings={res.recordings} showWho={false} empty="No recordings for this person" />
          )}
        </Panel>
      </div>
    </div>
  );
}

function SessionCard({ token, s, watching, onWatch }: { token: string; s: SessionBlock; watching: boolean; onWatch: (on: boolean) => void }) {
  const dur = (new Date(s.end).getTime() - new Date(s.start).getTime()) / 1000;
  return (
    <div className={cx("min-w-0 rounded-lg border bg-bg transition-colors", watching ? "border-accent" : "border-border")}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-1.5 pl-3 pr-1.5">
        <p className="min-w-0 font-mono text-micro text-text-secondary">
          <span className="text-text">session</span> · {hhmm(s.start)} → {hhmm(s.end)} · {clock(dur)} · {s.events.length} event{s.events.length === 1 ? "" : "s"}
        </p>
        {s.recording ? (
          <Button
            size="sm"
            variant="secondary"
            className={watching ? "border-accent text-accent-text" : undefined}
            iconLeft={watching ? "stop" : "play"}
            aria-expanded={watching}
            onClick={() => onWatch(!watching)}
          >
            {watching ? "Close" : `Watch · ${clock(s.recording.duration)}`}
          </Button>
        ) : (
          <span className="px-1.5 py-1.5 font-mono text-micro text-text-muted">{s.id === "no-session" ? "no session id" : "no replay"}</span>
        )}
      </div>
      {watching && s.recording && (
        <div className="border-b border-border p-2">
          <ReplayPlayer
            token={token}
            id={s.recording.id}
            title={s.recording.start_page ? pageName(s.recording.start_page) : null}
            appUrl={s.recording.app_url}
            onClose={() => onWatch(false)}
          />
        </div>
      )}
      <ol className="relative flex flex-col py-1.5">
        <span aria-hidden className="absolute bottom-3 left-[calc(12px+44px+8px+11px)] top-3 w-px bg-border sm:left-[calc(16px+44px+8px+11px)]" />
        {s.events.map((e) => (
          <li key={e.id} className="relative flex min-h-9 items-start gap-2 px-3 py-1 sm:px-4">
            <time dateTime={e.t} className="w-11 shrink-0 pt-1 font-mono text-micro tabular-nums text-text-muted">{hhmm(e.t)}</time>
            <KindMark kind={e.kind} className="relative z-1" />
            <div className="min-w-0 flex-1 pt-0.5">
              <p className={cx("flex min-w-0 items-start gap-1 break-words text-body leading-snug", labelClass(e.kind))}>
                <span className="min-w-0">{e.label}</span>
                {e.page?.doc && <DocLink doc={e.page.doc} className="-my-1" />}
              </p>
              {eventDetail(e) && <p className="truncate font-mono text-micro text-text-muted" title={eventDetail(e)!}>{eventDetail(e)}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function BackLink() {
  return (
    <NavLink to={{ person: null, jt: "people" }} className="inline-flex min-h-10 items-center gap-1.5 self-start font-mono text-caption text-text-secondary hover:text-text">
      <Icon name="arrowLeft" size={14} />journeys / people
    </NavLink>
  );
}
