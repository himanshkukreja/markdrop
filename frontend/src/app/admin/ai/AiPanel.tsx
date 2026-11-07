"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Tabs } from "@/components/ui";
import { LoadingBlock, PageHead, readQuery, writeQuery } from "../shared";
import type { RequestsFilter } from "./RequestsTab";
import type { RequestsLink } from "./WorkspacesTab";

/**
 * Admin → AI: every AI feature on one ledger (`ai_requests`, services/ai_usage.py).
 * Overview (spend against the caps, by feature), Requests (every call as a readable conversation,
 * real users apart from system jobs, visitors and test & internal traffic), Users (who used what, block or cap a person),
 * Budgets (caps, switches and limits, audited), Covers (the one-time auto-cover backfill for
 * existing pages) and Docs Ask AI (questions, gaps, conversations).
 * Workspaces (the same per workspace: system jobs count towards the workspace they ran for).
 * The sub-tab lives in the URL as `?tab=ai&at=users`, read after mount; `au` is an open person,
 * `aw` an open workspace, `ac` an open conversation (`?tab=ai&at=requests&ac=<id>`); `rw` / `rwn` /
 * `rr` / `ra` open Requests on one workspace's conversations (from a workspace's page).
 */

type SubTab = "overview" | "requests" | "users" | "workspaces" | "budgets" | "covers" | "docs";
const TABS: { value: SubTab; label: string; icon: string }[] = [
  { value: "overview", label: "Overview", icon: "chart" },
  { value: "requests", label: "Requests", icon: "inbox" },
  { value: "users", label: "Users", icon: "users" },
  { value: "workspaces", label: "Workspaces", icon: "folder" },
  { value: "budgets", label: "Budgets", icon: "settings" },
  { value: "covers", label: "Covers", icon: "image" },
  { value: "docs", label: "Docs Ask AI", icon: "message" },
];

const loading = () => <LoadingBlock size="md" label="Loading AI" minHeight={320} />;
const OverviewTab = dynamic(() => import("./OverviewTab").then((m) => m.OverviewTab), { ssr: false, loading });
const RequestsTab = dynamic(() => import("./RequestsTab").then((m) => m.RequestsTab), { ssr: false, loading });
const UsersTab = dynamic(() => import("./UsersTab").then((m) => m.UsersTab), { ssr: false, loading });
const WorkspacesTab = dynamic(() => import("./WorkspacesTab").then((m) => m.WorkspacesTab), { ssr: false, loading });
const BudgetsTab = dynamic(() => import("./BudgetsTab").then((m) => m.BudgetsTab), { ssr: false, loading });
const CoversTab = dynamic(() => import("./CoversTab").then((m) => m.CoversTab), { ssr: false, loading });
const DocsAskTab = dynamic(() => import("./DocsAskTab").then((m) => m.DocsAskTab), { ssr: false, loading });

const isTab = (v: string | null): v is SubTab => TABS.some((t) => t.value === v);
const NO_REQ = { rw: null, rwn: null, rr: null, ra: null };

export default function AiPanel({ token }: { token: string }) {
  const [tab, setTab] = useState<SubTab | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [wsId, setWsId] = useState<string | null>(null);
  const [reqFilter, setReqFilter] = useState<RequestsFilter | null>(null);

  useEffect(() => {
    const read = () => {
      const q = readQuery();
      const at = q.get("at");
      setTab(isTab(at) ? at : "overview");
      setUserId(q.get("au"));
      setConvId(q.get("ac"));
      setWsId(q.get("aw"));
      const rw = q.get("rw");
      setReqFilter(rw ? { workspace: { value: rw, label: q.get("rwn") || "Workspace" }, preset: q.get("rr"), audience: q.get("ra") } : null);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  const go = (t: SubTab) => {
    setTab(t);
    setUserId(null);
    setConvId(null);
    setWsId(null);
    setReqFilter(null);
    writeQuery({ at: t === "overview" ? null : t, au: null, ac: null, aw: null, ...NO_REQ }, true);
  };
  const openUser = (id: string | null) => {
    setUserId(id);
    if (id) setTab("users");
    writeQuery({ at: id ? "users" : tab === "overview" ? null : tab, au: id, ac: null, aw: null, ...NO_REQ }, !!id && tab !== "users");
  };
  const openWs = (id: string | null) => {
    setWsId(id);
    writeQuery({ at: "workspaces", aw: id, au: null, ac: null }, false);
  };
  const openConv = (id: string | null) => {
    setConvId(id);
    writeQuery({ at: "requests", ac: id, au: null, aw: null }, false);
  };
  /** A workspace's conversations: Requests filtered to it, over the same range and audience. */
  const openRequests = (l: RequestsLink) => {
    const f: RequestsFilter = { workspace: l.workspace, preset: l.range === "90d" ? "all" : l.range, audience: l.audience === "live" ? "all" : l.audience };
    setReqFilter(f);
    setConvId(null);
    setWsId(null);
    setTab("requests");
    writeQuery({ at: "requests", ac: null, aw: null, au: null, rw: f.workspace.value, rwn: f.workspace.label, rr: f.preset, ra: f.audience }, true);
  };

  return (
    <div>
      <PageHead title="AI" caption="Every AI feature: what it costs, who uses it, and the budgets that cap it." />
      <Tabs className="mb-5" aria-label="AI sections" idPrefix="ai" value={tab ?? "overview"} onChange={(v) => go(v as SubTab)}
        items={TABS.map((t) => ({ value: t.value, label: t.label, icon: t.icon }))} />
      <div role="tabpanel" id={`ai-panel-${tab ?? "overview"}`} aria-labelledby={`ai-tab-${tab ?? "overview"}`}>
        {tab === null ? loading() : (
          <>
            {tab === "overview" && <OverviewTab token={token} onOpenUser={openUser} onGo={go} />}
            {tab === "requests" && <RequestsTab key={reqFilter ? `${reqFilter.workspace.value}:${reqFilter.preset}:${reqFilter.audience}` : "all"}
              token={token} openId={convId} onOpen={openConv} initial={reqFilter} />}
            {tab === "users" && <UsersTab token={token} openId={userId} onOpen={openUser} />}
            {tab === "workspaces" && <WorkspacesTab token={token} openId={wsId} onOpen={openWs} onOpenUser={(id) => openUser(id)} onRequests={openRequests} />}
            {tab === "budgets" && <BudgetsTab token={token} onGo={go} />}
            {tab === "covers" && <CoversTab token={token} />}
            {tab === "docs" && <DocsAskTab token={token} />}
          </>
        )}
      </div>
    </div>
  );
}
