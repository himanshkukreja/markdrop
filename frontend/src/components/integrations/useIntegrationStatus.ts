"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { slackMe, slackStatus } from "@/lib/slack";
import { jiraMe, jiraStatus } from "@/lib/jira";
import { zoomStatus } from "@/lib/zoom";
import { getMeetConnection } from "@/lib/meetings";
import { listConnections, type OAuthConnection } from "@/lib/oauthClient";
import { getGoogleDocsStatus, listApiTokens } from "@/lib/api";
import { aiAppOf } from "@/lib/integrations";

/**
 * One status per integration card, from the APIs the settings already use (one request per integration,
 * in parallel, on load and on `reload()`). A failed check shows as "Couldn't check" rather than a guess.
 */
export type StatusKind = "connected" | "off" | "attention" | "admin" | "unavailable" | "info";
export interface IntegrationStatus { kind: StatusKind; label?: string }

export type StatusMap = Record<string, IntegrationStatus | undefined>;

const FAILED: IntegrationStatus = { kind: "info", label: "Couldn't check" };

function settle<T>(p: Promise<T>, map: (v: T) => IntegrationStatus): Promise<IntegrationStatus> {
  return p.then(map, () => FAILED);
}

function off(isAdmin: boolean, adminOnly = true): IntegrationStatus {
  return { kind: adminOnly && !isAdmin ? "admin" : "off" };
}

async function loadWorkspace(id: string, isAdmin: boolean): Promise<StatusMap> {
  const [slack, jira, zoom, meet] = await Promise.all([
    settle(slackStatus(id), (s) => !s.configured ? { kind: "unavailable" }
      : s.install ? (s.install.token_ok && s.install.can_find_by_email ? { kind: "connected" } : { kind: "attention" })
      : off(isAdmin)),
    settle(jiraStatus(id), (s) => !s.configured && !s.site ? { kind: "unavailable" }
      : s.site ? (s.site.connector_ok && !s.site.webhook.error ? { kind: "connected" } : { kind: "attention" })
      : off(isAdmin)),
    settle(zoomStatus(id), (s) => !s.configured ? { kind: "unavailable" }
      : s.connected ? (s.connection?.broken ? { kind: "attention" } : { kind: "connected" })
      : off(isAdmin)),
    settle(getMeetConnection(id), (r) => r.connection && r.connection.workspace_id === id
      ? (r.connection.needs_update || r.connection.last_error ? { kind: "attention" } : { kind: "connected" }) : { kind: "off" }),
  ]);
  return { slack, jira, zoom, "google-meet": meet };
}

async function loadAccount(): Promise<{ map: StatusMap; apps: OAuthConnection[] | null }> {
  let apps: OAuthConnection[] | null = null;
  const appsP = listConnections().then((a) => { apps = a; return a; });
  const [slack, jira, gdocs, tokens, appMap] = await Promise.all([
    settle(slackMe(), (m) => !m.configured ? { kind: "unavailable" }
      : m.on ? (m.teams.some((t) => !t.token_ok) ? { kind: "attention" } : { kind: "connected", label: "On" })
      : { kind: "off", label: m.teams.length ? "Off" : "Not connected" }),
    settle(jiraMe(), (m) => m.broken ? { kind: "attention" } : m.connected ? { kind: "connected" }
      : !m.configured ? { kind: "unavailable" } : { kind: "off" }),
    settle(getGoogleDocsStatus(), (g) => g.connected ? { kind: "connected" } : !g.configured ? { kind: "unavailable" } : { kind: "off" }),
    settle(listApiTokens(), (t) => t.some((x) => x.name === "VS Code") ? { kind: "connected" } : { kind: "off" }),
    appsP.then((list) => {
      const seen = new Set(list.map((a) => aiAppOf(a.name)));
      const one = (id: string): IntegrationStatus => (seen.has(id as never) ? { kind: "connected" } : { kind: "off" });
      return { claude: one("claude"), chatgpt: one("chatgpt"), cursor: one("cursor"), "ai-apps": one("ai-apps") } as StatusMap;
    }, () => ({ claude: FAILED, chatgpt: FAILED, cursor: FAILED, "ai-apps": FAILED } as StatusMap)),
  ]);
  return {
    map: {
      slack, jira, "google-docs": gdocs, vscode: tokens, ...appMap,
      cli: { kind: "info", label: "API token" },
      github: { kind: "info", label: "Per guide" },
    },
    apps,
  };
}

/** Statuses for a workspace's integrations (`id` set) or the signed-in person's own (`id` null). */
export function useIntegrationStatus(scope: "workspace" | "account", id: string | null, isAdmin: boolean, enabled = true) {
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [apps, setApps] = useState<OAuthConnection[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const reload = useCallback(async () => {
    if (scope === "workspace") {
      if (!id) return;
      const m = await loadWorkspace(id, isAdmin);
      if (live.current) setStatuses(m);
    } else {
      const { map, apps: a } = await loadAccount();
      if (!live.current) return;
      setStatuses(map);
      setApps(a);
    }
    if (live.current) setLoaded(true);
  }, [scope, id, isAdmin]);

  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);
  return { statuses, apps, loaded, reload };
}
