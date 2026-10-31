/**
 * The API reference generator's auto mode (a guide's reference from someone else's OpenAPI file).
 *
 *   node --test src/docs/openapi.test.mjs              (part of npm run docs:test)
 *   UPDATE_GOLDEN=1 node --test src/docs/openapi.test.mjs   (rewrite the golden file on purpose)
 *
 * The golden file is the whole reference built from the sample spec the "API reference" template
 * starts with (backend/app/assets/northwind-openapi.json): groups, addresses, auth, every page's
 * Markdown (what agents, search and llms-full.txt read) and the overview. The backend's sidebar
 * preview is checked against the same file (backend/tests/test_docs_api_spec.py).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApiReference, curlCommand, humanize, serversOf } from "./openapi.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, "../../../backend/app/assets/northwind-openapi.json");
const GOLDEN = path.join(HERE, "testdata", "northwind.golden.json");

const build = (spec, opts = {}) => buildApiReference(spec, {}, { auto: true, base: "/api-reference", ...opts });

function golden(ref) {
  return {
    problems: ref.problems,
    groups: ref.groups.map((g) => ({ id: g.id, title: g.title, ops: g.ops.map((o) => ({ key: o.key, title: o.title, path: o.path, auth: o.auth, authLabel: o.authLabel, server: o.server })) })),
    overview: ref.overview,
    pages: Object.fromEntries(ref.ops.map((o) => [o.path, o.markdown])),
  };
}

test("auto mode: the sample spec builds the golden reference", () => {
  const ref = build(JSON.parse(fs.readFileSync(SAMPLE, "utf8")));
  const got = golden(ref);
  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n");
  }
  assert.deepEqual(got, JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
  assert.deepEqual(ref.problems, []);
  // Try it reads these off the operation.
  const create = ref.ops.find((o) => o.key === "POST /orders");
  assert.deepEqual(create.servers.map((s) => s.url), ["https://api.northwind.example/v1", "https://sandbox.northwind.example/v1"]);
  assert.deepEqual(create.security.map((s) => [s.id, s.kind, s.primary]), [["bearerAuth", "bearer", true], ["apiKey", "apiKey", false]]);
  assert.deepEqual(create.example.body, { customer_id: "cus_ALFKI", lines: [{ product_id: "prd_chai", quantity: 12 }] });
  assert.equal(ref.ops.find((o) => o.key === "GET /products").auth, "none");
});

const spec = (paths, extra = {}) => ({ openapi: "3.1.0", info: { title: "T", version: "1" }, servers: [{ url: "https://api.example.com" }], paths, ...extra });
const op = (o = {}) => ({ responses: { 200: { description: "OK" } }, ...o });

test("auto mode: groups follow tags (spec order, then first use); untagged go under Endpoints", () => {
  const ref = build(spec({ "/a": { get: op({ tags: ["Zeta"], summary: "A" }) }, "/b": { get: op({ summary: "B" }) }, "/c": { get: op({ tags: ["Alpha"], summary: "C" }) } }, { tags: [{ name: "Alpha", "x-displayName": "The Alphas" }] }));
  assert.deepEqual(ref.groups.map((g) => [g.id, g.title, g.ops.map((o) => o.key)]), [
    ["alpha", "The Alphas", ["GET /c"]],
    ["zeta", "Zeta", ["GET /a"]],
    ["endpoints", "Endpoints", ["GET /b"]],
  ]);
  assert.deepEqual(ref.problems, []);
});

test("auto mode: titles from summary, else operationId, else METHOD /path; addresses made unique", () => {
  const ref = build(spec({ "/x": { get: op({ operationId: "listThings" }), post: op({}) }, "/y": { get: op({ summary: "List things" }) } }));
  assert.deepEqual(ref.ops.map((o) => [o.title, o.path]), [
    ["List things", "/api-reference/endpoints/list-things"],
    ["POST /x", "/api-reference/endpoints/post-x"],
    ["List things", "/api-reference/endpoints/list-things-2"],
  ]);
  assert.equal(humanize("get_user-byID"), "Get user by id");
});

test("auto mode: servers resolve their variables; relative ones aren't offered", () => {
  assert.deepEqual(serversOf([{ url: "https://{region}.example.com/v{v}/", variables: { region: { default: "eu" }, v: { default: "2" } } }, { url: "/relative" }, { url: "https://a.example.com", description: "Prod" }]), [
    { url: "https://eu.example.com/v2" },
    { url: "https://a.example.com", description: "Prod" },
  ]);
  const ref = build(spec({ "/a": { get: op() } }, { servers: [{ url: "/v1" }] }));
  assert.equal(ref.ops[0].server, "");
  assert.match(ref.overview.markdown, /lists no server/);
});

test("auto mode: every kind of credential in the samples, and literal ones from Try it", () => {
  const schemes = {
    bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    basic: { type: "http", scheme: "basic" },
    key: { type: "apiKey", in: "query", name: "api_key" },
    cookie: { type: "apiKey", in: "cookie", name: "sid" },
    oauth: { type: "oauth2", flows: {} },
  };
  const ref = build(
    spec({
      "/q": { get: op({ security: [{ key: [] }] }) },
      "/b": { get: op({ security: [{ basic: [] }] }) },
      "/c": { get: op({ security: [{ cookie: [] }] }) },
      "/o": { get: op({ security: [{}, { oauth: [] }] }) },
      "/n": { get: op({ security: [] }) },
      "/t": { get: op() },
    }, { components: { securitySchemes: schemes }, security: [{ bearer: [] }] }),
  );
  const byKey = Object.fromEntries(ref.ops.map((o) => [o.key, o]));
  const curl = (k) => byKey[k].samples[0].code;
  const js = (k) => byKey[k].samples[1].code;
  const py = (k) => byKey[k].samples[2].code;
  assert.match(curl("GET /q"), /^curl "https:\/\/api\.example\.com\/q\?api_key=\$API_KEY"$/);
  assert.match(js("GET /q"), /fetch\(`https:\/\/api\.example\.com\/q\?api_key=\$\{process\.env\.API_KEY\}`\)/);
  assert.match(py("GET /q"), /params=\{"api_key": os\.environ\["API_KEY"\]\}/);
  assert.match(curl("GET /b"), /-u "\$API_USER:\$API_PASSWORD"/);
  assert.match(py("GET /b"), /auth=\(os\.environ\["API_USER"\], os\.environ\["API_PASSWORD"\]\)/);
  assert.match(curl("GET /c"), /-b "sid=\$SID"/);
  assert.equal(byKey["GET /o"].auth, "optional");
  assert.equal(byKey["GET /o"].authLabel, "Auth optional");
  assert.equal(byKey["GET /n"].auth, "none");
  assert.match(byKey["GET /n"].markdown, /\*\*Authentication:\*\* None\./);
  assert.equal(byKey["GET /t"].auth, "token");
  assert.match(curl("GET /t"), /-H "Authorization: Bearer \$API_TOKEN"/);
  assert.match(byKey["GET /t"].markdown, /Bearer token \(JWT\) in `Authorization: Bearer <token>`/);
  // Try it: what the reader typed, as literals, quoted for the shell.
  const t = byKey["GET /q"];
  assert.equal(curlCommand(t, t.example, { credentials: { key: "a b'c" } }), "curl 'https://api.example.com/q?api_key=a%20b'\\''c'");
  const b = byKey["GET /b"];
  assert.equal(curlCommand(b, b.example, { credentials: { basic: "me:pw" } }), "curl https://api.example.com/b \\\n  -u 'me:pw'");
  assert.equal(curlCommand(b, b.example, { credentials: {} }), "curl https://api.example.com/b");
});

test("auto mode: an operation that doesn't build is left out with a problem, not the whole reference", () => {
  const ref = build(spec({ "/ok": { get: op({ summary: "Fine" }) }, "/bad": { get: op({ parameters: [{ $ref: "#/components/parameters/Missing" }] }) } }));
  assert.deepEqual(ref.ops.map((o) => o.key), ["GET /ok"]);
  assert.equal(ref.problems.length, 1);
  assert.match(ref.problems[0], /^GET \/bad: left out \(unresolved \$ref/);
});

test("auto mode: examples come from the description; an operation's parameter overrides the path item's", () => {
  const ref = build(
    spec({
      "/items/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: op({ parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", example: "itm_1" } }] }),
        post: op({ requestBody: { content: { "text/plain": { schema: { type: "string" } }, "application/json": { schema: { type: "object", required: ["n"], properties: { n: { type: "integer", example: 7 } } } } } } }),
      },
    }),
  );
  const [get, post] = ref.ops;
  assert.equal(get.params.length, 1);
  assert.equal(get.example.path.id, "itm_1");
  assert.equal(post.body.contentType, "application/json");
  assert.deepEqual(post.example.body, { n: 7 });
});
