/**
 * Folders through MCP and the app on the REAL stack (feat/folder-mcp):
 *
 *   mcp       create_folder refuses an address a page already has (no silent -2) and opts into a
 *             suffix; delete_folder refuses a non-empty folder with a listing; rename_folder;
 *             move_folder; delete_folder move_to_parent / trash and restore_document.
 *   redirect  a renamed folder's old address on the workspace's domain lands on the new one (and an
 *             item's old address under it too), in the browser.
 *   app       New folder with a taken name, and Rename folder… onto a sibling's name, show the error in
 *             the dialog and change nothing.
 *
 *   PB_STACK_ID=47 PB_WORK=… [BROWSER=webkit] [ONLY=mcp,redirect,app] node folders.mjs
 */
import { APP, TENANT, log, fail, reseed, mcpToken, api, mcp, launch, ctx, shot, stepper } from "./lib.mjs";

const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const ada = mcpToken("ada@acme.test"); // the workspace's owner
const ben = mcpToken("ben@acme.test"); // a member
const browser = await launch();
const { step, results } = stepper(browser);

const ok = async (tok, name, args) => {
  const r = await mcp(tok, name, args);
  if (r.isError) fail(`${name} → ${r.text}`);
  return r.data;
};
const refused = async (tok, name, args, re) => {
  const r = await mcp(tok, name, args);
  if (!r.isError) fail(`${name} should be refused: ${r.text.slice(0, 200)}`);
  if (re && !re.test(r.text)) fail(`${name} refusal says: ${r.text.slice(0, 300)}`);
  return r;
};
const folderPaths = async () => {
  const r = await api("GET", `/api/v1/workspaces/${WS}/folders`, T.owner);
  return r.body.folders.map((f) => f.path.join("/"));
};

await step("mcp", async () => {
  await ok(ada, "create_folder", { workspace: WS, path: "product-hub/prds" });
  const pub = await ok(ada, "publish_document", {
    markdown: "# Talent pool\n\nThe PRD.", title: "Talent pool PRD", slug: `feat-talent-${Date.now() % 100000}`,
    workspace: WS, folder: "product-hub/prds", access: "link",
  });
  const slug = pub.slug;
  // The Senseloaf case: a page already has the address → refused, nothing created, the page named.
  await refused(ada, "create_folder", { workspace: WS, path: `product-hub/prds/${slug}` }, /Talent pool PRD/);
  if ((await folderPaths()).some((p) => p.endsWith("-2"))) fail("a -2 folder appeared");
  const suffixed = await ok(ada, "create_folder", { workspace: WS, path: `product-hub/prds/${slug}`, on_conflict: "suffix" });
  if (suffixed.path !== `product-hub/prds/${slug}-2`) fail(`suffix gave ${suffixed.path}`);
  // Members can't delete, rename or move folders.
  await refused(ben, "delete_folder", { workspace: WS, path: suffixed.path }, /admins/);
  // Empty → trash.
  const del = await ok(ada, "delete_folder", { workspace: WS, path: suffixed.path });
  if (!del.deleted || del.result.mode !== "trash") fail(`delete empty: ${JSON.stringify(del)}`);
  // Non-empty → refused with a listing.
  await ok(ada, "create_folder", { workspace: WS, path: "product-hub/templates" });
  const r = await refused(ada, "delete_folder", { workspace: WS, path: "product-hub" }, /isn't empty/);
  const c = r.data?.contents;
  if (!c || c.folders !== 2 || c.items !== 1 || !c.sample.some((i) => i.slug === slug)) fail(`refusal listing: ${JSON.stringify(r.data)}`);
  // Rename + move.
  const ren = await ok(ada, "rename_folder", { workspace: WS, path: "product-hub", new_name: "Product" });
  if (ren.path !== "product" || !ren.redirects_from.includes("product-hub")) fail(`rename: ${JSON.stringify(ren)}`);
  const mv = await ok(ada, "move_folder", { workspace: WS, path: "product/templates", new_parent: "/" });
  if (mv.path !== "templates") fail(`move: ${JSON.stringify(mv)}`);
  // move_to_parent, then trash + restore.
  await ok(ada, "create_folder", { workspace: WS, path: "templates/inner" });
  await ok(ada, "delete_folder", { workspace: WS, path: "templates", contents: "move_to_parent" });
  if (!(await folderPaths()).includes("inner")) fail("move_to_parent didn't lift the subfolder");
  const tr = await ok(ada, "delete_folder", { workspace: WS, path: "inner", contents: "trash" });
  await ok(ada, "restore_document", { document: tr.result.restore_key });
  if (!(await folderPaths()).includes("inner")) fail("restore didn't bring the folder back");
  log("paths now", (await folderPaths()).join(", "));
  S.slug = slug;
});

await step("redirect", async () => {
  if (!S.slug) fail("needs the mcp step");
  const { c, p } = await ctx(browser, {});
  await p.goto(`${TENANT}/product-hub`, { waitUntil: "domcontentloaded" });
  await p.waitForURL(/\/product$/, { timeout: 15000 });
  await p.getByRole("heading", { name: "Product" }).first().waitFor({ timeout: 15000 });
  await shot(p, "folders-redirect-folder");
  await p.goto(`${TENANT}/product-hub/prds`, { waitUntil: "domcontentloaded" });
  await p.waitForURL(/\/product\/prds$/, { timeout: 15000 });
  await p.goto(`${TENANT}/product-hub/prds/${S.slug}`, { waitUntil: "domcontentloaded" });
  await p.waitForURL(new RegExp(`/product/prds/${S.slug}$`), { timeout: 15000 });
  await p.getByText("The PRD.").first().waitFor({ timeout: 15000 });
  const nothing = await p.goto(`${TENANT}/product-hub/nope`, { waitUntil: "domcontentloaded" });
  if (nothing.status() !== 404) fail(`a path that never existed answered ${nothing.status()}`);
  await c.close();
});

await step("app", async () => {
  const { c, p } = await ctx(browser, { token: T.admin });
  await p.goto(`${APP}/w/${WS}`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: "New", exact: true }).first().click();
  await p.getByRole("menuitem", { name: /New folder/ }).click();
  const dlg = p.getByRole("dialog", { name: "New folder" });
  await dlg.getByLabel("Folder name").fill("guides");
  await dlg.getByRole("button", { name: "Create folder" }).click();
  await dlg.getByText(/already a folder “Guides”/).waitFor({ timeout: 10000 });
  await shot(p, "folders-new-folder-taken");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  if ((await folderPaths()).includes("guides-2")) fail("New folder made guides-2");
  // Rename "Product" onto "Guides": refused in the dialog.
  const f = (await api("GET", `/api/v1/workspaces/${WS}/folders`, T.owner)).body.folders.find((x) => x.path.join("/") === "product");
  await p.goto(`${APP}/w/${WS}/f/${f.id}`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: "More folder actions" }).click();
  await p.getByRole("menuitem", { name: /Rename folder/ }).click();
  const rd = p.getByRole("dialog", { name: "Rename folder" });
  await rd.getByLabel("Name").fill("Guides");
  await rd.getByRole("button", { name: "Rename" }).click();
  await rd.getByText(/already a folder “Guides”/).waitFor({ timeout: 10000 });
  await shot(p, "folders-rename-taken");
  const still = (await api("GET", `/api/v1/workspaces/${WS}/folders`, T.owner)).body.folders.find((x) => x.id === f.id);
  if (still.name !== "Product") fail(`the folder was renamed to ${still.name}`);
  await c.close();
});

await browser.close();
console.log("\nResults (folders):");
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
