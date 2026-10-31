/**
 * The generated API reference: OpenAPI 3 description + a prose overlay → one page per operation.
 *
 * Plain JavaScript with no imports, so the same code runs in the Next.js build (content.ts adds the
 * pages), in the browser (Try it builds its command with `curlCommand`) and in `docs:check` (which
 * validates every generated page like a written one). Types: openapi.d.mts.
 *
 * Sources, by precedence:
 *   overlay.operations["METHOD /path"]  title, description, group, CLI / MCP equivalents, examples,
 *                                       extra responses — written by people, checked by docs:check
 *   the operation's FastAPI docstring   description, tidied (internal ticket refs dropped)
 *   the schema                          parameters, body fields, types, limits, enums, defaults
 *   the vendor extension                auth ("token" | "optional" | "none" | "session") and the
 *   (opts.extension, default x-docs;    route's rate limits as written in the code
 *   Markdrop's export writes x-markdrop)
 * Hidden: overlay.hide.tags / hide.operations. An operation no group claims lands in "More", and
 * docs:check warns until someone places it.
 *
 * Token wording comes from opts: `tokenEnv` (the variable samples read, default API_TOKEN),
 * `tokenPrefix` (placeholders like `mdk_…`) and `sessionHost` (whose sign-in a session-only route
 * takes).
 *
 * `opts.auto` (a guide's API reference: a description someone else wrote, no overlay): groups come
 * from the description's tags (in `tags` order, then as first used; untagged operations go under
 * "Endpoints"), titles from `summary`, else `operationId`, else METHOD /path (slugs made unique),
 * descriptions as written, examples from the description's `example`/`examples`, servers from
 * `servers` (variables at their defaults; every absolute one is offered to Try it) and auth from
 * `security` + `components.securitySchemes` (bearer, basic, API key in a header, query or cookie;
 * OAuth 2.0 and OpenID Connect send a bearer access token). An operation that doesn't build is left
 * out with a problem instead of failing the whole reference. The reference also gets an overview
 * page (`overview`): base URLs, authentication and every endpoint by group.
 */

const METHODS = ["get", "post", "put", "patch", "delete"];
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* ── small helpers ──────────────────────────────────────────────────────── */

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const fmtInt = (n) => Number(n).toLocaleString("en-US");

/** `X-Edit-Secret` for `x-edit-secret`. */
export function headerName(n) {
  return n
    .split("-")
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join("-");
}

