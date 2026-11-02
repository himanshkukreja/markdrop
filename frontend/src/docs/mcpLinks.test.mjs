// The docs MCP server's install links. Run: node --test src/docs/mcpLinks.test.mjs
// (Node >= 22.18 strips the types from mcpLinks.ts; it has no imports.)
import test from "node:test";
import assert from "node:assert/strict";
import { claudeCodeCommand, cursorConfig, cursorInstallUrl, mcpLinks, mcpServerUrl, vscodeInstallUrl } from "./mcpLinks.ts";

test("the server is the site's origin + /mcp", () => {
  assert.equal(mcpServerUrl("https://acme.guides.markdrop.in"), "https://acme.guides.markdrop.in/mcp");
  assert.equal(mcpServerUrl("https://docs.acme.com/guide/start#x"), "https://docs.acme.com/mcp");
  assert.equal(mcpServerUrl("http://localhost:4000/"), "http://localhost:4000/mcp");
});

test("Cursor: cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64 of {url}>", () => {
  for (const server of ["https://acme.guides.markdrop.in/mcp", "https://docs.markdrop.in/mcp", "https://a.b/mcp", "https://x-y-z.guides.markdrop.in/mcp", "http://localhost:4123/mcp"]) {
    const link = cursorInstallUrl("acme-docs", server);
    assert.match(link, /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=acme-docs&config=[A-Za-z0-9=]+$/);
    const config = link.split("config=")[1];
    // No "+" (a space in a query string) or "/": the plain base64 Cursor's docs show.
    assert.doesNotMatch(config, /[+/%]/);
    assert.deepEqual(JSON.parse(Buffer.from(config, "base64").toString("utf8")), { url: server });
    // A query-string parser reads it back unchanged.
    assert.equal(new URL(link.replace("cursor://", "https://")).searchParams.get("config"), config);
    assert.equal(cursorConfig(server), config);
  }
  assert.match(cursorInstallUrl("my docs", "https://a.b/mcp"), /name=my%20docs&/);
});

test("VS Code: vscode:mcp/install?<url-encoded {name, type: http, url}>", () => {
  const link = vscodeInstallUrl("acme-docs", "https://acme.guides.markdrop.in/mcp");
  assert.ok(link.startsWith("vscode:mcp/install?"));
  assert.deepEqual(JSON.parse(decodeURIComponent(link.slice("vscode:mcp/install?".length))), { name: "acme-docs", type: "http", url: "https://acme.guides.markdrop.in/mcp" });
});

test("Claude Code and the bundle", () => {
  assert.equal(claudeCodeCommand("acme-docs", "https://a.b/mcp"), "claude mcp add --transport http acme-docs https://a.b/mcp");
  const l = mcpLinks("https://a.b/x", "n");
  assert.deepEqual(Object.keys(l).sort(), ["claudeCode", "cursor", "server", "vscode"]);
  assert.equal(l.server, "https://a.b/mcp");
});
