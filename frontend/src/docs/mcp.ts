/**
 * The docs MCP server (docs.<host>/mcp): Streamable HTTP, JSON responses only, no session, no auth,
 * read-only. AI apps search and read these docs as tools instead of having pages pasted in.
 *
 * Protocol shapes follow the backend's MCP server (backend/app/mcp/protocol.py), both eras:
 *   handshake era (2024-11-05 … 2025-11-25): initialize → notifications/initialized → requests;
 *   envelope era (2026-07-28): no handshake; every request carries the protocol version in
 *     params._meta and repeats it (and the method, and the tool name) in headers.
 *
 * Tools answer from the content built into the deployment (content.ts / outputs.ts): no network,
 * except report_problem, which forwards to the docs feedback endpoint after the response is sent.
 */
import MiniSearch from "minisearch";
import { absoluteUrl, agentMarkdown, getChangelog, getPage, getSite, withPrerequisites } from "./content";
import { buildSearchIndex, entryMarkdown } from "./outputs";
import { apiBoost } from "./searchBoost";
import type { ChangelogEntry, SearchDoc } from "./types";

export const HANDSHAKE_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export const MODERN_VERSIONS = ["2026-07-28"];
const ALL_VERSIONS = [...HANDSHAKE_VERSIONS, ...MODERN_VERSIONS];
const LATEST_HANDSHAKE = "2025-11-25";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const LIST_TTL_MS = 5 * 60 * 1000;

const CAPABILITIES = { tools: { listChanged: false } };

function serverInfo() {
  const site = getSite();
  return { name: "markdrop-docs", title: site.name, version: "1.0.0" };
}

function instructions(): string {
  const site = getSite();
  const product = site.product?.name ?? site.name;
  return (
    `The official ${product} documentation (${site.url}). Use search_docs to find the sections that answer a question, ` +
    `then read_page for the full page (with include_prerequisites when the user is new to the topic). ` +
    `Link the user to the exact section url you used. whats_changed lists recent changes, by date or since a CLI version. ` +
    `If the docs are wrong, unclear or missing something, call report_problem with the page and what is wrong. ` +
    `If the docs don't answer the question, say so rather than guessing. This server only reads the docs: ` +
    `to publish or manage documents, use ${product}'s own MCP server.`
  );
}

/* ── tools ───────────────────────────────────────────────────────────────── */

class ToolError extends Error {}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ text: string; structured?: Record<string, unknown> }>;
}

let mini: MiniSearch<SearchDoc> | null = null;
function index(): MiniSearch<SearchDoc> {
  if (!mini) {
    mini = new MiniSearch<SearchDoc>({
      fields: ["title", "keywords", "where", "text"],
      storeFields: ["kind", "title", "where", "href", "snippet"],
      searchOptions: { boost: { title: 4, keywords: 2, where: 1.2 }, prefix: true, fuzzy: 0.15, boostDocument: apiBoost, combineWith: "OR" },
    });
    mini.addAll(buildSearchIndex());
  }
  return mini;
}

/** "/cli/install", "cli/install", "https://docs…/cli/install.md#x" → "/cli/install". */
export function normalizePath(input: string): string {
  let p = input.trim();
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    /* not a URL */
  }
  p = p.split("#")[0].split("?")[0].replace(/\.md$/, "").replace(/\/+$/, "");
  if (!p.startsWith("/")) p = "/" + p;
  return p === "/index" ? "/" : p || "/";
}

function str(args: Record<string, unknown>, key: string, { required = false, max = 2000 } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`${key} is required.`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`${key} must be a string.`);
  const t = v.trim();
  if (required && !t) throw new ToolError(`${key} can't be empty.`);
  if (t.length > max) throw new ToolError(`${key} is longer than ${max} characters.`);
  return t;
}

function search(query: string, limit: number) {
  const hits = index().search(query).slice(0, limit);
  return hits.map((h) => {
    const href = String(h.href);
    const pagePath = href.split("#")[0];
    const page = getPage(pagePath);
    return {
      kind: h.kind as string,
      title: h.title as string,
      page: page?.meta.title ?? (h.where as string),
      url: href.startsWith("/changelog/") ? `${getSite().url}${href}` : absoluteUrl(pagePath) + (href.includes("#") ? `#${href.split("#")[1]}` : ""),
      markdown_url: page ? `${getSite().url}${pagePath}.md` : undefined,
      snippet: h.snippet as string,
    };
  });
}

