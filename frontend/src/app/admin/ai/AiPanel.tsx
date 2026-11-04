"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Tabs } from "@/components/ui";
import { LoadingBlock, PageHead, readQuery, writeQuery } from "../shared";

/**
 * Admin → AI: every AI feature on one ledger (`ai_requests`, services/ai_usage.py).
 * Overview (spend against the caps, by feature), Users (who used what, block or cap a person),
 * Budgets (caps, switches and limits, audited), Covers (the one-time auto-cover backfill for
 * existing pages) and Docs Ask AI (questions, gaps, conversations).
 * The sub-tab lives in the URL as `?tab=ai&at=users`, read after mount.
 */

type SubTab = "overview" | "users" | "budgets" | "covers" | "docs";
const TABS: { value: SubTab; label: string; icon: string }[] = [
  { value: "overview", label: "Overview", icon: "chart" },
  { value: "users", label: "Users", icon: "users" },
  { value: "budgets", label: "Budgets", icon: "settings" },
  { value: "covers", label: "Covers", icon: "image" },
  { value: "docs", label: "Docs Ask AI", icon: "message" },
];

const loading = () => <LoadingBlock size="md" label="Loading AI" minHeight={320} />;
const OverviewTab = dynamic(() => import("./OverviewTab").then((m) => m.OverviewTab), { ssr: false, loading });
const UsersTab = dynamic(() => import("./UsersTab").then((m) => m.UsersTab), { ssr: false, loading });
const BudgetsTab = dynamic(() => import("./BudgetsTab").then((m) => m.BudgetsTab), { ssr: false, loading });
const CoversTab = dynamic(() => import("./CoversTab").then((m) => m.CoversTab), { ssr: false, loading });
const DocsAskTab = dynamic(() => import("./DocsAskTab").then((m) => m.DocsAskTab), { ssr: false, loading });

const isTab = (v: string | null): v is SubTab => TABS.some((t) => t.value === v);

export default function AiPanel({ token }: { token: string }) {
  const [tab, setTab] = useState<SubTab | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      const q = readQuery();
      const at = q.get("at");
      setTab(isTab(at) ? at : "overview");
      setUserId(q.get("au"));
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  const go = (t: SubTab) => {
    setTab(t);
    setUserId(null);
    writeQuery({ at: t === "overview" ? null : t, au: null }, true);
  };
  const openUser = (id: string | null) => {
    setUserId(id);
    if (id) setTab("users");
    writeQuery({ at: id ? "users" : tab === "overview" ? null : tab, au: id }, false);
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
            {tab === "users" && <UsersTab token={token} openId={userId} onOpen={openUser} />}
            {tab === "budgets" && <BudgetsTab token={token} onGo={go} />}
            {tab === "covers" && <CoversTab token={token} />}
            {tab === "docs" && <DocsAskTab token={token} />}
          </>
        )}
      </div>
    </div>
  );
}