/** A FastAPI docstring made fit for readers: RST double backticks, internal ticket refs and file paths removed. */
export function tidyDocstring(s) {
  if (!s) return "";
  return s
    .replace(/``([^`]+)``/g, "`$1`")
    .replace(/^\s*[A-Z]\d{1,2}:\s+/, "")
    .replace(/\s*\((?:[A-Z]\d{1,2}(?:\/[A-Z]\d{1,2})*|§[\d.]+[^)]*)\)/g, "")
    .replace(/\s*\(services\/[\w/.]+\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/([^\n])\n(?!\n|\s*[-*] )/g, "$1 ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function firstSentence(md, max = 160) {
  const plain = md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(plain);
  let s = (m ? m[1] : plain).trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return s;
}

/** "listOrders", "list_orders" → "List orders". */
export function humanize(id) {
  const words = String(id ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** A `servers` entry's URL with its variables at their defaults, no trailing slash. */
function serverUrl(s) {
  let url = String(s?.url ?? "");
  for (const [k, v] of Object.entries(s?.variables || {})) url = url.split(`{${k}}`).join(String(v?.default ?? ""));
  return url.replace(/\/+$/, "");
}

/** The absolute http(s) servers of a `servers` list: [{url, description}], each URL once. */
export function serversOf(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const url = serverUrl(s);
    if (!/^https?:\/\/[^/\s]+/i.test(url) || /[{}\s]/.test(url) || out.some((x) => x.url === url)) continue;
    out.push({ url, ...(typeof s.description === "string" && s.description.trim() ? { description: s.description.trim().slice(0, 120) } : {}) });
  }
  return out;
}

/** `X-API-Key` → `X_API_KEY`: the environment variable a sample reads a credential from. */
function credentialEnv(name, fallback) {
  const v = String(name ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return v && /^[A-Z_]/.test(v) ? v : fallback;
}

/**
 * The security schemes an operation takes (auto mode): every scheme any of its requirements names,
 * each once, `primary` on the ones of its first requirement (what the samples send). Kinds:
 * "bearer" (HTTP bearer, OAuth 2.0, OpenID Connect), "basic", "apiKey" (in a header, the query or a
 * cookie); anything else is "other" (shown, not sent).
 */
function securityOf(reqs, schemes, ctx) {
  const out = [];
  reqs.forEach((req, i) => {
    for (const id of Object.keys(req || {})) {
      if (out.some((s) => s.id === id)) {
        if (i === 0) out.find((s) => s.id === id).primary = true;
        continue;
      }
      let raw;
      try {
        raw = ctx.resolve(schemes[id] || {}).schema;
      } catch {
        raw = {};
      }
      const description = typeof raw.description === "string" ? raw.description.trim() : "";
      const type = String(raw.type || "").toLowerCase();
      const httpScheme = String(raw.scheme || "").toLowerCase();
      let s;
      if ((type === "http" && httpScheme === "bearer") || type === "oauth2" || type === "openidconnect")
        s = {
          kind: "bearer",
          in: "header",
          name: "Authorization",
          label: type === "oauth2" ? "OAuth 2.0 access token" : type === "openidconnect" ? "OpenID Connect token" : "Bearer token",
          env: ctx.auth.tokenEnv,
          ...(raw.bearerFormat ? { format: String(raw.bearerFormat).slice(0, 40) } : {}),
        };
      else if (type === "http" && httpScheme === "basic") s = { kind: "basic", in: "header", name: "Authorization", label: "Username and password", env: "API_USER" };
      else if (type === "apikey" && ["header", "query", "cookie"].includes(raw.in) && typeof raw.name === "string" && raw.name)
        s = { kind: "apiKey", in: raw.in, name: raw.name, label: "API key", env: credentialEnv(raw.name, "API_KEY") };
      else s = { kind: "other", in: "header", name: "", label: type ? `${type}${httpScheme ? ` (${httpScheme})` : ""}` : id, env: "" };
      out.push({ id, ...s, description, primary: i === 0 });
    }
  });
  return out;
}

/* ── schemas ────────────────────────────────────────────────────────────── */

function makeResolver(spec) {
  return function resolve(schema, seen = new Set()) {
    let s = schema || {};
    let name;
    let guard = 0;
    while (s && s.$ref && guard++ < 20) {
      const ref = s.$ref;
      if (!ref.startsWith("#/")) break;
      name = ref.split("/").pop();
      if (seen.has(ref)) return { schema: {}, name, cyclic: true };
      seen = new Set(seen).add(ref);
      s = ref
        .slice(2)
        .split("/")
        .reduce((o, k) => (o ? o[decodeURIComponent(k.replace(/~1/g, "/").replace(/~0/g, "~"))] : undefined), spec);
      if (!s) throw new Error(`unresolved $ref ${ref}`);
    }
    return { schema: s, name, seen };
  };
}

/** {nullable, schema} with `anyOf: [X, null]` unwrapped. */
function unwrapNull(s) {
  const alts = s.anyOf || s.oneOf;
  if (Array.isArray(alts)) {
    const rest = alts.filter((a) => a.type !== "null");
    if (rest.length < alts.length) {
      if (rest.length === 1) return { nullable: true, schema: { ...rest[0], ...(s.default !== undefined ? { default: s.default } : {}) } };
      return { nullable: true, schema: { ...s, anyOf: rest, oneOf: undefined } };
    }
  }
  return { nullable: false, schema: s };
}

function typeLabel(s, resolve) {
  const r = resolve(s);
  const { schema } = unwrapNull(r.schema);
  if (schema.$ref) return typeLabel(schema, resolve);
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const alts = schema.anyOf || schema.oneOf;
  if (Array.isArray(alts)) return alts.map((a) => typeLabel(a, resolve)).join(" | ");
  if (schema.type === "array") return `array of ${typeLabel(schema.items || {}, resolve)}`;
  if (schema.type === "string" && schema.format === "binary") return "file";
  if (schema.type === "string" && (schema.format === "date-time" || schema.format === "date")) return `string (${schema.format})`;
  if (schema.type === "string" && schema.format === "email") return "string (email)";
  if (schema.type === "object" || schema.properties) return "object";
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return schema.type || "any";
}

function constraintText(s) {
  const out = [];
  const len = (a, b, unit) => {
    if (a !== undefined && b !== undefined) out.push(a === b ? `Exactly ${fmtInt(a)} ${unit}.` : `${fmtInt(a)}–${fmtInt(b)} ${unit}.`);
    else if (b !== undefined) out.push(`Up to ${fmtInt(b)} ${unit}.`);
    else if (a !== undefined && a > 1) out.push(`At least ${fmtInt(a)} ${unit}.`);
  };
  len(s.minLength, s.maxLength, "characters");
  len(s.minItems, s.maxItems, "items");
  if (s.minimum !== undefined && s.maximum !== undefined) out.push(`From ${fmtInt(s.minimum)} to ${fmtInt(s.maximum)}.`);
  else if (s.maximum !== undefined) out.push(`At most ${fmtInt(s.maximum)}.`);
  else if (s.minimum !== undefined && s.minimum !== 0) out.push(`At least ${fmtInt(s.minimum)}.`);
  if (s.pattern) {
    const alt = /^\^\(([\w|-]+)\)\$$/.exec(s.pattern);
    if (alt) out.push(`One of ${alt[1].split("|").map((x) => `\`${x}\``).join(", ")}.`);
    else out.push(`Matches \`${s.pattern}\`.`);
  }
  if (s.format === "date-time") out.push("ISO 8601, for example `2026-11-30T12:00:00Z`.");
  return out.join(" ");
}

/** Pattern `^(a|b|c)$` → enum, so the field list and Try it can offer the choices. */
function patternEnum(s) {
  const m = s.pattern && /^\^\(([\w|-]+)\)\$$/.exec(s.pattern);
  return m ? m[1].split("|") : undefined;
}

/**
 * A schema's properties as display fields (nested objects and arrays of objects to `depth`).
 * `notes` maps "SchemaName.prop" (or "prop" for any schema) to a description.
 */
function fieldsOf(schema, ctx, depth = 2, seen = new Set()) {
  const r = ctx.resolve(schema, seen);
  let { schema: s } = unwrapNull(r.schema);
  if (s.$ref) return fieldsOf(s, ctx, depth, r.seen || seen);
  const owner = r.name;
  if (!s.properties) return [];
  const required = new Set(s.required || []);
  const fields = [];
  for (const [name, raw] of Object.entries(s.properties)) {
    const pr = ctx.resolve(raw, r.seen || seen);
    const { nullable, schema: ps0 } = unwrapNull(pr.schema);
    const ps = ps0.$ref ? unwrapNull(ctx.resolve(ps0, pr.seen || seen).schema).schema : ps0;
    const note = (owner && ctx.notes[`${owner}.${name}`]) ?? ctx.notes[name];
    const desc = note !== undefined ? note : raw.description || ps.description || "";
    const enumVals = Array.isArray(ps.enum) ? ps.enum : patternEnum(ps);
    const f = {
      name,
      type: typeLabel(raw, ctx.resolve),
      nullable,
      required: required.has(name),
      description: desc,
      constraints: constraintText(ps),
    };
    if (enumVals) f.enum = enumVals;
    if (raw.default !== undefined || ps.default !== undefined) f.default = raw.default !== undefined ? raw.default : ps.default;
    if (ctx.auto) {
      const ex = raw.example !== undefined ? raw.example : ps.example !== undefined ? ps.example : Array.isArray(ps.examples) ? ps.examples[0] : undefined;
      if (ex !== undefined) f.example = ex;
    }
    if (ps.format === "binary") f.binary = true;
    if (ps.type === "boolean") f.kind = "boolean";
    else if (ps.type === "integer" || ps.type === "number") f.kind = "number";
    else if (ps.type === "array") f.kind = "array";
    else if (ps.type === "object" || ps.properties || ps0.$ref) f.kind = "object";
    else f.kind = "string";
    if (depth > 1) {
      const target = ps.type === "array" ? ps.items : ps0.$ref ? ps0 : ps.properties ? ps : null;
      if (target) {
        const kids = fieldsOf(target, ctx, depth - 1, pr.seen || seen);
        if (kids.length) f.children = kids;
      }
    }
    fields.push(f);
  }
  return fields;
}

/* ── examples ───────────────────────────────────────────────────────────── */

function exampleFor(name, f, ctx) {
  if (ctx.examples[name] !== undefined) return ctx.examples[name];
  if (f.example !== undefined) return f.example;
  if (f.enum?.length) return f.default !== undefined ? f.default : f.enum[0];
  if (f.default !== undefined && f.default !== null) return f.default;
  switch (f.kind) {
    case "boolean":
      return true;
    case "number":
      return 1;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return name.toUpperCase();
  }
}

/** The body an example sends: the overlay's, or every required field with a sample value. */
function exampleBody(op, ctx) {
  if (op.overlay.example !== undefined) return op.overlay.example;
  if (!op.body) return undefined;
  if (op.bodyExample !== undefined) return op.bodyExample;
  const out = {};
  for (const f of op.body.fields) if (f.required) out[f.name] = exampleFor(f.name, f, ctx);
  return out;
}

/* ── code samples ───────────────────────────────────────────────────────── */

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function jsonText(v, indent) {
  const one = JSON.stringify(v);
  if (one.length <= 72) return one;
  return JSON.stringify(v, null, 2)
    .split("\n")
    .map((l, i) => (i ? indent + l : l))
    .join("\n");
}

function pyLiteral(v, indent = "") {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const one = `[${v.map((x) => pyLiteral(x)).join(", ")}]`;
    if (one.length <= 60) return one;
    return `[\n${v.map((x) => `${indent}    ${pyLiteral(x, indent + "    ")},`).join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(v);
  if (!entries.length) return "{}";
  const one = `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`).join(", ")}}`;
  if (one.length <= 60) return one;
  return `{\n${entries.map(([k, x]) => `${indent}    ${JSON.stringify(k)}: ${pyLiteral(x, indent + "    ")},`).join("\n")}\n${indent}}`;
}

/**
 * The request a sample (or Try it) sends.
 * @param {object} op       a generated operation
 * @param {object} values   {path: {}, query: {}, header: {}, body: object|undefined, files: {}}
 */
export function requestUrl(op, values) {
  let p = op.apiPath.replace(/\{([^}]+)\}/g, (m, n) => {
    const v = values.path?.[n];
    return v === undefined || v === null || v === "" ? m : encodeURIComponent(String(v));
  });
  const q = Object.entries(values.query || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (q.length) p += "?" + q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return op.server + p;
}

const TOKEN_ENV = "API_TOKEN";

/** The environment variable samples read the token from (a safe name, else API_TOKEN). */
function envName(v) {
  return typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? v : TOKEN_ENV;
}

/**
 * The credentials a request carries, for an operation with `security` (auto mode). With
 * `credentials` ({scheme id: value}; basic: "user:password"), the ones filled in, as literals (Try
 * it); without, the operation's primary schemes, read from environment variables (samples).
 * → [{scheme, literal?: string}]
 */
function credentialsFor(op, credentials) {
  const usable = (op.security || []).filter((s) => s.kind !== "other");
  if (credentials) return usable.filter((s) => credentials[s.id]).map((s) => ({ scheme: s, literal: String(credentials[s.id]) }));
  return usable.filter((s) => s.primary).map((s) => ({ scheme: s }));
}

/** `name=value` appended to a URL's query. */
const withQuery = (url, pair) => url + (url.includes("?") ? "&" : "?") + pair;

/**
 * `curl` for one request. `token`: the literal token to put in the command (Try it), else the
 * command reads $<tokenEnv> (default $API_TOKEN). Headers with an empty value are left out. An
 * operation with `security` (auto mode) takes `credentials` instead of `token`.
 */
export function curlCommand(op, values, { token, tokenEnv, credentials } = {}) {
  const lines = [];
  const method = op.method.toUpperCase();
  let url = requestUrl(op, values);
  if (op.security) {
    // A credential read from the environment needs double quotes for $VAR to expand.
    const env = (s) => `$${s.kind === "basic" ? "API_USER:$API_PASSWORD" : s.env}`;
    const auth = [];
    let expands = false;
    for (const { scheme: s, literal } of credentialsFor(op, credentials)) {
      const lit = literal !== undefined;
      if (s.kind === "bearer") auth.push(`-H ${lit ? shq(`Authorization: Bearer ${literal}`) : `"Authorization: Bearer ${env(s)}"`}`);
      else if (s.kind === "basic") auth.push(`-u ${lit ? shq(literal) : `"${env(s)}"`}`);
      else if (s.in === "header") auth.push(`-H ${lit ? shq(`${s.name}: ${literal}`) : `"${s.name}: ${env(s)}"`}`);
      else if (s.in === "cookie") auth.push(`-b ${lit ? shq(`${s.name}=${literal}`) : `"${s.name}=${env(s)}"`}`);
      else {
        url = withQuery(url, `${encodeURIComponent(s.name)}=${lit ? encodeURIComponent(literal) : env(s)}`);
        if (!lit) expands = true;
      }
    }
    const shown = expands ? `"${url.replace(/["\\`]/g, "\\$&")}"` : /^[\w.:/%-]+$/.test(url) ? url : shq(url);
    lines.push(`curl ${method === "GET" ? "" : `-X ${method} `}${shown}`, ...auth);
  } else {
    lines.push(`curl ${method === "GET" ? "" : `-X ${method} `}${/^[\w.:/%-]+$/.test(url) ? url : shq(url)}`);
    if (op.auth === "token" || op.auth === "optional" || token) {
      if (token !== "") lines.push(`-H ${token ? shq(`Authorization: Bearer ${token}`) : `"Authorization: Bearer $${envName(tokenEnv)}"`}`);
    }
  }
  for (const [k, v] of Object.entries(values.header || {})) if (v !== undefined && v !== "") lines.push(`-H ${shq(`${headerName(k)}: ${v}`)}`);
  if (op.body && op.body.contentType === "multipart/form-data") {
    for (const f of op.body.fields) {
      const v = values.files?.[f.name] ?? (f.binary ? undefined : values.body?.[f.name]);
      if (f.binary) lines.push(`-F ${shq(`${f.name}=@${values.files?.[f.name] || "logo.png"}`)}`);
      else if (v !== undefined) lines.push(`-F ${shq(`${f.name}=${v}`)}`);
    }
  } else if (values.body !== undefined && op.body) {
    lines.push(`-H "Content-Type: application/json"`);
    lines.push(`-d ${shq(jsonText(values.body, "     "))}`);
  }
  return lines.join(" \\\n  ");
}

