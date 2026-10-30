#!/usr/bin/env node
/**
 * docs:mcp-test — exercises the docs MCP server end to end over HTTP.
 *
 *   npm run docs:mcp-test                                  # http://docs.localhost:3000/mcp
 *   npm run docs:mcp-test -- http://docs.localhost:3410/mcp
 *   DOCS_MCP_URL=https://docs.markdrop.in/mcp npm run docs:mcp-test
 *
 * Checks: GET → 405 with Allow; initialize (version negotiation, unknown version → latest);
 * notifications/initialized → 202; ping; tools/list; each tool (search_docs, read_page with and
 * without prerequisites, whats_changed by date and by CLI version, report_problem); unknown tool
 * and unknown method errors; the 2026-07-28 envelope (server/discover, header checks).
 * report_problem really posts to the feedback endpoint unless --no-report is given.
 */
const args = process.argv.slice(2);
const URL_ = args.find((a) => /^https?:/.test(a)) || process.env.DOCS_MCP_URL || "http://docs.localhost:3000/mcp";
const NO_REPORT = args.includes("--no-report");
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };

let failed = 0;
let id = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function rpc(method, params, headers = {}) {
  const body = { jsonrpc: "2.0", id: ++id, method, ...(params !== undefined ? { params } : {}) };
  const res = await fetch(URL_, { method: "POST", headers: { ...H, ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const call = (name, a, headers) => rpc("tools/call", { name, arguments: a }, headers);
const textOf = (r) => r.body?.result?.content?.[0]?.text ?? "";

console.log(`docs MCP server: ${URL_}\n`);

{
  const res = await fetch(URL_);
  check("GET answers 405 with Allow: POST", res.status === 405 && /POST/.test(res.headers.get("allow") ?? ""), `${res.status} allow=${res.headers.get("allow")}`);
}
{
  const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "docs-mcp-test", version: "1" } });
  const res = r.body?.result;
  check("initialize negotiates 2025-06-18", res?.protocolVersion === "2025-06-18", res?.protocolVersion);
  check("initialize returns serverInfo, tools capability and instructions", res?.serverInfo?.name === "markdrop-docs" && !!res?.capabilities?.tools && res?.instructions?.length > 50);
  check("responses are application/json", (r.headers.get("content-type") ?? "").startsWith("application/json"));
  const old = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
  check("unknown version → latest handshake version", old.body?.result?.protocolVersion === "2025-11-25", old.body?.result?.protocolVersion);
}
{
  const res = await fetch(URL_, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  check("notifications/initialized → 202", res.status === 202, String(res.status));
}
{
  const r = await rpc("ping", undefined, { "mcp-protocol-version": "2025-06-18" });
  check("ping", r.status === 200 && r.body?.result && Object.keys(r.body.result).length === 0);
}
{
  const r = await rpc("tools/list", {}, { "mcp-protocol-version": "2025-06-18" });
  const names = (r.body?.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list has the four tools", JSON.stringify(names) === JSON.stringify(["read_page", "report_problem", "search_docs", "whats_changed"]), names.join(", "));
  check("every tool has an inputSchema", (r.body?.result?.tools ?? []).every((t) => t.inputSchema?.type === "object"));
}
{
  const r = await call("search_docs", { query: "custom domain DNS", limit: 5 });
  const results = r.body?.result?.structuredContent?.results ?? [];
  check("search_docs finds results", results.length > 0 && results.length <= 5, `${results.length} results; first: ${results[0]?.title} → ${results[0]?.url}`);
  check("search_docs results carry url#anchor and snippet", results.some((x) => /^https:\/\/docs\.[^/]+\/.+#.+/.test(x.url)) && results.every((x) => typeof x.snippet === "string"));
  const api = await call("search_docs", { query: "publish a document POST /api/v1/documents" });
  const hit = (api.body?.result?.structuredContent?.results ?? []).find((x) => x.url.includes("/api/documents/"));
  check("search_docs finds API reference pages", !!hit, hit?.url);
  const bad = await call("search_docs", {});
  check("search_docs without query is a tool error", bad.body?.result?.isError === true, textOf(bad));
}
{
  const r = await call("read_page", { path: "/workspaces/custom-domain" });
  check("read_page returns the page Markdown", /^---\ntitle: /.test(textOf(r)) && textOf(r).includes("canonical_url: "), `${textOf(r).length} chars`);
  const pre = await call("read_page", { path: "https://docs.markdrop.in/workspaces/custom-domain.md#x", include_prerequisites: true });
  const n = pre.body?.result?.structuredContent?.included_prerequisites ?? 0;
  check("read_page include_prerequisites adds the pages it builds on", n > 0 && textOf(pre).length > textOf(r).length, `${n} prerequisite page(s)`);
  const api = await call("read_page", { path: "/api/documents/publish-a-document" });
  check("read_page reads an API reference page", textOf(api).includes("POST https://api.markdrop.in/api/v1/documents") && textOf(api).includes("## Request body"));
  const missing = await call("read_page", { path: "/no/such-page" });
  check("read_page on a missing page is a tool error with suggestions", missing.body?.result?.isError === true && /No page at/.test(textOf(missing)), textOf(missing).slice(0, 120));
}
{
  const r = await call("whats_changed", { since_date: "2026-10-27" });
  const entries = r.body?.result?.structuredContent?.entries ?? [];
  check("whats_changed since_date", entries.length > 0 && entries.every((e) => e.date >= "2026-10-27"), `${entries.length} entries`);
  const v = await call("whats_changed", { since_cli_version: "0.4.0" });
  const ve = v.body?.result?.structuredContent?.entries ?? [];
  check("whats_changed since_cli_version", ve.length > 0 && ve.every((e) => e.date >= "2026-10-27"), ve.map((e) => e.id).join(", "));
  const latest = await call("whats_changed", {});
  check("whats_changed with no arguments → latest", (latest.body?.result?.structuredContent?.entries ?? []).length > 0);
  const bad = await call("whats_changed", { since_date: "yesterday" });
  check("whats_changed rejects a bad date", bad.body?.result?.isError === true);
}
if (!NO_REPORT) {
  const r = await call("report_problem", { page: "/cli/install", problem: "Test report from docs-mcp-test: please ignore." });
  check("report_problem answers ok", r.body?.result?.structuredContent?.ok === true && r.body?.result?.isError === false, textOf(r));
}
{
  const r = await call("no_such_tool", {});
  check("unknown tool → JSON-RPC invalid params", r.body?.error?.code === -32602);
  const m = await rpc("does/not/exist", {});
  check("unknown method → method not found", m.body?.error?.code === -32601);
  const extra = await call("search_docs", { query: "x", bogus: 1 });
  check("unknown argument → tool error", extra.body?.result?.isError === true);
}
{
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  const hdr = (method, name) => ({ "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(name ? { "mcp-name": name } : {}) });
  const d = await rpc("server/discover", { _meta: meta }, hdr("server/discover"));
  check("envelope era: server/discover", d.body?.result?.supportedVersions?.includes("2026-07-28") && d.body?.result?.resultType === "complete");
  const t = await rpc("tools/call", { _meta: meta, name: "search_docs", arguments: { query: "api token" } }, hdr("tools/call", "search_docs"));
  check("envelope era: tools/call", t.body?.result?.resultType === "complete" && t.body?.result?.isError === false);
  const mismatch = await rpc("tools/call", { _meta: meta, name: "search_docs", arguments: { query: "x" } }, hdr("tools/call", "read_page"));
  check("envelope era: Mcp-Name mismatch → 400", mismatch.status === 400 && mismatch.body?.error?.code === -32020);
}

console.log(`\n${failed ? `${failed} check(s) failed` : "All checks passed"}.`);
process.exit(failed ? 1 : 0);
