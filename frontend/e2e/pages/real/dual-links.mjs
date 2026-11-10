/**
 * feat/dual-links (owner, 2026-11-10): in a workspace with a live custom domain, items open on
 * markdrop.in inside the app; "Open on <domain>" (item ⋯ menu, the viewer's top bar) opens the
 * domain in a new tab, where the reader is signed in by the tenant handoff; Share offers both links
 * (the domain's is the default); the API names markdrop_url and domain_url. Nothing redirects a
 * signed-in reader from markdrop.in to the domain.
 *
 *   PB_STACK_ID=41 PB_WORK=… [BROWSER=chromium] [ONLY=api,listing,menu,viewer,share,home] node dual-links.mjs
 */
import { APP, TENANT, BROWSER, log, fail, reseed, api, launch, ctx, shot, stepper } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const SLUG = "launch-plan";
const BODY = "We ship the page builder";

// The seed's live domains: docs.acme.com (primary) and acme.localhost. Make acme.localhost the
// default, so the domain address is one this browser can open (lib.mjs routes it to TENANT).
const doms = await api("GET", `/api/v1/workspaces/${WS}/domains`, T.owner);
const local = (doms.body.domains ?? []).find((d) => d.host === "acme.localhost");
if (!local) fail(`no acme.localhost domain: ${JSON.stringify(doms.body).slice(0, 300)}`);
const prim = await api("PUT", `/api/v1/workspaces/${WS}/domains/${local.id}/primary`, T.owner);
if (prim.status >= 300) fail(`make acme.localhost primary → ${prim.status} ${JSON.stringify(prim.body)}`);
await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: `doc:${SLUG}` }) });

const doc = (await api("GET", `/api/v1/documents/${SLUG}`, T.owner)).body;
const DOMAIN = doc.workspace_url;
log("domain address", DOMAIN, "markdrop", doc.markdrop_url);

const browser = await launch();
const { step, results } = stepper(browser);

await step("api", async () => {
  if (DOMAIN !== `https://acme.localhost/${[...(doc.folder_path || []), SLUG].join("/")}`) fail(`workspace_url ${DOMAIN}`);
  if (doc.domain_url !== DOMAIN) fail(`domain_url ${doc.domain_url} ≠ workspace_url`);
  if (!doc.markdrop_url || !doc.markdrop_url.endsWith(`/${SLUG}`) || doc.markdrop_url.includes("acme")) fail(`markdrop_url ${doc.markdrop_url}`);
  const items = await api("GET", `/api/v1/workspaces/${WS}/items?folder=all`, T.member);
  const row = items.body.items.find((i) => i.slug === SLUG);
  if (!row || row.url !== DOMAIN || row.domain_url !== DOMAIN || row.markdrop_url !== doc.markdrop_url) fail(`items row ${JSON.stringify(row)}`);
});

await step("listing", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${WS}`, { waitUntil: "load" });
  const link = p.locator("#main a.wl-name").filter({ hasText: "Launch plan" }).first();
  await link.waitFor({ timeout: 30000 });
  const hrefs = await p.locator("#main a.wl-name").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  log("listing hrefs", hrefs.join(" "));
  if ((await link.getAttribute("href")) !== `/${SLUG}`) fail(`Launch plan links to ${await link.getAttribute("href")}`);
  const off = hrefs.filter((h) => !h || !h.startsWith("/") || h.includes("acme"));
  if (off.length) fail(`listing links off markdrop.in: ${off.join(", ")}`);
});

await step("menu", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${WS}`, { waitUntil: "load" });
  await p.getByRole("button", { name: /^Actions for Launch plan$/ }).first().click({ timeout: 30000 });
  const open = p.getByRole("menuitem", { name: /^Open$/ }).first();
  if ((await open.getAttribute("href")) !== `/${SLUG}`) fail(`⋯ Open → ${await open.getAttribute("href")}`);
  const onDomain = p.getByRole("menuitem", { name: /Open on acme\.localhost/ }).first();
  await onDomain.waitFor({ timeout: 5000 });
  if ((await onDomain.getAttribute("href")) !== DOMAIN) fail(`Open on → ${await onDomain.getAttribute("href")}`);
  if ((await onDomain.getAttribute("target")) !== "_blank") fail("Open on <domain> isn't a new tab");
  await shot(p, "dual-01-item-menu");
});

