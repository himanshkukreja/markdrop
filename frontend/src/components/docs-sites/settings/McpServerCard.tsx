"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, CopyButton, Switch } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { primaryAddress } from "@/lib/docsSites";
import { CLAUDE_CONNECTORS_URL, mcpLinks, openAppLink } from "@/docs/mcpLinks";
import { liveUrl } from "../PublishState";
import { useSite } from "../SiteContext";
import { SettingsCard } from "./SettingsShell";
import usePatch from "./usePatch";

/** The install name the build gives the server (backend docs_snapshot.mcp_name). */
export function mcpInstallName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  if (!slug) return "docs";
  return slug === "docs" || slug.endsWith("-docs") ? slug : `${slug}-docs`;
}

type Probe =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; tools: Array<{ name: string; title?: string; description?: string }>; ms: number }
  | { state: "failed"; message: string };

/** tools/list against the live server, from this browser, as an AI app would call it. */
async function listTools(server: string): Promise<{ tools: Array<{ name: string; title?: string; description?: string }>; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(server, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string; title?: string; description?: string }> }; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "The server returned an error.");
  return { tools: body.result?.tools ?? [], ms: Math.round(performance.now() - t0) };
}

/**
 * Settings › Ask AI › Your guide's MCP server: every published public guide serves one at
 * `<address>/mcp` (src/docs/mcp.ts, run at the edge). Its address (own domain first), Copy, the
 * install buttons readers get, a live tools/list check, and the switch for the Connect to AI
 * actions on pages (settings.mcp.connect).
 */
export function McpServerCard() {
  const { site } = useSite();
  const { patch, saving, locked } = usePatch();
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const s = site.settings;
  const connect = s.mcp?.connect !== false;
  const isPublic = s.access.level === "public";
  const isLive = site.status === "live";
  const host = primaryAddress(site);
  const links = mcpLinks(liveUrl(host), mcpInstallName(site.name));
  const canTest = isLive && isPublic;
  // Linked as …/settings/ask-ai#mcp (the Publish screen's "Set up"): the card renders after the
  // site loads, after the browser looked for the anchor.
  useEffect(() => {
    if (window.location.hash === "#mcp") document.getElementById("mcp")?.scrollIntoView({ block: "start" });
  }, []);

  const test = async () => {
    setProbe({ state: "running" });
    try {
      const r = await listTools(links.server);
      setProbe({ state: "ok", ...r });
    } catch (e) {
      const msg = e instanceof Error && e.name !== "TypeError" && e.name !== "TimeoutError" ? e.message : "Couldn't reach it. Check your connection, or publish again and retry.";
      setProbe({ state: "failed", message: msg });
    }
  };

  return (
    <SettingsCard
      id="mcp"
      title="Your guide's MCP server"
      description={
        <>
          AI tools like Claude, Cursor, VS Code and ChatGPT connect to it and search and read your guide while they help someone. Only public pages: private pages and sections never reach it. <ReadMore topic="studioMcp" />
        </>
      }
      aside={
        <Switch
          aria-label="Connect to AI on your guide's pages"
          label={connect ? "Shown on pages" : "Hidden on pages"}
          checked={connect}
          disabled={locked || saving === "mcp"}
          onChange={(e) =>
            void patch(
              "mcp",
              { settings: { mcp: { connect: e.target.checked } } },
              e.target.checked ? "Connect to AI is on. Publish to show it on your pages." : "Connect to AI is hidden. Publish to take it off your pages.",
            )
          }
        />
      }
    >
      {!isPublic ? (
        <Alert tone="neutral" title="Not while the guide is private">
          Your guide asks readers to sign in, and AI tools can&apos;t, so its MCP server isn&apos;t reachable and pages don&apos;t offer Connect to AI. Make the guide public to use it.
        </Alert>
      ) : !isLive ? (
        <Alert tone="neutral">Publish your guide and the server starts answering at this address.</Alert>
      ) : null}

      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-caption font-semibold text-text">Server URL</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="ph-sensitive min-w-0 flex-[1_1_260px] select-all break-all rounded-lg border border-border bg-surface-inset px-3 py-2 font-mono text-[13px] leading-5 text-text">{links.server}</code>
          <CopyButton text={links.server} label="Copy URL" announceText="MCP server URL copied" />
        </div>
        <p className="text-caption text-text-muted">
          {connect && isPublic
            ? "Readers find it under Connect to AI in each page's Copy page menu, with one-click installs."
            : "The server answers at this address either way; the switch only shows or hides Connect to AI on pages."}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" iconLeft="code" disabled={!isPublic} onClick={() => openAppLink(links.cursor)}>Add to Cursor</Button>
        <Button variant="secondary" size="sm" iconLeft="code" disabled={!isPublic} onClick={() => openAppLink(links.vscode)}>Add to VS Code</Button>
        <CopyButton text={links.claudeCode} label="Copy Claude Code command" copiedLabel="Command copied" />
        <Button variant="ghost" size="sm" iconRight="external" href={CLAUDE_CONNECTORS_URL} target="_blank" rel="noopener noreferrer">
          Claude connectors<span className="md-visually-hidden"> (opens in a new tab)</span>
        </Button>
      </div>
      <p className="text-[13px] text-text-muted">
        Claude: Settings › Connectors › Add custom connector, then paste the URL. ChatGPT: in developer mode (Plus, Pro, Business, Enterprise and Edu, on the web), create an app with the URL and no authentication.
      </p>

      <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" iconLeft="play" loading={probe.state === "running"} disabled={!canTest} onClick={() => void test()}>
            Test it
          </Button>
          <span className="text-[13px] text-text-muted">
            {canTest ? "Asks the live server for its tools, the way an AI app does." : "Available once the guide is live and public."}
          </span>
        </div>
        <div aria-live="polite" className="min-w-0">
          {probe.state === "ok" && (
            <div className="flex min-w-0 flex-col gap-2">
              <p className="flex flex-wrap items-center gap-2 text-body text-text">
                <Badge tone="success" dot>Working</Badge>
                {probe.tools.length} {probe.tools.length === 1 ? "tool" : "tools"}, answered in {probe.ms} ms
              </p>
              <ul className="flex min-w-0 flex-col gap-1.5" aria-label="Tools the server offers">
                {probe.tools.map((t) => (
                  <li key={t.name} className="min-w-0 text-[13px] leading-5 text-text-secondary">
                    <code className="font-mono text-[12.5px] font-semibold text-text">{t.name}</code>
                    {t.title ? <> · {t.title}</> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {probe.state === "failed" && <Alert tone="danger" title="The server didn't answer">{probe.message}</Alert>}
        </div>
      </div>
    </SettingsCard>
  );
}

export default McpServerCard;
