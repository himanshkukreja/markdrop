"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { MarkdropLoader, ThemeScope } from "@/components/ui";
import { adminListDocuments, adminListFeedback, clearAdminToken, getAdminToken } from "@/lib/api";
import AnalyticsPanel, { type Filters } from "./analytics/AnalyticsPanel";
import { parseRange, serializeRange, type RangeValue } from "./analytics/controls";
import { AdminLogin } from "./AdminLogin";
import { AdminShell } from "./AdminShell";
import { DEFAULT_DOC_FILTERS, DocumentsPanel, type DocFilters } from "./DocumentsPanel";
import { DocEditor } from "./DocEditor";
import EmailSection from "./email/EmailSection";
import { FeedbackPanel } from "./FeedbackPanel";
import { ProductHealthPanel } from "./ProductHealthPanel";
import { LoadingBlock, UnauthorizedContext, readQuery, sectionFrom, writeQuery, type Section } from "./shared";
import { UsersPanel } from "./UsersPanel";
import JourneysPanel from "./journeys/JourneysPanel";
import { JOURNEYS_KEYS, type Patch } from "./journeys/bits";

/** Journeys keeps its sub-state in the URL; another section starts without it. */
const JOURNEYS_CLEAR = Object.fromEntries(JOURNEYS_KEYS.map((k) => [k, null]));

// Live polls PostHog and carries the replay player: loaded when it is first opened.
const LivePanel = dynamic(() => import("./live/LivePanel"), {
  ssr: false,
  loading: () => <LoadingBlock size="md" label="Loading live activity" minHeight={480} />,
});

/** The section in the URL. Journeys' old Live view (`?tab=journeys&jt=live`) is now its own section. */
function sectionOfUrl(): Section {
  const q = readQuery();
  if (q.get("tab") === "journeys" && q.get("jt") === "live") {
    writeQuery({ tab: "live", jt: null });
    return "live";
  }
  return sectionFrom(q.get("tab"));
}

type Phase = "init" | "login" | "app";

function parseFilters(raw: string | null): Filters {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Filters;
    }
  } catch { /* a hand-edited URL: ignore it */ }
  return {};
}

/**
 * The admin console. A permanent dark island (D3): everything, portals included, renders inside a
 * dark ThemeScope whatever the site theme is. URL state (`?tab=&range=&f=`) is read after mount,
 * never with useSearchParams. The admin JWT stays in localStorage `markdrop_admin_token`.
 * /admin* is excluded from analytics (lib/analyticsPath).
 */
export default function AdminApp() {
  const [phase, setPhase] = useState<Phase>("init");
  const [token, setToken] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("overview");
  const [range, setRange] = useState<RangeValue>(() => parseRange(null));
  const [filters, setFilters] = useState<Filters>({});
  const [docFilters, setDocFilters] = useState<DocFilters>(DEFAULT_DOC_FILTERS);
  const [editing, setEditing] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ reports?: number; feedback?: number }>({});
  // Bumped when Email is picked in the rail, so it opens on its home rather than a campaign.
  const [emailKey, setEmailKey] = useState(0);

  // Init: token and URL state, after mount.
  useEffect(() => {
    const q = readQuery();
    setSection(sectionOfUrl());
    setRange(parseRange(q.get("range")));
    setFilters(parseFilters(q.get("f")));
    const stored = getAdminToken();
    setToken(stored);
    setPhase(stored ? "app" : "login");
  }, []);

  // Back/forward between tabs.
  useEffect(() => {
    const onPop = () => {
      const q = readQuery();
      setSection(sectionOfUrl());
      setRange(parseRange(q.get("range")));
      setFilters(parseFilters(q.get("f")));
      setEditing(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const signOut = useCallback(() => {
    clearAdminToken();
    setToken(null);
    setEditing(null);
    setCounts({});
    setPhase("login");
  }, []);

  const refreshCounts = useCallback(() => {
    if (!token) return;
    adminListDocuments(token, 1, 1, undefined, true).then((r) => setCounts((c) => ({ ...c, reports: r.total }))).catch(() => {});
    adminListFeedback(token, 1, undefined, "open").then((r) => setCounts((c) => ({ ...c, feedback: r.open_count }))).catch(() => {});
  }, [token]);
  useEffect(() => { if (phase === "app") refreshCounts(); }, [phase, refreshCounts]);

  const select = (s: Section) => {
    setEditing(null);
    if (s !== section) setDocFilters((f) => ({ ...f, page: 1 }));
    setSection(s);
    if (s === "email") setEmailKey((k) => k + 1);
    // Each section's own URL state (Journeys: jt, person, path…; Email: campaign, ct, et, template)
    // doesn't carry over to other tabs.
    writeQuery({
      tab: s === "overview" ? null : s,
      ...(s !== "journeys" ? JOURNEYS_CLEAR : {}),
      campaign: null, ct: null, et: null, template: null,
    }, true);
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  };
  /** From Live to a person or page in Journeys. */
  const openJourneys = useCallback((patch: Patch) => {
    select("journeys");
    writeQuery(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- select only reads setters and the current section
  }, [section]);
  const changeRange = (r: RangeValue) => {
    setRange(r);
    writeQuery({ range: serializeRange(r) === "30d" ? null : serializeRange(r) });
  };
  const changeFilters = (f: Filters) => {
    setFilters(f);
    writeQuery({ f: Object.keys(f).length ? JSON.stringify(f) : null });
  };

  let body: React.ReactNode = null;
  if (phase === "init") {
    body = (
      <div className="flex min-h-dvh flex-1 items-center justify-center">
        <MarkdropLoader size="sm" label="Opening the admin console" />
      </div>
    );
  } else if (phase === "login" || !token) {
    body = <AdminLogin onSignedIn={(t) => { setToken(t); setPhase("app"); }} />;
  } else {
    let page: React.ReactNode;
    if (editing && (section === "documents" || section === "reports")) {
      page = <DocEditor token={token} slug={editing} onBack={() => setEditing(null)} />;
    } else {
      switch (section) {
        case "overview":
          page = <AnalyticsPanel token={token} range={range} onRange={changeRange} filters={filters} onFilters={changeFilters} onOpenHealth={() => select("health")} />;
          break;
        case "health":
          page = <ProductHealthPanel token={token} range={range} onRange={changeRange} />;
          break;
        case "documents":
        case "reports":
          page = (
            <DocumentsPanel
              key={section}
              token={token}
              reportsView={section === "reports"}
              filters={docFilters}
              setFilters={setDocFilters}
              onEdit={setEditing}
              onChanged={refreshCounts}
            />
          );
          break;
        case "live":
          page = <LivePanel token={token} onOpenJourneys={openJourneys} />;
          break;
        case "journeys":
          page = <JourneysPanel token={token} />;
          break;
        case "users":
          page = <UsersPanel token={token} />;
          break;
        case "feedback":
          page = <FeedbackPanel token={token} onChanged={refreshCounts} />;
          break;
        case "email":
          page = <EmailSection key={emailKey} token={token} />;
          break;
      }
    }
    body = (
      <AdminShell section={section} counts={counts} onSelect={select} onSignOut={signOut}>
        {page}
      </AdminShell>
    );
  }

  return (
    <UnauthorizedContext.Provider value={signOut}>
      <ThemeScope theme="dark" className="flex min-h-dvh w-full min-w-0 flex-1 flex-col">
        {body}
      </ThemeScope>
    </UnauthorizedContext.Provider>
  );
}
