/**
 * How AI tools connect to a docs site's MCP server (`<docs origin>/mcp`, src/docs/mcp.ts): the
 * one-click install links and the steps for apps without one. Shared by the published pages'
 * Connect to AI actions (client/PageActions.tsx) and the Guides studio (Settings › Ask AI).
 *
 * Formats (checked against the vendors' docs, 2026-11):
 *   Cursor   cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the
 *            server's mcp.json entry, {"url": …}>  (cursor.com/docs/context/mcp/install-links)
 *   VS Code  vscode:mcp/install?<url-encoded {"name", "type": "http", "url"}>
 *            (code.visualstudio.com/docs/copilot/guides/mcp-developer-guide)
 *   Claude   no install link: Settings › Connectors › Add custom connector, paste the URL
 *            (support.claude.com, "custom connectors using remote MCP"); Claude Code: `claude mcp add`
 *   ChatGPT  developer mode (Plus, Pro, Business, Enterprise, Edu, on the web): create an app with
 *            the URL, no authentication (developers.openai.com, "ChatGPT Developer mode")
 */

/** The MCP server of the docs at `siteUrl` (any address on the site works; its origin is used). */
export function mcpServerUrl(siteUrl: string): string {
  try {
    return `${new URL(siteUrl).origin}/mcp`;
  } catch {
    return `${siteUrl.replace(/\/+$/, "")}/mcp`;
  }
}

function base64(text: string): string {
  // The config is ASCII (a URL), but stay safe for any name or host.
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The base64 config Cursor's link carries, as its docs show it: plain, not percent-encoded. A "+"
 * in it would read as a space in a query string, and "/" is better left out too, so the JSON is
 * padded with whitespace (still the same JSON) until its base64 has neither; percent-encoded only
 * if no padding manages it.
 */
export function cursorConfig(server: string): string {
  const json = JSON.stringify({ url: server });
  for (let lead = 0; lead < 3; lead++) {
    for (let trail = 0; trail < 3; trail++) {
      for (const body of [json, json.replace('{"url":', '{"url": '), json.replace('{"url":', '{ "url": ').replace(/}$/, " }")]) {
        const b = base64(" ".repeat(lead) + body + " ".repeat(trail));
        if (!/[+/]/.test(b)) return b;
      }
    }
  }
  return encodeURIComponent(base64(json));
}

export function cursorInstallUrl(name: string, server: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${cursorConfig(server)}`;
}

export function vscodeInstallUrl(name: string, server: string): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: "http", url: server }))}`;
}

/** Claude Code's one-liner. */
export function claudeCodeCommand(name: string, server: string): string {
  return `claude mcp add --transport http ${name} ${server}`;
}

/** Claude's Connectors settings (claude.ai and the desktop app share them). */
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

export interface McpLinks {
  server: string;
  cursor: string;
  vscode: string;
  claudeCode: string;
}

export function mcpLinks(siteUrl: string, name: string): McpLinks {
  const server = mcpServerUrl(siteUrl);
  return { server, cursor: cursorInstallUrl(name, server), vscode: vscodeInstallUrl(name, server), claudeCode: claudeCodeCommand(name, server) };
}

/** A custom-scheme link (cursor://, vscode:): assigned rather than routed, so nothing prefetches it. */
export function openAppLink(href: string): void {
  window.location.assign(href);
}