function jsSample(op, values, tokenEnv) {
  let url = requestUrl(op, values);
  let target = null;
  const method = op.method.toUpperCase();
  const headers = [];
  if (op.security) {
    const query = [];
    for (const { scheme: s } of credentialsFor(op)) {
      if (s.kind === "bearer") headers.push(`Authorization: \`Bearer \${process.env.${s.env}}\``);
      else if (s.kind === "basic") headers.push("Authorization: `Basic ${btoa(`${process.env.API_USER}:${process.env.API_PASSWORD}`)}`");
      else if (s.in === "header") headers.push(`${JSON.stringify(s.name)}: process.env.${s.env}`);
      else if (s.in === "cookie") headers.push(`Cookie: \`${s.name}=\${process.env.${s.env}}\``);
      else query.push(`${encodeURIComponent(s.name)}=\${process.env.${s.env}}`);
    }
    // A key in the query: a template literal reads it from the environment.
    if (query.length) target = "`" + query.reduce((u, q) => withQuery(u, q), url.replace(/[`\\$]/g, "\\$&")) + "`";
  } else if (op.auth === "token" || op.auth === "optional") headers.push(`Authorization: \`Bearer \${process.env.${envName(tokenEnv)}}\``);
  for (const [k, v] of Object.entries(values.header || {})) if (v) headers.push(`${JSON.stringify(headerName(k))}: ${JSON.stringify(String(v))}`);
  const opts = [];
  if (method !== "GET") opts.push(`method: ${JSON.stringify(method)}`);
  let pre = "";
  if (op.body?.contentType === "multipart/form-data") {
    pre = `const form = new FormData();\n${op.body.fields
      .filter((f) => f.binary)
      .map((f) => `form.append(${JSON.stringify(f.name)}, new Blob([await readFile("logo.png")]), "logo.png");`)
      .join("\n")}\n\n`;
    pre = `import { readFile } from "node:fs/promises";\n\n` + pre;
    opts.push("body: form");
  } else if (values.body !== undefined && op.body) {
    headers.push(`"Content-Type": "application/json"`);
    const body = JSON.stringify(values.body, null, 2).split("\n").join("\n  ");
    opts.push(`body: JSON.stringify(${body})`);
  }
  if (headers.length) opts.splice(method !== "GET" ? 1 : 0, 0, `headers: {\n    ${headers.join(",\n    ")},\n  }`);
  const to = target ?? JSON.stringify(url);
  const call = opts.length ? `await fetch(${to}, {\n  ${opts.join(",\n  ")},\n})` : `await fetch(${to})`;
  const read =
    op.returns === "none"
      ? `if (!res.ok) throw new Error(\`\${res.status}\`);`
      : op.returns && op.returns !== "application/json"
        ? `const data = await res.${op.returns.startsWith("text/") ? "text" : "blob"}();`
        : "const data = await res.json();";
  return `${pre}const res = ${call};\n${read}`;
}

function pySample(op, values, tokenEnv) {
  const url = requestUrl(op, values);
  const method = op.method.toLowerCase();
  const args = [JSON.stringify(url)];
  const creds = op.security ? credentialsFor(op) : null;
  const needsOs = creds ? creds.length > 0 : op.auth === "token" || op.auth === "optional";
  const headers = [];
  const extra = [];
  if (creds) {
    const params = [];
    const cookies = [];
    for (const { scheme: s } of creds) {
      if (s.kind === "bearer") headers.push(`"Authorization": f"Bearer {os.environ['${s.env}']}"`);
      else if (s.kind === "basic") extra.push(`auth=(os.environ["API_USER"], os.environ["API_PASSWORD"])`);
      else if (s.in === "header") headers.push(`${JSON.stringify(s.name)}: os.environ["${s.env}"]`);
      else if (s.in === "cookie") cookies.push(`${JSON.stringify(s.name)}: os.environ["${s.env}"]`);
      else params.push(`${JSON.stringify(s.name)}: os.environ["${s.env}"]`);
    }
    if (params.length) extra.push(`params={${params.join(", ")}}`);
    if (cookies.length) extra.push(`cookies={${cookies.join(", ")}}`);
  } else if (needsOs) headers.push(`"Authorization": f"Bearer {os.environ['${envName(tokenEnv)}']}"`);
  for (const [k, v] of Object.entries(values.header || {})) if (v) headers.push(`${JSON.stringify(headerName(k))}: ${JSON.stringify(String(v))}`);
  if (headers.length) args.push(`headers={${headers.join(", ")}}`);
  args.push(...extra);
  if (op.body?.contentType === "multipart/form-data") {
    const f = op.body.fields.find((x) => x.binary);
    if (f) args.push(`files={${JSON.stringify(f.name)}: open("logo.png", "rb")}`);
  } else if (values.body !== undefined && op.body) args.push(`json=${pyLiteral(values.body, "    ")}`);
  const call = args.length === 1 ? `r = requests.${method}(${args[0]})` : `r = requests.${method}(\n    ${args.join(",\n    ")},\n)`;
  const read =
    op.returns === "none"
      ? ""
      : op.returns && op.returns !== "application/json"
        ? op.returns.startsWith("text/")
          ? "\nprint(r.text)"
          : `\nopen("out.${op.returns.split("/")[1]}", "wb").write(r.content)`
        : "\nprint(r.json())";
  return `${needsOs ? "import os\n\n" : ""}import requests\n\n${call}\nr.raise_for_status()${read}`;
}

/** Values the static samples use: overlay examples, else name-based placeholders. */
export function sampleValues(op, ctx) {
  const v = { path: {}, query: {}, header: {}, body: exampleBody(op, ctx), files: {} };
  for (const p of op.params) {
    const ex = op.overlay.params?.[p.name] ?? ctx.examples[p.name] ?? p.example;
    if (p.in === "path") v.path[p.name] = ex ?? p.name.toUpperCase();
    else if (p.in === "query" && (p.required || op.overlay.params?.[p.name] !== undefined)) v.query[p.name] = ex ?? p.default ?? p.name.toUpperCase();
    else if (p.in === "header" && (p.required || op.overlay.params?.[p.name] !== undefined)) v.header[p.name] = ex;
  }
  return v;
}

/* ── the reference ──────────────────────────────────────────────────────── */

function rateText(r) {
  const m = /^(\d+)\/(\d+ )?(second|minute|hour|day)s?$/.exec(r);
  if (!m) return r;
  return m[2] ? `${m[1]} per ${m[2].trim()} ${m[3]}s` : `${m[1]} per ${m[3]}`;
}

const AUTH_TEXT = {
  token: "API token required",
  optional: "Token optional",
  none: "No token needed",
  session: "Signed-in browser only",
};

function statusText(code) {
  return (
    {
      200: "OK",
      201: "Created",
      202: "Accepted",
      204: "No content",
      400: "Bad request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not found",
      409: "Conflict",
      410: "Gone",
      413: "Too large",
      422: "Validation error",
      429: "Too many requests",
      501: "Not implemented",
      507: "Over quota",
    }[code] || ""
  );
}

/**
 * Groups for a description with no overlay (auto mode): one per tag, in the description's `tags`
 * order and then as operations first use them (`x-displayName` titles a tag), plus "Endpoints" for
 * untagged operations. Ids are the tags slugified, made unique.
 */
function tagGroups(spec) {
  const defs = [];
  const ids = new Set();
  const add = (name, meta = {}) => {
    if (typeof name !== "string" || !name.trim() || defs.some((d) => d.tags[0] === name)) return;
    let id = slugify(name).slice(0, 60).replace(/-+$/, "") || "group";
    for (let n = 2; ids.has(id) || id === "endpoints"; n++) id = `${slugify(name).slice(0, 56) || "group"}-${n}`;
    ids.add(id);
    const title = typeof meta["x-displayName"] === "string" && meta["x-displayName"].trim() ? meta["x-displayName"].trim() : name.trim();
    defs.push({ id, title: title.slice(0, 80), ...(typeof meta.description === "string" && meta.description.trim() ? { description: meta.description.trim() } : {}), tags: [name] });
  };
  for (const t of Array.isArray(spec?.tags) ? spec.tags : []) add(t?.name, t || {});
  for (const item of Object.values(spec?.paths || {})) for (const m of METHODS) for (const t of item?.[m]?.tags || []) add(t);
  return defs;
}

/** Media type `example` / first `examples` value (auto mode). */
function mediaExample(media, resolve) {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  const first = media.examples && typeof media.examples === "object" ? Object.values(media.examples)[0] : undefined;
  if (first) {
    try {
      const ex = resolve(first).schema;
      if (ex?.value !== undefined) return ex.value;
    } catch {
      /* an example that doesn't resolve: none */
    }
  }
  try {
    const s = unwrapNull(resolve(media.schema || {}).schema).schema;
    if (s.example !== undefined && s.example !== null && typeof s.example === "object") return s.example;
  } catch {
    /* none */
  }
  return undefined;
}

/** The request body's media type (auto mode prefers JSON, then form data, then the first). */
function bodyType(content, auto) {
  const keys = Object.keys(content);
  if (!auto) return keys[0];
  return keys.find((k) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(k)) || keys.find((k) => k === "multipart/form-data") || keys[0];
}

/**
 * Build the reference.
 * @returns {{ groups: Array<{id:string,title:string,description?:string,ops:any[]}>, ops: any[], problems: string[], overview?: {title:string,description:string,markdown:string} }}
 */
export function buildApiReference(spec, overlay = {}, opts = {}) {
  const problems = [];
  const auto = !!opts.auto;
  const specServers = auto ? serversOf(spec?.servers) : [];
  const server = (opts.server || (auto ? specServers[0]?.url : spec?.servers?.[0]?.url) || "").replace(/\/+$/, "");
  const base = (opts.base || "/api").replace(/\/+$/, "");
  const resolve = makeResolver(spec || {});
  const extension = opts.extension || "x-docs";
  const ctx = {
    resolve,
    auto,
    notes: overlay.fields || {},
    examples: overlay.examples || {},
    auth: { tokenEnv: envName(opts.tokenEnv), tokenPrefix: opts.tokenPrefix || "", sessionHost: opts.sessionHost || "" },
  };
  const hideTags = new Set(overlay.hide?.tags || []);
  const hideOps = new Set(overlay.hide?.operations || []);
  const groupDefs = (overlay.groups?.length || !auto ? overlay.groups || [] : tagGroups(spec)).map((g) => ({ ...g, tags: g.tags || [] }));
  const groups = new Map(groupDefs.map((g) => [g.id, { id: g.id, title: g.title, description: g.description, ops: [] }]));
  const more = auto ? { id: "endpoints", title: "Endpoints", ops: [] } : { id: "more", title: "More", ops: [] };
  const seenKeys = new Set();
  const usedPaths = new Map();
  const schemes = spec?.components?.securitySchemes || {};
  const topSecurity = Array.isArray(spec?.security) ? spec.security : [];

  for (const [apiPath, item] of Object.entries(spec?.paths || {})) {
    for (const method of METHODS) {
      const raw = item?.[method];
      if (!raw) continue;
      const key = `${method.toUpperCase()} ${apiPath}`;
      seenKeys.add(key);
      const tags = Array.isArray(raw.tags) ? raw.tags : [];
      if (hideOps.has(key) || (tags.length && tags.every((t) => hideTags.has(t))) || (!tags.length && hideTags.has(""))) continue;
      try {
        const { op, group } = buildOperation({ apiPath, item, method, raw, key, tags });
        op.samples = samplesFor(op, ctx);
        op.markdown = operationMarkdown(op, ctx.auth);
        delete op.bodyExample;
        group.ops.push(op);
      } catch (e) {
        if (!auto) throw e;
        problems.push(`${key}: left out (${e.message})`);
      }
    }
  }

  function buildOperation({ apiPath, item, method, raw, key, tags }) {
    const ov = overlay.operations?.[key] || {};
    const groupId = ov.group || groupDefs.find((g) => tags.some((t) => g.tags.includes(t)))?.id;
    const group = (groupId && groups.get(groupId)) || more;
    if (groupId && !groups.has(groupId)) problems.push(`${key}: group "${groupId}" isn't in groups`);
    if (group === more && !auto) problems.push(`${key}: no group (tags ${tags.join(", ") || "none"}); add its tag to a group or set "group"`);
    if (!ov.title && !auto) problems.push(`${key}: no title in the overlay (using "${raw.summary}")`);

    const autoTitle = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : humanize(raw.operationId) || key;
    const title = ov.title || (auto ? autoTitle.slice(0, 120) : raw.summary || key);
    let slug = ov.slug || slugify(title);
    let path = `${base}/${group.id}/${slug}`;
    if (auto) {
      // Someone else's description: make the address fit and unique rather than complain.
      const stem = (slug || slugify(key) || "operation").slice(0, 72).replace(/-+$/, "");
      slug = stem;
      for (let n = 2; usedPaths.has(`${base}/${group.id}/${slug}`); n++) slug = `${stem}-${n}`;
      path = `${base}/${group.id}/${slug}`;
    }
    if (!NAME_RE.test(slug)) problems.push(`${key}: slug "${slug}" must be lowercase-with-dashes`);
    if (usedPaths.has(path)) problems.push(`${key}: page ${path} is also ${usedPaths.get(path)}; set a different "slug"`);
    usedPaths.set(path, key);

    const x = raw[extension] || {};
    const params = [];
    const pathItemParams = Array.isArray(item.parameters) ? item.parameters : [];
    const own = Array.isArray(raw.parameters) ? raw.parameters : [];
    for (const p0 of [...pathItemParams, ...own]) {
      const p = resolve(p0).schema;
      // An operation's own parameter replaces the path item's of the same name and place.
      if (auto && pathItemParams.includes(p0) && own.some((o) => { const r = resolve(o).schema; return r.name === p.name && r.in === p.in; })) continue;
      const { schema } = unwrapNull(resolve(p.schema || {}).schema);
      const name = p.name;
      const note = ov.paramNotes?.[name] ?? overlay.params?.[name];
      const ex = auto ? (p.example !== undefined ? p.example : schema.example !== undefined ? schema.example : undefined) : undefined;
      params.push({
        name,
        in: p.in,
        display: p.in === "header" ? headerName(name) : name,
        required: !!p.required,
        type: typeLabel(p.schema || {}, resolve),
        description: note ?? p.description ?? "",
        constraints: constraintText(schema),
        ...(Array.isArray(schema.enum) ? { enum: schema.enum } : patternEnum(schema) ? { enum: patternEnum(schema) } : {}),
        ...(schema.default !== undefined ? { default: schema.default } : {}),
        kind: schema.type === "integer" || schema.type === "number" ? "number" : schema.type === "boolean" ? "boolean" : "string",
        ...(ex !== undefined && (typeof ex !== "object" || ex === null) ? { example: ex } : {}),
      });
    }

    let body = null;
    let bodyExample;
    const rb = raw.requestBody ? resolve(raw.requestBody).schema : null;
    if (rb?.content && Object.keys(rb.content).length) {
      const ct = bodyType(rb.content, auto);
      const sch = rb.content[ct]?.schema || {};
      let fields = [];
      try {
        fields = fieldsOf(sch, ctx);
      } catch (e) {
        problems.push(`${key}: request body: ${e.message}`);
      }
      body = { contentType: ct, required: !!rb.required, schema: resolve(sch).name, fields };
      if (auto) bodyExample = mediaExample(rb.content[ct], resolve);
    }

    const responses = [];
    let okType;
    for (const [code, r0] of Object.entries(raw.responses || {})) {
      const r = resolve(r0).schema;
      const ct = r.content ? Object.keys(r.content)[0] : undefined;
      const sch = ct ? r.content[ct].schema : undefined;
      if (ct && code.startsWith("2") && okType === undefined) okType = ct;
      let fields = [];
      if (sch && code.startsWith("2")) {
        try {
          fields = fieldsOf(sch, ctx);
        } catch (e) {
          problems.push(`${key}: response ${code}: ${e.message}`);
        }
      }
      const generic = !r.description || r.description === "Successful Response" || r.description === "Validation Error";
      const desc =
        ov.responses?.[code] ??
        (code === "422" && (!auto || r.description === "Validation Error")
          ? "The request didn't validate. `detail` lists each problem, with where it is (`loc`) and why (`msg`)."
          : generic
            ? (statusText(code) || (code === "default" ? "Any other status" : `Status ${code}`)) + "."
            : r.description);
      responses.push({ status: code, description: desc, ...(fields.length ? { fields } : {}), ...(sch && resolve(sch).name && code.startsWith("2") ? { schema: resolve(sch).name } : {}) });
    }
    // What the code does that the schema doesn't say.
    const add = (code, text) => {
      if (!responses.some((r) => r.status === code)) responses.push({ status: code, description: text });
    };
    if (x.auth === "token") add("401", "No token, or the token is revoked or mistyped.");
    if (x.rateLimits?.length) add("429", "Too many requests from your IP address. Wait the seconds in `Retry-After`.");
    for (const [code, text] of Object.entries(ov.responses || {})) add(code, text);
    responses.sort((a, b) => a.status.localeCompare(b.status));

    const docstring = auto ? String(raw.description || "").trim() : tidyDocstring(raw.description || "");
    const description = ov.description ?? docstring;
    const autoSummary = auto && raw.summary && description ? firstSentence(description) : "";
    const summary = ov.summary || autoSummary || (description ? firstSentence(description) : `${method.toUpperCase()} ${apiPath}`);
    const hasEdit = !auto && params.some((p) => p.in === "header" && p.name.toLowerCase() === "x-edit-secret");
    const hasPassword = !auto && params.some((p) => p.in === "header" && p.name.toLowerCase() === "x-read-password");
    const okResp = responses.find((r) => r.status.startsWith("2"));
    const returns =
      ov.returns ||
      (okResp?.status === "204" ? "none" : auto && okType && !/json/i.test(okType) ? okType : "application/json");

    // Auth: the vendor extension's word, else (auto) the description's security requirements.
    let auth = x.auth || "none";
    let security;
    if (auto && !x.auth) {
      const reqs = (Array.isArray(raw.security) ? raw.security : topSecurity).filter((r) => r && typeof r === "object");
      const named = reqs.filter((r) => Object.keys(r).length);
      security = securityOf(named, schemes, ctx);
      auth = !named.length ? "none" : named.length < reqs.length ? "optional" : "token";
    }
    const opServers = auto ? serversOf(raw.servers?.length ? raw.servers : item.servers?.length ? item.servers : spec?.servers) : [];
    const opServer = auto && !opts.server ? (opServers[0]?.url ?? "") : server;

    const op = {
      key,
      operationId: raw.operationId,
      method: method.toUpperCase(),
      apiPath,
      server: opServer,
      url: opServer + apiPath,
      title,
      slug,
      path,
      group: { id: group.id, title: group.title },
      tags,
      summary: summary.length > 160 ? summary.slice(0, 157).replace(/\s+\S*$/, "") + "…" : summary,
      description,
      auth,
      authLabel: security ? authLabelOf(auth, security) : AUTH_TEXT[auth],
      editSecret: hasEdit,
      readPassword: hasPassword,
      rateLimits: (x.rateLimits || []).map(rateText),
      params,
      body,
      responses,
      returns,
      cli: ov.cli || null,
      mcp: ov.mcp || null,
      guide: ov.guide || null,
      deprecated: !!raw.deprecated,
      keywords: [method.toUpperCase(), apiPath, ...(ov.keywords || []), ...(ov.mcp ? [ov.mcp] : []), ...(auto && raw.operationId ? [String(raw.operationId)] : []), ...tags],
      overlay: ov,
    };
    if (security) op.security = security;
    if (auto) op.servers = opServers;
    if (bodyExample !== undefined) op.bodyExample = bodyExample;
    return { op, group };
  }

  for (const k of Object.keys(overlay.operations || {})) if (!seenKeys.has(k)) problems.push(`overlay operation "${k}" isn't in the OpenAPI description`);
  for (const k of hideOps) if (!seenKeys.has(k)) problems.push(`hide.operations "${k}" isn't in the OpenAPI description`);

  // Within a group: the overlay's order (it lists operations in reading order), then the rest
  // in the description's order.
  const order = new Map(Object.keys(overlay.operations || {}).map((k, i) => [k, i]));
  const rank = (op) => order.get(op.key) ?? Number.MAX_SAFE_INTEGER;
  for (const g of [...groups.values(), more]) g.ops = g.ops.map((op, i) => ({ op, i })).sort((a, b) => rank(a.op) - rank(b.op) || a.i - b.i).map((x) => x.op);
  const out = [...groups.values(), more].filter((g) => g.ops.length);
  // `overlay` and the resolver context stay out of what pages receive.
  const ops = out.flatMap((g) => g.ops);
  for (const op of ops) delete op.overlay;
  const ref = { groups: out, ops, problems };
  if (auto) ref.overview = overviewOf(spec, out, { servers: specServers, schemes, topSecurity, ctx, title: opts.title, server });
  return ref;
}

/** "Bearer token", "API key or Bearer token", "Auth optional", "No auth" (auto mode's badge). */
function authLabelOf(auth, security) {
  if (auth === "none") return "No auth";
  if (auth === "optional") return "Auth optional";
  const labels = [...new Set(security.filter((s) => s.primary).map((s) => s.label))];
  return labels.length ? labels.join(" + ") : "Auth required";
}

/** One sentence per scheme, for the overview and the operation's Authentication line. */
function schemeSentence(s) {
  const fmt = s.format ? ` (${s.format})` : "";
  switch (s.kind) {
    case "bearer":
      return `${s.label}${fmt} in \`Authorization: Bearer <token>\``;
    case "basic":
      return "HTTP basic auth: a username and password in `Authorization: Basic …`";
    case "apiKey":
      return s.in === "header" ? `An API key in the \`${s.name}\` header` : s.in === "query" ? `An API key in the \`${s.name}\` query parameter` : `An API key in the \`${s.name}\` cookie`;
    default:
      return `${s.label} (not covered by this reference's samples)`;
  }
}

/** The reference's front page (auto mode): what the API is, where it lives, how to authenticate, every endpoint. */
function overviewOf(spec, groups, { servers, schemes, topSecurity, ctx, title, server }) {
  const info = spec?.info || {};
  const name = (typeof info.title === "string" && info.title.trim()) || title || "API reference";
  const intro = typeof info.description === "string" ? info.description.trim() : "";
  const L = [];
  if (intro) L.push(intro, "");
  const facts = [];
  if (typeof info.version === "string" || typeof info.version === "number") facts.push(`- **Version:** \`${info.version}\``);
  if (spec?.openapi) facts.push(`- **OpenAPI:** ${spec.openapi}`);
  if (facts.length) L.push(...facts, "");
  L.push("## Base URL", "");
  const list = servers.length ? servers : server ? [{ url: server }] : [];
  if (list.length) for (const s of list) L.push(`- \`${s.url}\`${s.description ? `: ${s.description}` : ""}`);
  else L.push("The description lists no server. Paths below are relative to the API's own address.");
  L.push("");
  const all = securityOf(Object.keys(schemes).map((id) => ({ [id]: [] })), schemes, ctx);
  if (all.length) {
    L.push("## Authentication", "");
    const required = topSecurity.filter((r) => r && Object.keys(r).length);
    L.push(required.length ? (required.length < topSecurity.length ? "Most endpoints work without credentials, and take these when sent:" : "Endpoints take one of these, unless a page says otherwise:") : "Some endpoints take one of these; each page says which:", "");
    for (const s of all) L.push(`- **${s.id}:** ${schemeSentence(s)}.${s.description ? ` ${s.description.replace(/\s+/g, " ")}` : ""}`);
    L.push("");
  }
  L.push("## Endpoints", "");
  for (const g of groups) {
    L.push(`### ${g.title}`, "");
    if (g.description) L.push(g.description, "");
    for (const op of g.ops) L.push(`- [${op.title.replace(/[[\]]/g, "")}](${op.path}): \`${op.method} ${op.apiPath}\``);
    L.push("");
  }
  const count = groups.reduce((n, g) => n + g.ops.length, 0);
  const description = intro ? firstSentence(intro) : `Every endpoint of ${name}: ${count} ${count === 1 ? "operation" : "operations"}, with parameters, responses and code samples.`;
  return { title: name.slice(0, 120), description, markdown: L.join("\n") };
}

function samplesFor(op, ctx) {
  const v = sampleValues(op, ctx);
  op.example = v;
  const samples = [
    { label: "curl", lang: "bash", code: curlCommand(op, v, { tokenEnv: ctx.auth.tokenEnv }) },
    { label: "JavaScript", lang: "javascript", code: jsSample(op, v, ctx.auth.tokenEnv) },
    { label: "Python", lang: "python", code: pySample(op, v, ctx.auth.tokenEnv) },
  ];
  if (op.cli) samples.push({ label: "CLI", lang: "bash", code: op.cli });
  return samples;
}

/* ── Markdown (agents, llms-full.txt, search) ───────────────────────────── */

function fieldLines(fields, indent = "", response = false) {
  const out = [];
  for (const f of fields) {
    const bits = [f.type + (response && f.nullable ? " | null" : ""), f.required && !response ? "required" : ""].filter(Boolean).join(", ");
    const extra = [
      f.description,
      f.constraints,
      f.enum && !f.type.includes('"') ? `One of ${f.enum.map((e) => `\`${e}\``).join(", ")}.` : "",
      f.default !== undefined && f.default !== null && !(Array.isArray(f.default) && !f.default.length) ? `Default \`${JSON.stringify(f.default)}\`.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    out.push(`${indent}- \`${f.name}\` (${bits})${extra ? `: ${extra}` : ""}`);
    if (f.children) out.push(...fieldLines(f.children, indent + "  ", response));
  }
  return out;
}

const PARAM_SECTIONS = [
  ["path", "Path parameters"],
  ["query", "Query parameters"],
  ["header", "Headers"],
];

export function authSentence(op, { tokenPrefix = "", sessionHost = "" } = {}) {
  if (op.security) {
    const schemes = op.security;
    if (op.auth === "none" || !schemes.length) return "None.";
    const primary = schemes.filter((s) => s.primary);
    const others = schemes.filter((s) => !s.primary);
    const all = primary.map(schemeSentence).join(", and ");
    const alt = others.length ? ` Or: ${others.map(schemeSentence).join("; ")}.` : "";
    return op.auth === "optional" ? `Optional. ${all}.${alt}` : `${all}.${alt}`;
  }
  const extra = [op.editSecret ? "or the document's edit secret in `X-Edit-Secret`" : "", op.readPassword ? "`X-Read-Password` for a password-protected document" : ""].filter(Boolean);
  const bearer = `\`Authorization: Bearer ${tokenPrefix ? `${tokenPrefix}…` : "<token>"}\``;
  switch (op.auth) {
    case "token":
      return `API token required: ${bearer}.`;
    case "optional":
      return `Token optional: send ${bearer} to act as your account${extra.length ? `, ${extra.join("; ")}` : ""}.`;
    case "session":
      return sessionHost ? `Only ${sessionHost}'s own sign-in works here, not an API token.` : "Only a signed-in browser session works here, not an API token.";
    default:
      return extra.length ? `No token needed. ${extra.map((e) => e[0].toUpperCase() + e.slice(1)).join("; ")}.` : "No token needed.";
  }
}

export function operationMarkdown(op, auth = {}) {
  const L = [];
  L.push(`\`${op.method} ${op.url}\``, "");
  if (op.description) L.push(op.description, "");
  const facts = [`- **Authentication:** ${authSentence(op, auth)}`];
  if (op.rateLimits.length) facts.push(`- **Rate limit:** ${op.rateLimits.join(", ")} per IP address.`);
  if (op.cli) facts.push(`- **CLI:** \`${op.cli.split("\n")[0]}\``);
  if (op.mcp) facts.push(`- **MCP tool:** \`${op.mcp}\` ([tools](/ai/tools))`);
  if (op.guide) facts.push(`- **Guide:** [${op.guide.label}](${op.guide.href})`);
  L.push(...facts, "");
  for (const [where, heading] of PARAM_SECTIONS) {
    const ps = op.params.filter((p) => p.in === where);
    if (!ps.length) continue;
    L.push(`## ${heading}`, "");
    L.push(...fieldLines(ps.map((p) => ({ ...p, name: p.display }))), "");
  }
  if (op.body) {
    L.push("## Request body", "");
    L.push(`\`${op.body.contentType}\`${op.body.required ? ", required" : ""}.`, "");
    if (op.body.fields.length) L.push(...fieldLines(op.body.fields), "");
  }
  L.push("## Responses", "");
  for (const r of op.responses) {
    L.push(`- \`${r.status}\`: ${r.description}`);
    if (r.fields?.length) L.push(...fieldLines(r.fields, "  ", true));
  }
  L.push("", "## Examples", "", samplesMarkdown(op), "");
  return L.join("\n");
}

/** The code samples as one synced tab group (`lang`: curl / JavaScript / Python / CLI). */
export function samplesMarkdown(op) {
  const L = ['::::tabs{sync="lang"}'];
  for (const s of op.samples) {
    const fence = s.code.includes("```") ? "~~~~" : "```";
    L.push(`:::tab[${s.label}]`, fence + s.lang, s.code, fence, ":::");
  }
  L.push("::::");
  return L.join("\n");
}
