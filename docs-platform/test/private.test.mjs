/**
 * Private pages in a build (builder/access.mjs): what gets protected, the public MCP snapshot, and
 * the leak check that fails a build when protected text reaches anything a signed-out reader can
 * fetch. Plus the runner's policy write carrying the readers part (builder/store.mjs writeAccess).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accessPlan, annotate, canariesOf, leakCheck, loadAccessTools, readPage } from "../builder/access.mjs";
import { FsStore, writeAccess } from "../builder/store.mjs";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend");
const tools = await loadAccessTools(ENGINE);

const fm = (title, extra = "") => `---\ntitle: "${title}"\ndescription: "x"\nupdated: 2026-11-02\n${extra}---\n\n`;
const SNAP = {
  "/site/site.json": JSON.stringify({
    name: "Acme", url: "https://docs.acme.test",
    nav: [{ group: "Start", pages: ["/guides/sso"] }, { group: "Enterprise", access: "northwind", pages: ["/enterprise/setup"] }],
    access: { rules: { northwind: { kind: "people", name: "Northwind" } } },
  }),
  "/site/guides/sso.md": fm("SSO") + "Public intro about single sign-on for every reader.\n\n:::private{access=\"northwind\"}\nThe northwind entity id is urn acme northwind prod 4471 today.\n\n![diagram](/docs-assets/nw-diagram.png)\n:::\n",
  "/site/enterprise/setup.md": fm("Northwind setup") + "Configure the okta tenant with the northwind metadata file first.\n\n![okta](/docs-assets/okta.png)\n",
  "/site/team/runbook.md": fm("Runbook", "access: members\n") + "Page the on call engineer through the zebra incident channel.\n",
  "/site/guides/public.md": fm("Public") + "Shared screenshot ![x](/docs-assets/shared.png) for everyone to see.\n",
  "/site/index.md": fm("Home") + "Welcome home.\n",
};

const objects = new Map();
const put = (text) => {
  const b = Buffer.from(text);
  const o = crypto.createHash("sha256").update(b).digest("hex");
  objects.set(o, b);
  return { o, s: b.length };
};
const HTML = "text/html; charset=utf-8";
function manifest(over = {}) {
  return {
    site: { url: "https://docs.acme.test" },
    routes: {
      "/docs-site/guides/sso": { ...put("<p>Public intro</p><div class=dx-locked>Private section</div>"), t: HTML, rsc: put("0:public") },
      "/docs-site/x-access/northwind/guides/sso": { ...put("The northwind entity id is urn acme northwind prod 4471 today."), t: HTML, rsc: put("0:x") },
      "/docs-site/enterprise/setup": { ...put("Configure the okta tenant with the northwind metadata file first."), t: HTML, rsc: put("0:y") },
      "/docs-site/md/enterprise/setup": { ...put("# Northwind setup"), t: "text/markdown" },
      "/docs-site/og/enterprise/setup": { ...put("PNG"), t: "image/png" },
      "/docs-site/team/runbook": { ...put("zebra"), t: HTML, rsc: put("0:z") },
      "/docs-site/guides/public": { ...put("public"), t: HTML, rsc: put("0:p") },
      "/docs-site/llms.txt": { ...put("- [SSO](https://docs.acme.test/guides/sso.md)"), t: "text/plain" },
      "/docs-site/sitemap.xml": { ...put("<loc>https://docs.acme.test/guides/sso</loc>"), t: "application/xml" },
      "/docs-site/search-index.json": { ...put('[{"href":"/guides/sso"}]'), t: "application/json" },
      ...over,
    },
    files: {
      "/docs-assets/nw-diagram.png": { ...put("png1"), t: "image/png" },
      "/docs-assets/okta.png": { ...put("png2"), t: "image/png" },
      "/docs-assets/shared.png": { ...put("png3"), t: "image/png" },
    },
    notFound: { ...put("404"), t: HTML },
  };
}
const read = (h) => objects.get(h);

test("the plan: protected pages (own and group), sections, the public snapshot", () => {
  const plan = accessPlan(SNAP, tools);
  assert.deepEqual([...plan.pages], [["/enterprise/setup", "northwind"], ["/team/runbook", "members"]]);
  assert.deepEqual([...plan.sections], [["/guides/sso", ["northwind"]]]);
  assert.deepEqual([...plan.rules].sort(), ["members", "northwind"]);
  // The MCP server's snapshot: no protected page, no private section.
  const snap = JSON.stringify(plan.publicSnapshot);
  for (const s of ["okta tenant", "zebra", "prod 4471"]) assert.ok(!snap.includes(s), s);
  assert.ok(snap.includes("Public intro about single sign-on"));
  assert.ok(snap.includes("::private-locked"));
  assert.ok(plan.canaries.some((c) => c.text.includes("northwind entity id")));
});

test("annotate marks routes, variants and files only protected content uses", () => {
  const plan = accessPlan(SNAP, tools);
  const m = manifest();
  const stats = annotate(m, plan, tools);
  assert.equal(m.routes["/docs-site/enterprise/setup"].a, "northwind");
  assert.equal(m.routes["/docs-site/md/enterprise/setup"].a, "northwind");
  assert.equal(m.routes["/docs-site/og/enterprise/setup"].a, "northwind");
  assert.equal(m.routes["/docs-site/team/runbook"].a, "members");
  assert.deepEqual(m.routes["/docs-site/guides/sso"].sec, ["northwind"]);
  assert.equal(m.routes["/docs-site/x-access/northwind/guides/sso"].variant, true);
  assert.equal(m.routes["/docs-site/guides/public"].a, undefined);
  assert.deepEqual(m.files["/docs-assets/nw-diagram.png"].a, ["northwind"]);
  assert.deepEqual(m.files["/docs-assets/okta.png"].a, ["northwind"]);
  assert.equal(m.files["/docs-assets/shared.png"].a, undefined);
  assert.deepEqual(m.access, { rules: ["members", "northwind"] });
  assert.deepEqual(stats, { protectedRoutes: 4, variants: 1, protectedFiles: 2 });
  assert.deepEqual(leakCheck(m, plan, read), []);
  // A protected page missing from the build fails it.
  const broken = manifest();
  delete broken.routes["/docs-site/team/runbook"];
  assert.throws(() => annotate(broken, plan, tools), /protected page \/team\/runbook isn't in the build/);
  const noVariant = manifest();
  delete noVariant.routes["/docs-site/x-access/northwind/guides/sso"];
  assert.throws(() => annotate(noVariant, plan, tools), /variant/);
});

test("the leak check catches protected text and protected addresses in public outputs", () => {
  const plan = accessPlan(SNAP, tools);
  const leaky = manifest({
    "/docs-site/llms-full.txt": { ...put("... The northwind entity id is urn acme northwind prod 4471 today ..."), t: "text/plain" },
    "/docs-site/guides/public": { ...put("ok"), t: HTML, rsc: put('0:["Page the on call engineer through the zebra incident channel."]') },
    "/docs-site/sitemap.xml": { ...put("<loc>https://docs.acme.test/enterprise/setup</loc>"), t: "application/xml" },
    "/docs-site/search-index.json": { ...put('[{"href": "/team/runbook"}]'), t: "application/json" },
  });
  annotate(leaky, plan, tools);
  const leaks = leakCheck(leaky, plan, read).map((l) => `${l.where}: ${l.what.slice(0, 60)}`);
  assert.ok(leaks.some((l) => l.startsWith("/docs-site/llms-full.txt: text of the section (northwind)")), leaks.join("\n"));
  assert.ok(leaks.some((l) => l.startsWith("/docs-site/guides/public (RSC): text of the page /team/runbook")), leaks.join("\n"));
  assert.ok(leaks.some((l) => l.startsWith("/docs-site/sitemap.xml: lists the protected page /enterprise/setup")));
  assert.ok(leaks.some((l) => l.startsWith("/docs-site/search-index.json: lists the protected page /team/runbook")));
  // The MCP snapshot is checked too.
  const m2 = manifest();
  m2.mcp = put(JSON.stringify({ files: { "/site/x.md": "Configure the okta tenant with the northwind metadata file first." } }));
  annotate(m2, plan, tools);
  assert.ok(leakCheck(m2, plan, read).some((l) => l.where === "MCP snapshot"));
});

test("a site with no private content is untouched", () => {
  const snap = { "/site/site.json": "{}", "/site/a.md": fm("A") + "Hello there everyone, this is public." };
  const plan = accessPlan(snap, tools);
  assert.equal(plan.rules.size, 0);
  const m = manifest();
  assert.deepEqual(annotate(m, plan, tools), { protectedRoutes: 0, variants: 0, protectedFiles: 0 });
  assert.equal(m.access, undefined);
  assert.deepEqual(leakCheck(m, plan, read), []);
});

test("frontmatter and canaries", () => {
  assert.equal(readPage(fm("X", 'access: "northwind"\n') + "b", tools.parseYaml).access, "northwind");
  assert.equal(readPage(fm("X", "access: partners\n") + "b", null).access, "partners");
  assert.deepEqual(canariesOf("short\n```\ncode line that is long enough to count here\n```\n:::private\nA long enough sentence with several words in it."), ["code line that is long enough to count here", "A long enough sentence with several words in it"]);
});

test("the runner's policy write keeps the newer readers policy and the newer site policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "access-"));
  const store = new FsStore(root);
  const readers = (version, rules = {}) => ({ version, rv: 0, rules });
  let r = await writeAccess(store, "s1", { level: "public", policy_version: 0, readers: readers(2, { northwind: { kind: "people", emails: ["a@b.co"] } }) });
  assert.equal(r.written, true);
  assert.deepEqual(r.readers, { version: 2 });
  const cur = () => JSON.parse(fs.readFileSync(path.join(root, "sites/s1/access.json"), "utf8"));
  assert.equal(cur().readers.rules.northwind.emails[0], "a@b.co");
  // An older readers policy (a slow build) doesn't win; a newer site level still lands.
  r = await writeAccess(store, "s1", { level: "members", policy_version: 3, readers: readers(1) });
  assert.equal(r.written, true);
  assert.equal(cur().level, "members");
  assert.equal(cur().readers.version, 2);
  r = await writeAccess(store, "s1", { level: "members", policy_version: 3, readers: readers(2, { northwind: { kind: "people", emails: ["a@b.co"] } }) });
  assert.equal(r.written, false);
  // A public site with no readers still needs no object.
  assert.equal((await writeAccess(store, "s2", { level: "public", policy_version: 0 })).written, false);
  fs.rmSync(root, { recursive: true, force: true });
});
