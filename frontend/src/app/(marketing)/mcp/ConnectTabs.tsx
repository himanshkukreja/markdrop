"use client";

import { useState, type ReactNode } from "react";
import { Tabs } from "@/components/ui";
import { CommandBlock } from "@/components/kit/CommandBlock";
import { MCP_SERVER_URL } from "@/lib/mcp";

const CURSOR_JSON = `{
  "mcpServers": {
    "markdrop": {
      "url": "${MCP_SERVER_URL}"
    }
  }
}`;

const VSCODE_JSON = `{
  "servers": {
    "markdrop": {
      "type": "http",
      "url": "${MCP_SERVER_URL}"
    }
  }
}`;

const CLAUDE_CODE = `claude mcp add --transport http markdrop ${MCP_SERVER_URL}`;

/** A UI path such as Settings → Connectors, set as one unbreakable label. */
function Path({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-text">{children}</strong>;
}
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-code-inline-bg px-1.5 py-0.5 font-mono text-[0.875em] text-code-inline">{children}</code>;
}

interface Step { body: ReactNode; snippet?: { text: string; label: string; copy: string; prompt?: string } }
interface Client { value: string; label: string; intro: ReactNode; steps: Step[]; note?: ReactNode }

const URL_SNIPPET = { text: MCP_SERVER_URL, label: "Server URL", copy: "Copy server URL", prompt: "" };

const CLIENTS: Client[] = [
  {
    value: "claude",
    label: "Claude",
    intro: <>On claude.ai and in Claude Desktop.</>,
    steps: [
      { body: <>Open <Path>Settings → Connectors</Path>.</> },
      { body: <>Choose <Path>Add custom connector</Path>, name it Markdrop and paste the server URL.</>, snippet: URL_SNIPPET },
      { body: <>Choose <Path>Connect</Path>. Markdrop opens in your browser: sign in and approve.</> },
      { body: <>In a chat, ask Claude to publish something to Markdrop.</> },
    ],
    note: <>On Team and Enterprise plans, an owner may need to add the connector for the organisation first.</>,
  },
  {
    value: "claude-code",
    label: "Claude Code",
    intro: <>In your terminal.</>,
    steps: [
      { body: <>Add the server:</>, snippet: { text: CLAUDE_CODE, label: "Terminal", copy: "Copy command" } },
      { body: <>Start Claude Code, run <Code>/mcp</Code>, pick markdrop and sign in. Markdrop opens in your browser to approve.</> },
    ],
    note: <>Add <Code>--scope user</Code> to make it available in every project.</>,
  },
  {
    value: "chatgpt",
    label: "ChatGPT",
    intro: <>On chatgpt.com, with Developer mode.</>,
    steps: [
      { body: <>Open <Path>Settings → Apps &amp; Connectors → Advanced settings</Path> and turn on <Path>Developer mode</Path>.</> },
      { body: <>Back in <Path>Apps &amp; Connectors</Path>, choose <Path>Create</Path>. Name it Markdrop, paste the server URL and pick <Path>OAuth</Path> for authentication.</>, snippet: URL_SNIPPET },
      { body: <>Choose <Path>Create</Path>, then sign in to Markdrop and approve.</> },
    ],
    note: <>Developer mode needs a Pro, Team, Enterprise or Edu plan.</>,
  },
  {
    value: "cursor",
    label: "Cursor",
    intro: <>In Cursor&apos;s MCP settings file.</>,
    steps: [
      {
        body: <>Add this to <Code>~/.cursor/mcp.json</Code>, or to <Code>.cursor/mcp.json</Code> in one project:</>,
        snippet: { text: CURSOR_JSON, label: "mcp.json", copy: "Copy JSON", prompt: "" },
      },
      { body: <>Open Cursor&apos;s MCP settings and sign in to markdrop when it asks. Markdrop opens in your browser to approve.</> },
    ],
  },
  {
    value: "vscode",
    label: "VS Code",
    intro: <>For Copilot Chat in agent mode.</>,
    steps: [
      {
        body: <>Add this to <Code>.vscode/mcp.json</Code> in your workspace:</>,
        snippet: { text: VSCODE_JSON, label: ".vscode/mcp.json", copy: "Copy JSON", prompt: "" },
      },
      { body: <>Choose <Path>Start</Path> above the server in that file, or run <Path>MCP: List Servers</Path>. VS Code opens Markdrop in your browser to sign in and approve.</> },
    ],
    note: <>To use it in every workspace, run <Path>MCP: Open User Configuration</Path> and add the same entry.</>,
  },
  {
    value: "other",
    label: "Other apps",
    intro: <>Windsurf and any other MCP app that connects to remote servers.</>,
    steps: [
      { body: <>Add a remote MCP server with this URL. The transport is Streamable HTTP.</>, snippet: URL_SNIPPET },
      { body: <>Choose OAuth for authentication. There is no client ID, secret or API key to paste: the app registers itself.</> },
      { body: <>Sign in to Markdrop when the app opens it, and approve.</> },
    ],
  },
];

/** "Connect your app": pill tabs per MCP client, each with numbered steps and copyable snippets. */
export function ConnectTabs() {
  const [tab, setTab] = useState(CLIENTS[0]!.value);
  const client = CLIENTS.find((c) => c.value === tab) ?? CLIENTS[0]!;
  return (
    <div className="min-w-0">
      {/* Phones scroll the tab row sideways rather than wrapping it. */}
      <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <Tabs
          variant="pill"
          idPrefix="mcp-client"
          aria-label="AI app"
          value={tab}
          onChange={setTab}
          items={CLIENTS.map((c) => ({ value: c.value, label: c.label }))}
          className="w-max"
        />
      </div>

      <div
        role="tabpanel"
        id={`mcp-client-panel-${client.value}`}
        aria-labelledby={`mcp-client-tab-${client.value}`}
        tabIndex={0}
        className="md-focus mt-4 min-w-0 rounded-2xl border border-border bg-surface p-5 sm:p-6"
      >
        <h3 className="m-0 text-h4 text-text">{client.label}</h3>
        <p className="m-0 mt-1 text-body text-text-secondary">{client.intro}</p>
        <ol className="m-0 mt-5 flex list-none flex-col gap-4 p-0">
          {client.steps.map((st, i) => (
            <li key={i} className="flex min-w-0 gap-3">
              <span aria-hidden="true" className="grid size-6 flex-none place-items-center rounded-full bg-accent-soft text-micro font-bold text-accent-text">
                {i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">
                <p className="m-0 text-body text-text-secondary">{st.body}</p>
                {st.snippet && (
                  <CommandBlock
                    command={st.snippet.text}
                    label={st.snippet.label}
                    copyLabel={st.snippet.copy}
                    prompt={st.snippet.prompt ?? "$"}
                    wrap
                  />
                )}
              </div>
            </li>
          ))}
        </ol>
        {client.note && (
          <p className="m-0 mt-5 border-t border-border pt-4 text-caption text-text-muted">{client.note}</p>
        )}
      </div>
    </div>
  );
}

export default ConnectTabs;