function semverParts(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function semverCmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const TOOLS: Tool[] = [
  {
    name: "search_docs",
    title: "Search the docs",
    description:
      "Search Markdrop's documentation. Returns the best-matching sections and pages, each with its title, the page it is on, a url that links straight to the section, and a short snippet. Then read the page with read_page.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in plain words: \"custom domain DNS\", \"replace a file and keep the link\".", maxLength: 500 },
        limit: { type: "integer", description: "How many results (1–20). Default 8.", minimum: 1, maximum: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const query = str(args, "query", { required: true, max: 500 })!;
      const raw = args.limit;
      if (raw !== undefined && (typeof raw !== "number" || !Number.isInteger(raw))) throw new ToolError("limit must be an integer.");
      const limit = Math.max(1, Math.min(20, (raw as number | undefined) ?? 8));
      const results = search(query, limit);
      if (!results.length) return { text: `No sections match "${query}". Try other words, or read ${getSite().url}/llms.txt for the list of pages.`, structured: { results: [] } };
      const text = results.map((r, i) => `${i + 1}. ${r.title} (${r.page})\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      return { text, structured: { results } };
    },
  },
  {
    name: "read_page",
    title: "Read a docs page",
    description:
      "Read one documentation page as Markdown, with frontmatter (title, canonical url, last update, prerequisites). Pass the page path from search_docs or llms.txt, like /workspaces/custom-domain. Set include_prerequisites to also get the pages it builds on, first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The page's path (/cli/install) or full docs url.", maxLength: 400 },
        include_prerequisites: { type: "boolean", description: "Also return the pages this one assumes you have read. Default false." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const raw = str(args, "path", { required: true, max: 400 })!;
      const pre = args.include_prerequisites;
      if (pre !== undefined && typeof pre !== "boolean") throw new ToolError("include_prerequisites must be true or false.");
      const path = normalizePath(raw);
      const page = getPage(path);
      if (!page) {
        const near = search(path.replace(/[/-]+/g, " ").trim(), 3);
        throw new ToolError(
          `No page at ${path}.` + (near.length ? ` Did you mean: ${near.map((n) => n.url.replace(getSite().url, "").split("#")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", ")}?` : "") + ` Every page is listed at ${getSite().url}/llms.txt.`,
        );
      }
      const bundle = pre ? withPrerequisites(page) : { markdown: agentMarkdown(page), count: 0 };
      return {
        text: bundle.markdown,
        structured: { path: page.path, title: page.meta.title, url: absoluteUrl(page.path), updated: page.meta.updated || null, prerequisites: page.meta.prerequisites ?? [], included_prerequisites: bundle.count },
      };
    },
  },
  {
    name: "whats_changed",
    title: "What changed",
    description:
      "Recent changes to Markdrop from its changelog, newest first, with the docs pages each one touched. Pass since_date (YYYY-MM-DD) for changes on or after a date, or since_cli_version (like 0.4.0) for what changed after that CLI release. With neither, returns the latest 10.",
    inputSchema: {
      type: "object",
      properties: {
        since_date: { type: "string", description: "Changes on or after this date, YYYY-MM-DD.", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        since_cli_version: { type: "string", description: "Changes after this CLI version, like 0.4.0.", maxLength: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(args) {
      const date = str(args, "since_date", { max: 10 });
      const ver = str(args, "since_cli_version", { max: 20 });
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ToolError("since_date must be YYYY-MM-DD.");
      const cl = getChangelog();
      let entries: ChangelogEntry[] = cl.entries;
      let scope = "Latest changes";
      if (date) {
        entries = entries.filter((e) => e.date >= date);
        scope = `Changes since ${date}`;
      }
      if (ver) {
        const v = semverParts(ver);
        if (!v) throw new ToolError("since_cli_version must look like 0.4.0.");
        const release = cl.entries.filter((e) => e.versions?.cli && semverParts(e.versions.cli) && semverCmp(semverParts(e.versions.cli)!, v) === 0).map((e) => e.date).sort()[0];
        entries = entries.filter((e) => {
          const ev = e.versions?.cli ? semverParts(e.versions.cli) : null;
          return (ev && semverCmp(ev, v) > 0) || (release !== undefined && e.date > release);
        });
        scope = `Changes after CLI ${ver.replace(/^v/, "")}`;
      }
      if (!date && !ver) entries = entries.slice(0, 10);
      const site = getSite();
      if (!entries.length) return { text: `${scope}: nothing in the changelog. Full changelog: ${site.url}/changelog.md`, structured: { entries: [] } };
      const text = `# ${scope}\n\n${entries.map((e) => entryMarkdown(e)).join("\n\n")}\n`;
      return {
        text,
        structured: {
          entries: entries.map((e) => ({ id: e.id, date: e.date, title: e.title, kind: e.kind, area: e.area, products: e.products, versions: e.versions ?? {}, summary: e.summary, url: `${site.url}/changelog/${e.id}`, docs: e.docs ?? [] })),
        },
      };
    },
  },
  {
    name: "report_problem",
    title: "Report a docs problem",
    description:
      "Tell the Markdrop docs team that a page is wrong, out of date, unclear or missing something. Say which page and what the problem is, in a sentence or two. Never include personal data or secrets.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "The page's path or url, like /cli/upload-and-replace.", maxLength: 400 },
        problem: { type: "string", description: "What is wrong or missing.", maxLength: 2000 },
      },
      required: ["page", "problem"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args) {
      const page = normalizePath(str(args, "page", { required: true, max: 400 })!);
      const problem = str(args, "problem", { required: true, max: 2000 })!;
      sendReport(page, problem);
      return { text: `Thanks. The report on ${absoluteUrl(page)} was sent to the Markdrop docs team.`, structured: { ok: true, page } };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Scheduled by the route handler (Next's `after`), so the reply never waits on the API. */
let schedule: (task: () => Promise<void>) => void = (task) => void task();
export function setScheduler(fn: (task: () => Promise<void>) => void) {
  schedule = fn;
}

function sendReport(path: string, problem: string) {
  const url = getSite().feedback;
  if (!url) return;
  schedule(async () => {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, helpful: false, comment: `[docs MCP] ${problem}` }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* fire and forget */
    }
  });
}

function listing(t: Tool) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } };
}

