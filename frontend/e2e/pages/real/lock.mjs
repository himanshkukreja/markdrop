/**
 * Workspace privacy Team → Locked → Team on the REAL stack (fix/lock-speed): the switch answers at
 * once, sign-in holds from that moment, the settings page shows "Applying to N items…" while files
 * catch up and stays usable, and switching back reopens everything.
 *
 *   PB_STACK_ID=22 PB_WORK=… PB_FIXTURES=… [N=80] node lock.mjs
 *
 * Start the API with PB_R2_LATENCY_MS (e.g. 300) so the fake R2 is as slow as the real one and the
 * background part takes long enough to watch.
 */
import { APP, WORKER, log, fail, reseed, api, launch, ctx, shot, stepper } from "./lib.mjs";

const N = Number(process.env.N || 80);
const S = reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const browser = await launch();
const { step, results } = stepper(browser);

/** N link-level items in Acme: HTML files (bytes in R2) and Markdown documents. */
async function seedItems() {
  const items = [];
  for (let i = 0; i < N; i++) {
    const slug = `lock-${i}-${Math.random().toString(36).slice(2, 7)}`;
    if (i % 4 === 3) {
      const r = await api("POST", "/api/v1/documents", T.owner, {
        title: `Note ${i}`, custom_slug: slug, expires_in: "never", content: `# Note ${i}\n\nOpen to anyone with the link.`,
        workspace: WS, access_level: "link",
      });
      if (r.status >= 300) fail(`doc ${i}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      items.push({ slug, file: false });
      continue;
    }
    const body = `<!doctype html><title>Page ${i}</title><h1>Page ${i}</h1>`;
    const u = await api("POST", "/api/v1/artifacts/upload-url", T.owner, { filename: `p${i}.html`, content_type: "text/html", size_bytes: body.length });
    if (u.status !== 200) fail(`upload-url ${i}: ${u.status}`);
    const put = await fetch(u.body.upload_url, { method: "PUT", body, headers: { "Content-Type": u.body.required_content_type } });
    if (!put.ok) fail(`PUT ${i}: ${put.status}`);
    const r = await api("POST", "/api/v1/artifacts", T.owner, {
      blob_key: u.body.blob_key, title: `Page ${i}`, filename: `p${i}.html`, custom_slug: slug, workspace: WS, access_level: "link",
    });
    if (r.status >= 300) fail(`artifact ${i}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    items.push({ slug, file: true, key: u.body.blob_key });
  }
  return items;
}

const anonStatus = async (slug) => (await api("GET", `/api/v1/documents/${slug}`, null)).status;
/** The artifact Worker's answer for a file's bytes, with no token (what a link someone kept gets). */
const rawStatus = async (key) => (await fetch(`${WORKER}/r/${key}`)).status;

const items = await seedItems();
const files = items.filter((i) => i.file);
log(`seeded ${items.length} link items (${files.length} files)`);

await step("lock", async () => {
  for (const it of items.slice(0, 6)) if ((await anonStatus(it.slug)) !== 200) fail(`${it.slug} not open before`);
  if ((await rawStatus(files[0].key)) !== 200) fail("file bytes not public before");

  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/settings/workspaces/${WS}`, { waitUntil: "networkidle" });
  const locked = p.getByRole("radio", { name: /Locked/ });
  await locked.waitFor({ timeout: 30000 });
  if (!(await p.getByRole("radio", { name: /Team/ }).isChecked())) fail("workspace isn't Team to start with");

  const t0 = Date.now();
  const resp = p.waitForResponse((r) => r.url().includes(`/api/v1/workspaces/${WS}`) && r.request().method() === "PUT", { timeout: 60000 });
  await locked.click();
  const r = await resp;
  const putMs = Date.now() - t0;
  const body = await r.json();
  log(`PUT answered in ${putMs} ms; access_sync=${JSON.stringify(body.access_sync)}`);
  if (putMs > 5000) fail(`the switch took ${putMs} ms`);

  // The gate holds the moment it answers: every item asks a visitor to sign in.
  const statuses = await Promise.all(items.map((it) => anonStatus(it.slug)));
  const open = items.filter((_, i) => statuses[i] !== 401);
  if (open.length) fail(`${open.length} item(s) still open right after the switch: ${open.slice(0, 3).map((x) => x.slug)}`);

  await p.getByRole("radio", { name: /Locked/ }).isChecked().then((c) => c || fail("Locked isn't selected"));
  if (body.access_sync?.state === "applying") {
    const note = p.getByTestId("access-sync").first();
    await note.waitFor({ timeout: 5000 });
    const text = await note.innerText();
    log(`progress: ${text.split("\n")[0]}`);
    if (!/Applying to \d+ items/.test(text)) fail(`unexpected progress text: ${text}`);
    await shot(p, "lock-applying");
    // The rest of the page works meanwhile: the preset cards and Invite people aren't blocked.
    if (await p.locator('fieldset[aria-busy="true"]').count()) fail("privacy cards still busy while applying");
    await p.getByRole("button", { name: "Invite people" }).click();
    await p.getByRole("dialog").waitFor({ timeout: 5000 });
    await p.keyboard.press("Escape");
    await note.waitFor({ state: "detached", timeout: 120000 });
  } else {
    log("finished inside the request (no progress to show)");
  }
  await p.getByText(/Locked everywhere|Locked: only members/).first().waitFor({ timeout: 10000 });
  const doneMs = Date.now() - t0;
  log(`fully applied after ${doneMs} ms`);
  // Every file's bytes now need a token at the Worker.
  const raw = await Promise.all(files.map((f) => rawStatus(f.key)));
  const leaking = files.filter((_, i) => raw[i] === 200);
  if (leaking.length) fail(`${leaking.length} file(s) still served without a token`);
  await shot(p, "lock-done");
});

await step("back-to-team", async () => {
  const { p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/settings/workspaces/${WS}`, { waitUntil: "networkidle" });
  const team = p.getByRole("radio", { name: /Team/ });
  await team.waitFor({ timeout: 30000 });
  const resp = p.waitForResponse((r) => r.url().includes(`/api/v1/workspaces/${WS}`) && r.request().method() === "PUT", { timeout: 60000 });
  await team.click();
  await resp;
  const note = p.getByTestId("access-sync");
  if (await note.count()) await note.first().waitFor({ state: "detached", timeout: 120000 });
  const statuses = await Promise.all(items.map((it) => anonStatus(it.slug)));
  const closed = items.filter((_, i) => statuses[i] !== 200);
  if (closed.length) fail(`${closed.length} item(s) still closed after Team: ${closed.slice(0, 3).map((x) => x.slug)}`);
  // Wait for the background part (if it outlived the page's poll) and check the bytes reopened.
  for (let i = 0; i < 120; i++) {
    const w = await api("GET", `/api/v1/workspaces/${WS}`, T.owner);
    if (w.body?.access_sync?.state !== "applying") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const raw = await Promise.all(files.map((f) => rawStatus(f.key)));
  const shut = files.filter((_, i) => raw[i] !== 200);
  if (shut.length) fail(`${shut.length} file(s) not public again`);
});

await step("lock-then-back-quickly", async () => {
  // Locked, and straight back to Team while the files are still being locked.
  const put = (on) => api("PUT", `/api/v1/workspaces/${WS}`, T.owner, { settings: { require_auth_to_view: on, default_access: "workspace" } });
  const a = await put(true);
  if (a.status !== 200) fail(`lock: ${a.status}`);
  const b = await put(false);
  if (b.status !== 200) fail(`unlock: ${b.status}`);
  for (let i = 0; i < 240; i++) {
    const w = await api("GET", `/api/v1/workspaces/${WS}`, T.owner);
    if (w.body?.access_sync?.state !== "applying") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const statuses = await Promise.all(items.map((it) => anonStatus(it.slug)));
  if (statuses.some((s) => s !== 200)) fail("items not open after Locked → Team");
  const raw = await Promise.all(files.map((f) => rawStatus(f.key)));
  if (raw.some((s) => s !== 200)) fail("files not public after Locked → Team");
});

await browser.close();
console.log("\n" + results.map(([n, s, ms]) => `${s === "ok" ? "✓" : "✗"} ${n} ${s === "ok" ? "" : s} (${(ms / 1000).toFixed(1)} s)`).join("\n"));
process.exit(results.some(([, s]) => s !== "ok") ? 1 : 0);
