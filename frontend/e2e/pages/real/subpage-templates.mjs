/**
 * Add a sub-page offers the parent's workspace templates everywhere (owner bug 2026-11-05): the
 * page's ⋯ menu, "Pages inside", the sidebar's + (/pages/new?parent=) and the workspace's own
 * domain. The parent sits in a folder whose default is that template, so it is preselected too;
 * each sub-page is made from it and checked through the API.
 *
 *   PB_STACK_ID=44 PB_WORK=… [BROWSER=webkit] [ONLY=menu,sidebar,inside,tenant] node subpage-templates.mjs
 */
import { APP, TENANT, log, fail, reseed, seedNow, api, docOf, launch, ctx, stepper, shot } from "./lib.mjs";

const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const browser = await launch();
const { step, results } = stepper(browser);
const run = Date.now().toString(36).slice(-5);
const NAME = `Team brief ${run}`;
const MARK = `Sub template body ${run}`;

async function must(r, what) {
  if (r.status >= 300) fail(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

// The world: a workspace template (saved by Ben, a member), a folder whose default it is, a parent page there.
const src = (await must(await api("POST", "/api/v1/pages", T.member, { title: `Brief source ${run}`, workspace: WS, folder: S.folder, content: `${MARK}\n\nWritten by {{author}}.\n` }), "source page")).document;
const tpl = await must(await api("POST", `/api/v1/documents/${src.slug}/save-as-template`, T.member, { scope: "workspace", name: NAME }), "save as template");
const specs = await must(await api("POST", `/api/v1/workspaces/${WS}/folders`, T.owner, { name: `Specs ${run}` }), "folder");
await must(await api("PUT", `/api/v1/workspaces/${WS}/folders/${specs.id}/default-template`, T.owner, { template: tpl.id }), "folder default");
const parent = (await must(await api("POST", "/api/v1/pages", T.member, { title: `Parent ${run}`, workspace: WS, folder: specs.id, content: "Parent body\n" }), "parent")).document;
log("template", tpl.id, "parent", parent.slug);

/** The gallery lists the workspace template, preselected (the folder's default); create the sub-page from it. */
async function fromGallery(p, title, shotName) {
  const dlg = p.getByRole("dialog");
  const sec = dlg.locator('[data-testid="tpl-workspace"]');
  await sec.waitFor({ timeout: 20000 });
  if (!(await sec.innerText()).includes("Acme")) fail(`the section isn't named for the workspace: ${(await sec.innerText()).slice(0, 200)}`);
  const card = sec.getByRole("button", { name: new RegExp(NAME) });
  await card.waitFor({ timeout: 10000 });
  await p.waitForFunction((n) => [...document.querySelectorAll('[data-testid="tpl-workspace"] button')].some((b) => b.textContent.includes(n) && b.getAttribute("aria-pressed") === "true"), NAME, { timeout: 10000 })
    .catch(() => fail("the folder's default template isn't preselected"));
  await dlg.locator(".pb-template-preview").getByText(MARK).waitFor({ timeout: 10000 });
  await dlg.getByLabel("Title").fill(title);
  await shot(p, shotName, { wait: 600 });
  await dlg.getByRole("button", { name: "Create page" }).click();
  await p.waitForURL(/\?edit=1/, { timeout: 30000 });
  const slug = new URL(p.url()).pathname.split("/").pop();
  const d = await docOf(slug, T.member);
  if (d.template_id !== tpl.id) fail(`${title}: template_id ${d.template_id}, expected ${tpl.id}`);
  if (!d.content.includes(MARK)) fail(`${title}: the template's body isn't in it: ${d.content.slice(0, 200)}`);
  if (d.parent?.slug !== parent.slug) fail(`${title}: parent ${d.parent?.slug}, expected ${parent.slug}`);
  log(title, "→", slug);
  return slug;
}

async function openEditor(p, url) {
  await p.goto(url, { waitUntil: "networkidle" });
  await p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p.waitForTimeout(800);
}

await step("menu", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await openEditor(p, `${APP}/${parent.slug}`);
  await p.getByRole("button", { name: "Page options" }).first().click();
  await p.getByRole("menuitem", { name: "Add a sub-page" }).click();
  await fromGallery(p, `From the menu ${run}`, "st-01-menu-gallery");
});

await step("inside", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await openEditor(p, `${APP}/${parent.slug}`);
  const btn = p.locator("section.pb-children").getByRole("button", { name: "Add a sub-page" });
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await fromGallery(p, `From pages inside ${run}`, "st-02-inside-gallery");
});

await step("sidebar", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await p.goto(`${APP}/w/${WS}/f/${specs.id}`, { waitUntil: "networkidle" });
  const tree = p.locator('aside nav[aria-label="Your drive"]');
  const row = tree.locator(`[data-rail-key="ws:${WS}:page:${parent.slug}"]`);
  await row.waitFor({ timeout: 20000 });
  await row.hover();
  await tree.getByRole("link", { name: `Add a page inside Parent ${run}` }).click();
  await p.waitForURL(/\/pages\/new\?parent=/, { timeout: 20000 });
  await fromGallery(p, `From the sidebar ${run}`, "st-03-sidebar-gallery");
});

await step("tenant", async () => {
  const { p } = await ctx(browser, { token: T.member });
  await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
  await p.goto(`${APP}/robots.txt`);
  const d = await docOf(parent.slug, T.member);
  const addr = `${TENANT}/${[...(d.folder_path || []), parent.slug].join("/")}`;
  await p.goto(addr, { waitUntil: "networkidle" });
  const ed = p.locator('.pb-live .ProseMirror[contenteditable="true"]');
  if (!(await ed.count())) {
    const signIn = p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ }))
      .or(p.getByRole("link", { name: /^Sign in$/ })).or(p.getByRole("button", { name: /^Sign in$/ }));
    await signIn.first().click({ timeout: 20000 });
    await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
    await p.waitForLoadState("networkidle");
  }
  await ed.waitFor({ timeout: 30000 });
  await p.waitForTimeout(800);
  await p.getByRole("button", { name: "Page options" }).first().click();
  await p.getByRole("menuitem", { name: "Add a sub-page" }).click();
  // Personal templates and managing stay on markdrop.in.
  const dlg = p.getByRole("dialog");
  await dlg.locator('[data-testid="tpl-workspace"]').waitFor({ timeout: 20000 });
  if (await dlg.getByRole("button", { name: "Manage" }).count()) fail("Manage templates offered on the domain");
  const slug = await fromGallery(p, `On the domain ${run}`, "st-04-tenant-gallery");
  if (!p.url().startsWith(TENANT)) fail(`left the domain: ${p.url()}`);
  log("tenant sub-page", slug);
});

console.log("\n" + results.map(([n, r, ms]) => `${r === "ok" ? "✓" : "✗"} ${n.padEnd(10)} ${r} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
await browser.close();
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