/* ── JSON-RPC ────────────────────────────────────────────────────────────── */

export interface Reply {
  status: number;
  body?: unknown;
}

type Msg = Record<string, unknown>;
type Id = string | number | null;

const error = (status: number, id: Id, code: number, message: string, data?: unknown): Reply => ({
  status,
  body: { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
});
const result = (id: Id, r: unknown): Reply => ({ status: 200, body: { jsonrpc: "2.0", id, result: r } });

function decodeHeader(v: string | null): string | null {
  if (v === null) return null;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  try {
    const decoded = Buffer.from(m[1], "base64");
    return decoded.toString("base64") === m[1] ? decoded.toString("utf8") : null;
  } catch {
    return null;
  }
}

async function callTool(id: Id, params: Msg, modern: boolean): Promise<Reply> {
  const name = params.name;
  const tool = typeof name === "string" ? BY_NAME.get(name) : undefined;
  if (!tool) return error(modern ? 400 : 200, id, INVALID_PARAMS, `Unknown tool: ${String(name).slice(0, 80)}`);
  const args = params.arguments ?? {};
  let out: Record<string, unknown>;
  try {
    if (typeof args !== "object" || Array.isArray(args) || args === null) throw new ToolError("arguments must be an object.");
    const allowed = Object.keys((tool.inputSchema.properties as Record<string, unknown>) ?? {});
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length) throw new ToolError(`Unknown argument: ${extra[0].slice(0, 40)}. This tool takes ${allowed.join(", ")}.`);
    const r = await tool.run(args as Record<string, unknown>);
    out = { content: [{ type: "text", text: r.text }], isError: false, ...(r.structured ? { structuredContent: r.structured } : {}) };
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : "Something went wrong reading the docs. Try again in a moment.";
    if (!(e instanceof ToolError)) console.error("[docs-mcp]", tool.name, e);
    out = { content: [{ type: "text", text: msg }], isError: true };
  }
  if (modern) out.resultType = "complete";
  return result(id, out);
}

