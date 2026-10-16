"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Dialog, EmptyState, Icon, Input, Progress, SegmentedControl, Skeleton, Switch, Tabs } from "@/components/ui";
import StatTile from "@/components/kit/StatTile";
import { PageHead, PersonAvatar, fmtDateTime, isUnauthorized, plural, readQuery, useOnUnauthorized, writeQuery } from "../shared";
import { journeys, type JourneyDoc, type JourneyEvent, type JourneyPerson, type JourneyPersonDetail, type JourneyRecording, type JourneySummary } from "./api";
import { ReplayPlayer, clock } from "./ReplayPlayer";
import { ago, describe, duration, flag, sessions } from "./timeline";

const RANGES = [
  { value: 1, label: "24h" },
  { value: 7, label: "7d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
] as const;
type Days = (typeof RANGES)[number]["value"];

function useGuard() {
  const onUnauthorized = useOnUnauthorized();
  return useCallback((e: unknown, set: (m: string) => void) => {
    if (isUnauthorized(e)) onUnauthorized();
    else set(e instanceof Error ? e.message : "Something went wrong");
  }, [onUnauthorized]);
}

function who(p: { email?: string | null; name?: string | null; id?: string | null }) {
  if (p.name && p.email) return { primary: p.name, secondary: p.email, known: true };
  if (p.email) return { primary: p.email, secondary: null, known: true };
  return { primary: "Anonymous visitor", secondary: p.id ? `#${p.id.slice(0, 8)}` : null, known: false };
}

/** Where someone first came from, in words. PostHog's "$direct" means no referrer. */
function source(v: string | null | undefined) {
  return !v || v === "$direct" ? "direct" : `via ${v}`;
}

function Place({ country, city }: { country?: string | null; city?: string | null }) {
  if (!country && !city) return <span className="text-text-muted">—</span>;
  return <span className="whitespace-nowrap">{flag(country)} {[city, country].filter(Boolean).join(", ")}</span>;
}

// ── Recording dialog ──────────────────────────────────────────────────────────

function RecordingDialog({ token, rec, onClose }: { token: string; rec: JourneyRecording | null; onClose: () => void }) {
  return (
    <Dialog
      open={!!rec}
      onClose={onClose}
      size="xl"
      title={rec ? `Recording · ${who(rec.person ?? {}).primary}` : "Recording"}
      description={rec ? `${fmtDateTime(rec.start_time)} · ${clock((rec.duration ?? 0) * 1000)} long · ${plural(rec.click_count ?? 0, "click")}` : undefined}
    >
      {rec && <ReplayPlayer token={token} recordingId={rec.id} />}
    </Dialog>
  );
}

function RecordingRows({ items, onOpen, showPerson }: { items: JourneyRecording[]; onOpen: (r: JourneyRecording) => void; showPerson: boolean }) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
      {items.map((r) => {
        const w = who(r.person ?? {});
        return (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r)} className="md-focus flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text"><Icon name="play" size={16} /></span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body-strong text-text">{showPerson ? w.primary : (r.start_url ? new URL(r.start_url).pathname : "Recording")}</span>
                <span className="truncate text-caption text-text-secondary">
                  {showPerson && r.start_url ? `${new URL(r.start_url).pathname} · ` : ""}{fmtDateTime(r.start_time)}
                </span>
              </span>
              <span className="hidden shrink-0 text-caption tabular-nums text-text-secondary sm:block">{plural(r.click_count ?? 0, "click")}</span>
              <span className="shrink-0 font-mono text-caption tabular-nums text-text">{clock((r.duration ?? 0) * 1000)}</span>
              {r.ongoing && <Badge size="sm" tone="success" live>Live</Badge>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── Person ────────────────────────────────────────────────────────────────────

function DocChip({ doc }: { doc: NonNullable<ReturnType<typeof describe>["doc"]> }) {
  const label = doc.encrypted ? "Encrypted document" : doc.title || (doc.slug ? `/${doc.slug}` : "Unknown document");
  return (
    <span className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-inset px-2 py-0.5 text-caption">
      <Icon name={doc.kind === "artifact" ? "image" : doc.encrypted ? "lock" : "doc"} size={12} className="shrink-0 text-text-muted" />
      {doc.slug ? (
        <a href={`https://markdrop.in/${doc.slug}`} target="_blank" rel="noopener noreferrer" className="md-focus truncate rounded-sm text-text hover:underline" dir="auto">{label}</a>
      ) : (
        <span className="truncate text-text-secondary">{label}</span>
      )}
      {doc.access && doc.access !== "public" && <Badge size="sm" tone="neutral">{doc.access}</Badge>}
    </span>
  );
}

function EventRow({ e, docs }: { e: JourneyEvent; docs: Record<string, JourneyDoc> }) {
  const d = describe(e, docs);
  const tone = d.tone === "danger" ? "text-danger" : d.tone === "warning" ? "text-(--warning)" : d.tone === "accent" ? "text-accent-text" : "text-text-muted";
  return (
    <li className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-3 py-2">
      <Icon name={d.icon} size={15} className={`mt-0.5 ${tone}`} />
      <span className="flex min-w-0 flex-col">
        <span className="text-body text-text">{d.title}</span>
        {d.detail && <span className="truncate text-caption text-text-secondary" title={d.detail}>{d.detail}</span>}
        {d.doc && <DocChip doc={d.doc} />}
      </span>
      <time className="whitespace-nowrap text-caption tabular-nums text-text-muted" dateTime={e.timestamp} title={new Date(e.timestamp).toLocaleString("en-GB")}>
        {new Date(e.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </time>
    </li>
  );
}

function PersonView({ token, id, onBack }: { token: string; id: string; onBack: () => void }) {
  const guard = useGuard();
  const [person, setPerson] = useState<JourneyPersonDetail | null>(null);
  const [events, setEvents] = useState<JourneyEvent[] | null>(null);
  const [docs, setDocs] = useState<Record<string, JourneyDoc>>({});
  const [more, setMore] = useState(false);
  const [recs, setRecs] = useState<JourneyRecording[] | null>(null);
  const [tab, setTab] = useState<"timeline" | "recordings">("timeline");
  const [open, setOpen] = useState<JourneyRecording | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let off = false;
    setError("");
    journeys.person(token, id).then((p) => !off && setPerson(p)).catch((e) => guard(e, setError));
    journeys.timeline(token, id).then((r) => { if (off) return; setEvents(r.events); setDocs(r.docs); setMore(r.has_more); }).catch((e) => guard(e, setError));
    journeys.recordings(token, id).then((r) => !off && setRecs(r.recordings)).catch(() => !off && setRecs([]));
    return () => { off = true; };
  }, [token, id, guard]);

  const loadMore = async () => {
    if (!events?.length) return;
    setLoadingMore(true);
    try {
      const r = await journeys.timeline(token, id, events[events.length - 1]!.timestamp);
      setEvents((prev) => [...(prev ?? []), ...r.events]);
      setDocs((prev) => ({ ...prev, ...r.docs }));
      setMore(r.has_more);
    } catch (e) {
      guard(e, setError);
    } finally {
      setLoadingMore(false);
    }
  };

  const grouped = useMemo(() => (events ? sessions(events) : []), [events]);
  const recBySession = useMemo(() => new Map((recs ?? []).map((r) => [r.id, r])), [recs]);
  const props = person?.properties ?? {};
  const w = who({ email: props.email as string, name: props.name as string, id });
  const str = (k: string) => (typeof props[k] === "string" && props[k] ? (props[k] as string) : null);

  return (
    <>
      <Button variant="ghost" size="sm" iconLeft="arrowLeft" onClick={onBack} className="mb-3">All people</Button>
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <PersonAvatar name={w.known ? w.primary : "?"} size="md" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-h2 text-text" dir="auto">{w.primary}</h1>
          <p className="truncate text-body text-text-secondary">
            {[w.secondary, person?.account ? "Has a Markdrop account" : null].filter(Boolean).join(" · ") || "Not signed in"}
          </p>
        </div>
      </header>
      {error && <Alert tone="danger" title="Couldn't load this person" className="mb-4">{error}</Alert>}
      <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-border bg-surface p-4 text-caption sm:grid-cols-4">
        <div className="min-w-0"><dt className="text-text-muted">First seen</dt><dd className="mt-0.5 text-text">{person ? fmtDateTime(person.created_at) : "…"}</dd></div>
        <div className="min-w-0"><dt className="text-text-muted">Location</dt><dd className="mt-0.5 text-text"><Place country={str("$geoip_country_code")} city={str("$geoip_city_name")} /></dd></div>
        <div className="min-w-0"><dt className="text-text-muted">Device</dt><dd className="mt-0.5 truncate text-text">{[str("$browser") ?? str("$initial_browser"), str("$os") ?? str("$initial_os")].filter(Boolean).join(" · ") || "—"}</dd></div>
        <div className="min-w-0"><dt className="text-text-muted">First came from</dt><dd className="mt-0.5 truncate text-text">{str("$initial_utm_source") ?? (str("$initial_referring_domain") === "$direct" ? "Direct" : str("$initial_referring_domain")) ?? "—"}</dd></div>
      </dl>
      <Tabs
        className="mb-4"
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
        aria-label="Person"
        items={[
          { value: "timeline", label: "Timeline", icon: "history", count: grouped.length || undefined },
          { value: "recordings", label: "Recordings", icon: "film", count: recs?.length || undefined },
        ]}
      />
      {tab === "timeline" ? (
        !events ? (
          <div className="flex flex-col gap-2" aria-busy="true">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} variant="rect" height={64} />)}</div>
        ) : events.length === 0 ? (
          <EmptyState icon="history" title="No activity in the last 90 days" />
        ) : (
          <div className="flex flex-col gap-4">
            {grouped.map((s) => {
              const rec = recBySession.get(s.id);
              return (
                <section key={s.id} className="rounded-xl border border-border bg-surface">
                  <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3">
                    <span className="text-body-strong text-text">{fmtDateTime(s.start)}</span>
                    <span className="text-caption text-text-secondary">
                      {[duration(s.start, s.end), plural(s.events.length, "event"), s.entry && `entered on ${s.entry}`, s.source && `from ${s.source}`, s.device].filter(Boolean).join(" · ")}
                    </span>
                    {rec && <Button size="sm" variant="secondary" iconLeft="play" className="ml-auto" onClick={() => setOpen(rec)}>Watch</Button>}
                  </header>
                  <ol className="divide-y divide-border px-4">
                    {s.events.map((e) => <EventRow key={e.uuid} e={e} docs={docs} />)}
                  </ol>
                </section>
              );
            })}
            {more && <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()} className="self-center">Load earlier activity</Button>}
          </div>
        )
      ) : !recs ? (
        <Skeleton variant="rect" height={120} />
      ) : recs.length === 0 ? (
        <EmptyState icon="film" title="No recordings" description="Recordings run only with consent, and never on document pages, invites or share links." />
      ) : (
        <RecordingRows items={recs} onOpen={setOpen} showPerson={false} />
      )}
      <RecordingDialog token={token} rec={open} onClose={() => setOpen(null)} />
    </>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

/**
 * Admin → Journeys: everyone who visited, what they did, and recordings of their sessions, read
 * from PostHog through our API. Documents appear by title and link (resolved from our database);
 * PostHog itself only ever saw an anonymous reference.
 */
export default function JourneysPanel({ token }: { token: string }) {
  const guard = useGuard();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [days, setDays] = useState<Days>(7);
  const [view, setView] = useState<"people" | "recordings">("people");
  const [personId, setPersonId] = useState<string | null>(null);
  const [summary, setSummary] = useState<JourneySummary | null>(null);
  const [people, setPeople] = useState<JourneyPerson[] | null>(null);
  const [morePeople, setMorePeople] = useState(false);
  const [recs, setRecs] = useState<JourneyRecording[] | null>(null);
  const [moreRecs, setMoreRecs] = useState(false);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [identified, setIdentified] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<JourneyRecording | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deep links: ?tab=journeys&person=<id>, read after mount.
  useEffect(() => {
    const p = readQuery().get("person");
    if (p) setPersonId(p);
    const onPop = () => setPersonId(readQuery().get("person"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    journeys.status(token).then((s) => setConfigured(s.configured)).catch((e) => { guard(e, setError); setConfigured(false); });
  }, [token, guard]);

  const loadPeople = useCallback(async (before?: string | null) => {
    setBusy(true);
    setError("");
    try {
      const r = await journeys.people(token, { days, q: q || undefined, identified, before });
      setPeople((prev) => (before ? [...(prev ?? []), ...r.people] : r.people));
      setMorePeople(r.has_more);
    } catch (e) {
      guard(e, setError);
    } finally {
      setBusy(false);
    }
  }, [token, days, q, identified, guard]);

  const loadRecs = useCallback(async (offset = 0) => {
    setBusy(true);
    try {
      const r = await journeys.recordings(token, null, offset);
      setRecs((prev) => (offset ? [...(prev ?? []), ...r.recordings] : r.recordings));
      setMoreRecs(r.has_more);
    } catch (e) {
      guard(e, setError);
    } finally {
      setBusy(false);
    }
  }, [token, guard]);

  useEffect(() => {
    if (!configured || personId) return;
    journeys.summary(token, days).then(setSummary).catch((e) => guard(e, setError));
    if (view === "people") void loadPeople();
    else void loadRecs();
  }, [configured, personId, token, days, view, loadPeople, loadRecs, guard]);

  const openPerson = (id: string | null) => {
    setPersonId(id);
    writeQuery({ person: id }, true);
    window.scrollTo({ top: 0 });
  };

  const onSearch = (v: string) => {
    setQuery(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQ(v.trim()), 400);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (configured === false && !error) {
    return (
      <>
        <PageHead title="Journeys" />
        <EmptyState
          icon="settings"
          title="PostHog isn't connected"
          description="Set MARKDROP_POSTHOG_PROJECT_ID and MARKDROP_POSTHOG_PERSONAL_API_KEY in the API's .env and restart it."
        />
      </>
    );
  }

  if (personId) return <PersonView token={token} id={personId} onBack={() => openPerson(null)} />;

  return (
    <>
      <PageHead
        title="Journeys"
        caption="Who visits, what they do, and recordings of their sessions."
        actions={
          <SegmentedControl size="sm" aria-label="Time range" value={String(days)} onChange={(v) => { setDays(Number(v) as Days); setPeople(null); }}
            options={RANGES.map((r) => ({ value: String(r.value), label: r.label }))} />
        }
      />
      {error && <Alert tone="danger" title="Couldn't load journeys" className="mb-4" actions={<Button size="sm" variant="secondary" onClick={() => void loadPeople()}>Retry</Button>}>{error}</Alert>}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="People" value={summary ? summary.people.toLocaleString("en") : "—"} loading={!summary && !error} icon="users" />
        <StatTile label="Signed in" value={summary ? summary.identified.toLocaleString("en") : "—"} loading={!summary && !error} icon="user" />
        <StatTile label="Sessions" value={summary ? summary.sessions.toLocaleString("en") : "—"} loading={!summary && !error} icon="history" />
        <StatTile label="Page views" value={summary ? summary.pageviews.toLocaleString("en") : "—"} loading={!summary && !error} icon="eye" />
      </div>
      <Tabs
        className="mb-4"
        value={view}
        onChange={(v) => setView(v as typeof view)}
        aria-label="Journeys"
        items={[{ value: "people", label: "People", icon: "users" }, { value: "recordings", label: "Recordings", icon: "film" }]}
      />
      {busy && (people || recs) && <Progress indeterminate size="sm" aria-label="Updating" valueText="Loading" className="mb-2" />}
      {view === "people" ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Input type="search" value={query} onChange={(e) => onSearch(e.target.value)} placeholder="Search by email, name or id" aria-label="Search people" prefix="search" wrapClassName="w-full max-w-md" />
            <Switch label="Signed in only" checked={identified} onChange={(e) => setIdentified(e.target.checked)} />
          </div>
          {!people ? (
            <div className="flex flex-col gap-2" aria-busy="true"><span className="md-visually-hidden">Loading people</span>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} variant="rect" height={56} />)}</div>
          ) : people.length === 0 ? (
            <EmptyState icon="users" title={q ? "Nobody matches" : "No visitors in this range"} description={q ? "Try another email, name or id." : "Visits appear here a minute or two after they happen."} />
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface">
                {people.map((p) => {
                  const w = who(p);
                  return (
                    <li key={p.id}>
                      <button type="button" onClick={() => openPerson(p.id)} className="md-focus grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-surface-hover lg:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_auto_auto]">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <PersonAvatar name={w.known ? w.primary : "?"} size="md" />
                          <span className="flex min-w-0 flex-col">
                            <span className={`truncate text-body-strong ${w.known ? "text-text" : "text-text-secondary"}`} dir="auto">{w.primary}</span>
                            <span className="truncate text-caption text-text-muted">{w.secondary ?? (p.last_path ? `last on ${p.last_path}` : "")}</span>
                          </span>
                        </span>
                        <span className="text-right text-caption tabular-nums text-text-secondary lg:hidden">{ago(p.last_seen)}</span>
                        <span className="hidden min-w-0 truncate text-caption text-text-secondary lg:block"><Place country={p.country} city={p.city} /></span>
                        <span className="hidden min-w-0 truncate text-caption text-text-secondary lg:block">{[p.browser, p.os].filter(Boolean).join(" · ") || "—"}</span>
                        <span className="col-span-2 text-caption tabular-nums text-text-secondary lg:col-span-1">
                          {plural(p.sessions, "session")} · {plural(p.pageviews, "page")} · {source(p.first_utm_source || p.first_referrer)}
                        </span>
                        <span className="hidden text-right text-caption tabular-nums text-text-secondary lg:block">{ago(p.last_seen)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {morePeople && (
                <Button variant="secondary" className="mx-auto mt-4 flex" loading={busy} onClick={() => void loadPeople(people[people.length - 1]!.last_seen)}>
                  Load more
                </Button>
              )}
            </>
          )}
        </>
      ) : !recs ? (
        <div className="flex flex-col gap-2" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="rect" height={56} />)}</div>
      ) : recs.length === 0 ? (
        <EmptyState icon="film" title="No recordings yet" description="Recordings run only with consent, and never on document pages, invites or share links." />
      ) : (
        <>
          <RecordingRows items={recs} onOpen={setOpen} showPerson />
          {moreRecs && <Button variant="secondary" className="mx-auto mt-4 flex" loading={busy} onClick={() => void loadRecs(recs.length)}>Load more</Button>}
        </>
      )}
      <RecordingDialog token={token} rec={open} onClose={() => setOpen(null)} />
    </>
  );
}
