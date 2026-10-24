"use client";

import { MCP_LOCAL_COMMAND, MCP_LOCAL_SERVER } from "@/lib/mcp";
import { AppTabs, Code, Path, type Client } from "./ConnectTabs";

const [COMMAND, ...ARGS] = MCP_LOCAL_COMMAND.split(" ");
const ARGS_JSON = JSON.stringify(ARGS);

const MCP_SERVERS_JSON = `{
  "mcpServers": {
    "${MCP_LOCAL_SERVER}": {
      "command": "${COMMAND}",
      "args": ${ARGS_JSON}
    }
  }
}`;

const VSCODE_JSON = `{
  "servers": {
    "${MCP_LOCAL_SERVER}": {
      "type": "stdio",
      "command": "${COMMAND}",
      "args": ${ARGS_JSON}
    }
  }
}`;

const CLAUDE_CODE = `claude mcp add ${MCP_LOCAL_SERVER} -- ${MCP_LOCAL_COMMAND}`;

const NOT_FOUND = (
  <>
    If the app says it can&apos;t find <Code>{COMMAND}</Code>, put the full path from <Code>which {COMMAND}</Code> (on Windows,{" "}
    <Code>where {COMMAND}</Code>) in <Code>command</Code>.
  </>
);

const LOCAL_CLIENTS: Client[] = [
  {
    value: "claude-code",
    label: "Claude Code",
    intro: <>In your terminal.</>,
    steps: [
      { body: <>Add the server:</>, snippet: { text: CLAUDE_CODE, label: "Terminal", copy: "Copy command" } },
      { body: <>Start Claude Code and run <Code>/mcp</Code>: {MCP_LOCAL_SERVER} shows as connected. There&apos;s nothing to sign in to.</> },
    ],
    note: <>Add <Code>--scope user</Code> to make it available in every project.</>,
  },
  {
    value: "claude-desktop",
    label: "Claude Desktop",
    intro: <>In Claude Desktop&apos;s config file.</>,
    steps: [
      { body: <>Open <Path>Settings → Developer → Edit Config</Path>.</> },
      {
        body: <>Add this to <Code>claude_desktop_config.json</Code>:</>,
        snippet: { text: MCP_SERVERS_JSON, label: "claude_desktop_config.json", copy: "Copy JSON", prompt: "" },
      },
      { body: <>Quit and reopen Claude Desktop. The Markdrop tools appear under the tools menu in a chat.</> },
    ],
    note: NOT_FOUND,
  },
  {
    value: "cursor",
    label: "Cursor",
    intro: <>In Cursor&apos;s MCP settings file.</>,
    steps: [
      {
        body: <>Add this to <Code>~/.cursor/mcp.json</Code>, or to <Code>.cursor/mcp.json</Code> in one project:</>,
        snippet: { text: MCP_SERVERS_JSON, label: "mcp.json", copy: "Copy JSON", prompt: "" },
      },
      { body: <>Open Cursor&apos;s MCP settings and check {MCP_LOCAL_SERVER} is turned on.</> },
    ],
    note: NOT_FOUND,
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
      { body: <>Choose <Path>Start</Path> above the server in that file, or run <Path>MCP: List Servers</Path>.</> },
    ],
    note: <>To use it in every workspace, run <Path>MCP: Open User Configuration</Path> and add the same entry.</>,
  },
];

/** "Send and receive files peer-to-peer": per-app steps for adding the CLI's local server. */
export function LocalServerTabs({ className }: { className?: string }) {
  return <AppTabs clients={LOCAL_CLIENTS} idPrefix="mcp-local" className={className} />;
}

export default LocalServerTabs;