async function handshake(id: Id, method: string, params: Msg, headers: Headers): Promise<Reply> {
  const vh = headers.get("mcp-protocol-version");
  if (method !== "initialize" && vh !== null && !ALL_VERSIONS.includes(vh))
    return error(400, id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: vh });
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const version = typeof requested === "string" && HANDSHAKE_VERSIONS.includes(requested) ? requested : LATEST_HANDSHAKE;
      return result(id, { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: serverInfo(), instructions: instructions() });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS.map(listing) });
    case "tools/call":
      return callTool(id, params, false);
    case "resources/list":
      return result(id, { resources: [] });
    case "resources/templates/list":
      return result(id, { resourceTemplates: [] });
    case "prompts/list":
      return result(id, { prompts: [] });
    default:
      return error(200, id, METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 80)}`);
  }
}

async function modern(id: Id, method: string, params: Msg, meta: Msg, headers: Headers): Promise<Reply> {
  if (!(CLIENT_CAPABILITIES_META in meta))
    return error(400, id, INVALID_PARAMS, `params._meta is missing the required envelope key: ${CLIENT_CAPABILITIES_META}`);
  const version = meta[PROTOCOL_VERSION_META];
  if (headers.get("mcp-protocol-version") !== version)
    return error(400, id, HEADER_MISMATCH, "MCP-Protocol-Version header does not match the request envelope's protocol version");
  if (headers.get("mcp-method") !== method) return error(400, id, HEADER_MISMATCH, "Mcp-Method header does not match the request body's method");
  if (method === "tools/call" && params.name !== undefined && decodeHeader(headers.get("mcp-name")) !== params.name)
    return error(400, id, HEADER_MISMATCH, "Mcp-Name header does not match the request body's 'name' parameter");
  if (typeof version !== "string") return error(400, id, INVALID_PARAMS, "The protocol-version envelope value must be a string.");
  if (!MODERN_VERSIONS.includes(version)) return error(400, id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: version });
  const cacheable = (r: Msg) => ({ ...r, resultType: "complete", cacheScope: "public", ttlMs: LIST_TTL_MS });
  switch (method) {
    case "server/discover":
      return result(id, cacheable({ supportedVersions: ALL_VERSIONS, capabilities: CAPABILITIES, instructions: instructions(), _meta: { [SERVER_INFO_META]: serverInfo() } }));
    case "tools/list":
      return result(id, cacheable({ tools: TOOLS.map(listing) }));
    case "tools/call":
      return callTool(id, params, true);
    case "resources/list":
      return result(id, cacheable({ resources: [] }));
    case "prompts/list":
      return result(id, cacheable({ prompts: [] }));
    case "ping":
      return result(id, { resultType: "complete" });
    default:
      return error(404, id, METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 80)}`);
  }
}

/** Answer one decoded JSON-RPC message. */
export async function handleMessage(message: unknown, headers: Headers): Promise<Reply> {
  if (Array.isArray(message)) return error(400, null, INVALID_REQUEST, "Batch requests are not supported.");
  if (!message || typeof message !== "object" || (message as Msg).jsonrpc !== "2.0") return error(400, null, INVALID_REQUEST, "Expected a JSON-RPC 2.0 message.");
  const m = message as Msg;
  if (!("method" in m)) {
    if ("id" in m && ("result" in m || "error" in m)) return { status: 202 };
    return error(400, (m.id as Id) ?? null, INVALID_REQUEST, "Expected a request or notification.");
  }
  if (typeof m.method !== "string") return error(400, (m.id as Id) ?? null, INVALID_REQUEST, "method must be a string.");
  if (!("id" in m)) return { status: 202 }; // notifications: initialized, cancelled, progress…
  const id = m.id;
  if (typeof id === "boolean" || (typeof id !== "string" && typeof id !== "number")) return error(400, null, INVALID_REQUEST, "id must be a string or an integer.");
  const params = m.params;
  if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) return error(400, id, INVALID_PARAMS, "params must be an object.");
  const p = (params ?? {}) as Msg;
  const meta = p._meta;
  if (meta && typeof meta === "object" && PROTOCOL_VERSION_META in (meta as Msg)) return modern(id, m.method, p, meta as Msg, headers);
  return handshake(id, m.method, p, headers);
}

export const DOCS_MCP_TOOLS = TOOLS.map((t) => t.name);