await step("viewer", async () => {
  const { c, p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/${SLUG}`, { waitUntil: "networkidle" });
  await p.getByText(BODY).first().waitFor({ timeout: 30000 });
  // Signed in on markdrop.in: it stays here (no jump to the workspace's domain).
  await p.waitForTimeout(2500);
  if (new URL(p.url()).host !== new URL(APP).host) fail(`markdrop.in sent the reader to ${p.url()}`);
  const btn = p.getByTestId("open-on-domain");
  await btn.waitFor({ timeout: 15000 });
  if ((await btn.getAttribute("href")) !== DOMAIN) fail(`top bar Open on → ${await btn.getAttribute("href")}`);
  await shot(p, "dual-02-viewer-bar");
  // ⋯ has it too (and on phones it's only there).
  await p.getByRole("button", { name: "More actions" }).first().click();
  await p.getByRole("menuitem", { name: /Open on acme\.localhost/ }).first().waitFor({ timeout: 5000 });
  await p.keyboard.press("Escape");
  // The new tab lands on the domain and signs the member in there by itself (tenant handoff).
  const [tab] = await Promise.all([c.waitForEvent("page"), btn.click()]);
  await tab.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 45000 });
  await tab.getByText(BODY).first().waitFor({ timeout: 45000 });
  const tok = await tab.evaluate(() => localStorage.getItem("markdrop_token"));
  if (!tok) fail("no tenant session on the domain after the handoff");
  if (await tab.getByTestId("open-on-domain").count()) fail("the domain's own bar offers Open on <domain>");
  await shot(tab, "dual-03-domain-tab");
});

await step("share", async () => {
  const { c, p } = await ctx(browser, { token: T.owner });
  if (BROWSER === "chromium") await c.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  await p.goto(`${APP}/${SLUG}`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Share", exact: true }).first().click({ timeout: 30000 });
  const links = p.getByTestId("share-links");
  await links.waitFor({ timeout: 15000 });
  const domainRow = p.getByTestId("share-link-domain");
  const mdRow = p.getByTestId("share-link-markdrop");
  if ((await domainRow.getAttribute("data-url")) !== DOMAIN) fail(`domain row ${await domainRow.getAttribute("data-url")}`);
  if ((await mdRow.getAttribute("data-url")) !== doc.markdrop_url) fail(`markdrop row ${await mdRow.getAttribute("data-url")}`);
  if (!(await domainRow.innerText()).includes("Default")) fail("the domain row isn't marked Default");
  await shot(p, "dual-04-share-links");
  if (BROWSER === "chromium") {
    const clip = () => p.evaluate(() => navigator.clipboard.readText());
    await mdRow.getByRole("button", { name: /Copy/ }).click();
    await p.waitForTimeout(300);
    if ((await clip()) !== doc.markdrop_url) fail(`markdrop Copy → ${await clip()}`);
    await domainRow.getByRole("button", { name: /Copy/ }).click();
    await p.waitForTimeout(300);
    if ((await clip()) !== DOMAIN) fail(`domain Copy → ${await clip()}`);
    await mdRow.getByRole("button", { name: /Copy/ }).click();
    await p.getByRole("dialog").getByRole("button", { name: /^Copy link$/ }).click();
    await p.waitForTimeout(300);
    if ((await clip()) !== DOMAIN) fail(`footer Copy link → ${await clip()} (want the domain's)`);
  }
});

await step("home", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/dashboard`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);
  const hrefs = await p.locator('[data-testid="home-continue-card"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  log("home continue", hrefs.join(" ") || "(none)");
  const off = hrefs.filter((h) => !h || !h.startsWith("/"));
  if (off.length) fail(`Home links off markdrop.in: ${off.join(", ")}`);
  // ⌘K: an item result opens here too.
  await p.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await p.keyboard.type("Launch plan");
  await p.waitForTimeout(1500);
  const opts = await p.locator('[role="option"] a[href], a[role="option"][href]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  log("palette hrefs", opts.join(" ") || "(none: rows open by click)");
  if (opts.some((h) => h && h.includes("acme"))) fail(`⌘K links to the domain: ${opts.join(", ")}`);
});

await browser.close();
const bad = results.filter((r) => r[1] !== "ok");
console.log(JSON.stringify(results));
if (bad.length) {
  console.error(`${bad.length} step(s) failed`);
  process.exit(1);
}
log("all dual-links steps passed");
void TENANT;
