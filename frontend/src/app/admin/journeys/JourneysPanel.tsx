"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Skeleton, Tabs, Tooltip } from "@/components/ui";
import { GA_ID, POSTHOG_KEY } from "@/lib/analyticsConfig";
import { PageHead } from "../shared";
import { isPreview, useJourneys, type PhStatus } from "./api";
import { NavContext, PhErrorState, SUBTABS, applyPatch, hrefFor, readState, type JState, type Nav, type Patch, type SubTab } from "./bits";
import { SetupCard } from "./SetupCard";

// Each view loads when it's first opened, so the rest of the admin doesn't carry Journeys.
const loading = () => (
  <div aria-busy="true"><span className="md-visually-hidden">Loading</span><Skeleton variant="rect" height={320} /></div>
);
const LiveTab = dynamic(() => import("./LiveTab").then((m) => m.LiveTab), { ssr: false, loading });
const PeopleTab = dynamic(() => import("./PeopleTab").then((m) => m.PeopleTab), { ssr: false, loading });
const RecordingsTab = dynamic(() => import("./RecordingsTab").then((m) => m.RecordingsTab), { ssr: false, loading });
const PathsTab = dynamic(() => import("./PathsTab").then((m) => m.PathsTab), { ssr: false, loading });
const PagesTab = dynamic(() => import("./PagesTab").then((m) => m.PagesTab), { ssr: false, loading });
const PersonView = dynamic(() => import("./PersonView").then((m) => m.PersonView), { ssr: false, loading });

const TAB_LABEL: Record<SubTab, { label: string; icon: string }> = {
  live: { label: "Live", icon: "wave" },
  people: { label: "People", icon: "users" },
  recordings: { label: "Recordings", icon: "film" },
  paths: { label: "Paths & funnel", icon: "listTree" },
  pages: { label: "Pages & heatmaps", icon: "eye" },
};

const INITIAL: JState = { jt: "live", range: null, q: "", kind: "all", person: null, path: null, who: null };

/**
 * Admin → Journeys: who comes, what they read, where they click, and their session replays, read
 * from PostHog through our API. Documents appear by title and link (resolved from our database);
 * PostHog itself only ever saw an opaque reference. Sub-state lives in the URL
 * (`?tab=journeys&jt=people&range=30d&q=&kind=&person=&path=&who=`), read after mount.
 */
export default function JourneysPanel({ token }: { token: string }) {
  const [state, setState] = useState<JState>(INITIAL);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setState(readState());
    setReady(true);
    const onPop = () => setState(readState());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((patch: Patch, push = true) => {
    applyPatch(patch, push);
    setState(readState());
    if (push) window.scrollTo({ top: 0 });
  }, []);
  const nav = useMemo<Nav>(() => ({ state, go, href: hrefFor }), [state, go]);

  const status = useJourneys<PhStatus>(token, ready ? "/status" : null);

  let body: React.ReactNode;
  if (!ready || (!status.data && !status.error)) {
    body = <div aria-busy="true"><span className="md-visually-hidden">Loading Journeys</span><Skeleton variant="rect" height={256} /></div>;
  } else if (status.error && !status.data) {
    body = <PhErrorState error={status.error} onRetry={status.refresh} title="Couldn't reach the Journeys API" />;
  } else if (!status.data!.configured || (isPreview() && readQueryHas("setup"))) {
    body = <SetupCard status={status.data!} />;
  } else if (state.person) {
    body = <PersonView key={state.person} token={token} id={state.person} />;
  } else {
    body = (
      <>
        <Tabs
          className="mb-5"
          aria-label="Journeys sections"
          idPrefix="journeys"
          value={state.jt}
          onChange={(v) => go({ jt: v === "live" ? null : v, person: null, path: null, q: null, who: null }, true)}
          items={SUBTABS.map((t) => ({ value: t, label: TAB_LABEL[t].label, icon: TAB_LABEL[t].icon }))}
        />
        <div role="tabpanel" id={`journeys-panel-${state.jt}`} aria-labelledby={`journeys-tab-${state.jt}`}>
          {state.jt === "live" && <LiveTab token={token} />}
          {state.jt === "people" && <PeopleTab token={token} />}
          {state.jt === "recordings" && <RecordingsTab token={token} />}
          {state.jt === "paths" && <PathsTab token={token} />}
          {state.jt === "pages" && <PagesTab token={token} />}
        </div>
      </>
    );
  }

  const s = status.data;
  return (
    <NavContext.Provider value={nav}>
      {isPreview() && (
        <Alert tone="warning" className="mb-4" title="Preview data" actions={<Button size="sm" variant="secondary" href="/admin?tab=journeys&preview=0">Exit preview</Button>}>
          Development fixtures, not PostHog. Add <code className="font-mono">&amp;setup=1</code> to see the setup card.
        </Alert>
      )}
      {!state.person && (
        <PageHead
          title="Journeys"
          caption="Who comes, what they read, where they click, and their session replays, from PostHog."
          actions={s?.configured ? (
            <>
              {!POSTHOG_KEY && (
                <Tooltip content="No PostHog project key in this build (lib/analyticsConfig.ts): the site isn't sending events" focusable>
                  <Badge tone="danger">capture off</Badge>
                </Tooltip>
              )}
              {s.include_local && (
                <Tooltip content="MARKDROP_POSTHOG_INCLUDE_LOCAL is on: localhost traffic is included" focusable>
                  <Badge tone="warning">incl. localhost</Badge>
                </Tooltip>
              )}
              {GA_ID ? <Badge tone="success">GA4 on</Badge> : <Badge tone="neutral">GA4 off</Badge>}
              <Button size="sm" variant="secondary" iconRight="external" href={`${s.ui_host}/project/${s.project_id}`} target="_blank" rel="noopener noreferrer">
                PostHog<span className="md-visually-hidden"> (opens in a new tab)</span>
              </Button>
            </>
          ) : undefined}
        />
      )}
      {body}
    </NavContext.Provider>
  );
}

function readQueryHas(key: string): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get(key) === "1";
}
