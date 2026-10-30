import { after } from "next/server";
import { handleMessage, setScheduler } from "@/docs/mcp";

/**
 * docs.<host>/mcp — the docs MCP server (Streamable HTTP, JSON responses, stateless, no auth).
 * The middleware rewrites the docs host's /mcp here. POST carries JSON-RPC; GET and DELETE answer
 * 405 (no event stream, no sessions). Any origin may call it: it reads public docs only and never
 * uses cookies. Protocol and tools: src/docs/mcp.ts.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 64 * 1024;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...CORS, ...extra },
  });
}

const notOffered = () =>
  json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Method not allowed: this server answers POST only." } }, 405, { allow: "POST, OPTIONS" });

export async function POST(req: Request): Promise<Response> {
  setScheduler((task) => after(task));
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } }, 413);
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } }, 413);
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const reply = await handleMessage(message, req.headers);
  return json(reply.body, reply.status);
}

export function GET() {
  return notOffered();
}

export function DELETE() {
  return notOffered();
}

export function OPTIONS(req: Request): Response {
  const asked = req.headers.get("access-control-request-headers") ?? "";
  const headers = /^[A-Za-z0-9!#$%&'*+\-.^_`|~,\s]{0,1000}$/.test(asked) && asked ? asked : "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id";
  return new Response(null, {
    status: 204,
    headers: { ...CORS, "access-control-allow-methods": "POST, GET, DELETE, OPTIONS", "access-control-allow-headers": headers, "access-control-max-age": "7200", vary: "Access-Control-Request-Headers" },
  });
}
