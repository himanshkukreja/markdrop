/**
 * Export, and the page's editor type, on the REAL stack (up.sh). Owner reports 2026-11-04:
 *   - Export "sometimes opens a new page that says it can't be opened";
 *   - the exported HTML / PDF draw the title over the cover;
 *   - "Open in the classic editor" / "Edit as Markdown" leave a page stuck as Markdown.
 *
 * Every entry point (the editor's ⋯, the reader's ⋯, a classic document, an encrypted document's
 * Download Markdown) × every format, as owner, editor, reader and anonymous, on the app and on the
 * workspace's own domain: a download happens (or the print layer, for PDF), no other page opens, the
 * page stays where it was, no error. The exported HTML's title never overlaps its cover (4 head
 * variants), and neither does the PDF's. Then: no classic option in a page's menus; Markdown mode
 * edits, returns to blocks and never survives a reload; a page switched to classic gets back.
 *
 *   BROWSER=chromium|webkit [ONLY=<step,…>] [EC_SHOTS=<dir>] node export.mjs
 *   steps: world exports-{owner,editor,reader,anonymous} exports-tenant exports-refused exports-classic
 *          exports-encrypted exports-mcp head no-classic markdown-mode recover recover-tenant
 */
import fs from "node:fs";
import path from "node:path";
import { APP, TENANT, API, SHOTS, BROWSER, log, fail, reseed, seedNow, api, mcp, mcpToken, docOf, launch, ctx, shot, stepper, waitSaved } from "./lib.mjs";

const browser = await launch();
const { step, results } = stepper(browser);
const S = process.env.NO_RESEED ? seedNow() : reseed();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const WS = S.ws;
const FOLDER = S.folder;
const OUT = path.join(SHOTS, "export");
fs.mkdirSync(OUT, { recursive: true });
const OWNER_SHOTS = process.env.EC_SHOTS || "";
if (OWNER_SHOTS) fs.mkdirSync(OWNER_SHOTS, { recursive: true });
const keep = (name) => (OWNER_SHOTS ? path.join(OWNER_SHOTS, `${BROWSER}-${name}`) : path.join(OUT, name));

async function uploadAsset(slug, token, label, colors, w = 1500, h = 480) {
  const tmp = await browser.newPage({ viewport: { width: w, height: h } });
  await tmp.setContent(`<style>body{margin:0}</style><div style="width:${w}px;height:${h}px;display:grid;place-items:center;background:linear-gradient(135deg,${colors[0]},${colors[1]});font:700 64px system-ui;color:#fff">${label}</div>`);
  const buf = await tmp.screenshot();
  await tmp.close();
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/png" }), `${label.replace(/\W+/g, "-")}.png`);
  const r = await fetch(`${API}/api/v1/documents/${slug}/assets`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  if (r.status >= 300) fail(`asset upload → ${r.status} ${await r.text()}`);
  return (await r.json()).id;
}

async function setContent(slug, token, md) {
  const d = await docOf(slug, token);
  const r = await api("PUT", `/api/v1/documents/${slug}`, token, { title: d.title, content: md, base_rev: d.rev });
  if (r.status !== 200) fail(`PUT ${slug} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
}

const BODY = `Intro paragraph with **bold**, *italic* and a [link](https://example.com/).

:::tip
A tip callout with text.
:::

## Section two

- one
- two

::::columns
:::column
Left column text.
:::
:::column
Right column text.
:::
::::

:::details{summary="A toggle"}
Hidden inside the toggle.
:::

| a | b |
|---|---|
| 1 | 2 |

\`\`\`js
const x = 1;
\`\`\`
`;

// ── The world: a page with a cover, an icon, an image and a sub-page; a public one; a classic doc. ──
const mk = async (title, extra = {}) => (await api("POST", "/api/v1/pages", T.owner, { title, workspace: WS, folder: FOLDER, ...extra })).body.document.slug;
const W = {};
async function world() {
  W.page = await mk("Export probe");
  const cover = await uploadAsset(W.page, T.owner, "Cover", ["#0ea5e9", "#a855f7"]);
  const img = await uploadAsset(W.page, T.owner, "Inline", ["#f97316", "#db2777"], 640, 360);
  await setContent(W.page, T.owner, `---\nicon: 🚀\ncover: asset:${cover}\n---\n${BODY}\n![An image](asset:${img})\n`);
  W.kid = (await api("POST", "/api/v1/pages", T.owner, { title: "Export child", parent: W.page })).body.document.slug;
  await setContent(W.kid, T.owner, "A sub-page body.\n");
  // Anyone with the link can read it (anonymous, and the reader checks).
  const lv = await api("PUT", `/api/v1/documents/${W.page}/access/level`, T.owner, { level: "link" });
  if (lv.status !== 204) fail(`access level → ${lv.status}`);
  await api("PUT", `/api/v1/documents/${W.kid}/access/level`, T.owner, { level: "link" });
  log("world", W);
}

/** A classic or encrypted document opens full screen (no bar): back to the framed reader. */
async function leaveFullScreen(p) {
  await p.waitForTimeout(600);
  if (await p.locator(".md-viewer-immersive").count()) {
    await p.keyboard.press("Escape");
    await p.locator(".md-viewer-immersive").waitFor({ state: "detached", timeout: 5000 });
  }
}

/** Opens the ⋯ menu wherever it is (the editor's "Page options", the reader's "More actions"). */
async function openMenu(p) {
  const btn = p.getByRole("button", { name: /^(Page options|More actions)$/ }).filter({ visible: true }).last();
  await btn.waitFor({ timeout: 20000 });
  await btn.click();
  await p.locator('[role="menu"]').last().waitFor({ timeout: 5000 });
}

/** Watches for what must never happen: another page, a navigation, a page error, a failed export call. */
function watch(c, p) {
  const w = { pages: [], navs: [], errors: [], bad: [] };
  c.on("page", (np) => w.pages.push(np.url() || "(blank)"));
  p.on("framenavigated", (f) => f === p.mainFrame() && w.navs.push(f.url()));
  p.on("pageerror", (e) => w.errors.push(e.message));
  p.on("response", (r) => r.url().includes("/export") && r.status() >= 400 && w.bad.push(`${r.status()} ${r.url()}`));
  return w;
}

/** Export one format through the dialog; returns the saved file (or null for PDF). */
async function exportVia(p, { format, subpages = false, images = null, expectFail = false }) {
  await openMenu(p);
  await p.getByRole("menuitem", { name: /^Export/ }).first().click();
  const dlg = p.getByRole("dialog", { name: /Export page/ });
  await dlg.waitFor({ timeout: 10000 });
  await dlg.getByRole("radio", { name: new RegExp(`^${format}`, "i") }).click();
  // The switches are visually hidden checkboxes: click their labels.
  const flip = async (name, want) => {
    const sw = dlg.getByRole("switch", { name });
    if (want === null || !(await sw.count())) return;
    if ((await sw.isChecked()) !== want) await dlg.getByText(name, { exact: true }).click();
    if ((await sw.isChecked()) !== want) fail(`couldn't set ${name}`);
  };
  await flip("Include sub-pages", subpages);
  await flip("Include images", images);
  const go = dlg.getByRole("button", { name: /^(Download|Print to PDF)/ });
  if (format === "pdf") {
    await go.click();
    await p.waitForFunction(() => window.__printed === true, null, { timeout: 30000 });
    return null;
  }
  if (expectFail) {
    await go.click();
    await dlg.locator(".pbx-error").waitFor({ timeout: 15000 });
    return null;
  }
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), go.click()]);
  const file = path.join(OUT, `${Date.now().toString(36)}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  if (await dl.failure()) fail(`download failed: ${await dl.failure()}`);
  return { file, name: dl.suggestedFilename(), size: fs.statSync(file).size };
}

async function stubPrint(c) {
  await c.addInitScript(() => {
    window.__printed = false;
    window.print = () => {
      window.__printed = true;
    };
  });
}

const CASES = [
  { format: "markdown", images: false, ext: /\.md$/ },
  { format: "markdown", images: true, ext: /\.zip$/ },
  { format: "markdown", subpages: true, ext: /\.zip$/ },
  { format: "html", ext: /\.html$/ },
  { format: "html", subpages: true, ext: /\.zip$/ },
  { format: "pdf" },
  { format: "pdf", subpages: true },
];

async function runAll(who, token, url, { tenant = false } = {}) {
  const { c, p } = await ctx(browser, { token });
  await stubPrint(c);
  const w = watch(c, p);
  if (tenant) {
    await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
    if (token) {
      await p.goto(`${APP}/robots.txt`);
      await p.goto(url, { waitUntil: "networkidle" });
      const signIn = p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ })).or(p.getByRole("link", { name: /^Sign in$/ })).or(p.getByRole("button", { name: /^Sign in$/ }));
      if (await signIn.count()) {
        await signIn.first().click();
        await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
      }
    }
  }
  await p.goto(url, { waitUntil: "networkidle" });
  await p.locator(".pb-title").first().waitFor({ timeout: 30000 });
  if (token && who !== "reader") await p.locator(".pb-live").waitFor({ timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(800);
  const start = p.url();
  const errs0 = w.errors.length;
  for (const k of CASES) {
    const label = `${who}${tenant ? "@tenant" : ""} ${k.format}${k.subpages ? "+sub" : ""}${k.images === true ? "+img" : ""}`;
    const navs = w.navs.length;
    const got = await exportVia(p, k);
    if (got) {
      if (!k.ext.test(got.name)) fail(`${label}: file ${got.name}`);
      if (got.size < 20) fail(`${label}: ${got.size} bytes`);
      if (k.format === "html" && !k.subpages && !fs.readFileSync(got.file, "utf8").includes('<h1 class="title">Export probe</h1>')) fail(`${label}: not the page`);
      log(`${label} → ${got.name} (${got.size} B)`);
    } else log(`${label} → print layer, print() called`);
    // The PDF's print layer goes after the print dialog; the stub never closes one: reset by hand.
    if (k.format === "pdf") {
      await p.evaluate(() => window.dispatchEvent(new Event("afterprint")));
      await p.locator(".pbx-print").waitFor({ state: "detached", timeout: 10000 });
      await p.evaluate(() => (window.__printed = false));
    }
    await p.getByRole("dialog", { name: /Export page/ }).waitFor({ state: "detached", timeout: 10000 });
    if (w.navs.length !== navs) fail(`${label}: navigated to ${w.navs.slice(navs).join(", ")}`);
  }
  if (w.pages.length) fail(`${who}: another page opened: ${w.pages.join(", ")}`);
  if (p.url() !== start) fail(`${who}: left the page: ${start} → ${p.url()}`);
  if (w.bad.length) fail(`${who}: export calls failed: ${w.bad.join("; ")}`);
  if (w.errors.length > errs0) fail(`${who}: page errors while exporting: ${w.errors.slice(errs0).join("; ")}`);
  await shot(p, `export-${who}${tenant ? "-tenant" : ""}`);
  await c.close();
}

await step("world", world);

const tenantUrl = async (slug) => {
  const d = await docOf(slug, T.owner);
  return `${TENANT}/${[...(d.folder_path || []), slug].join("/")}`;
};
for (const [who, token] of [["owner", T.owner], ["editor", T.member], ["reader", T.reader], ["anonymous", null]]) {
  await step(`exports-${who}`, () => runAll(who, token, `${APP}/${W.page}`));
}
await step("exports-tenant", async () => {
  const url = await tenantUrl(W.page);
  for (const [who, token] of [["owner", T.owner], ["editor", T.member], ["reader", T.reader], ["anonymous", null]]) {
    await runAll(who, token, url, { tenant: true });
  }
});

/* Readers when the page doesn't allow exports: no Export in the menu, the API refuses; and a refusal
   that comes while the dialog is open (an editor turned it off meanwhile) is a message in the dialog. */
await step("exports-refused", async () => {
  const slug = await mk("No exports");
  await setContent(slug, T.owner, "---\nallow_export: false\n---\nNothing to export.\n");
  await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: "link" });
  {
    const { c, p } = await ctx(browser, { token: T.reader });
    await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
    await openMenu(p);
    if (await p.getByRole("menuitem", { name: /^Export/ }).count()) fail("a reader sees Export on a page that refuses it");
    await c.close();
  }
  const r = await fetch(`${API}/api/v1/documents/${slug}/export?format=md`, { headers: { Authorization: `Bearer ${T.reader}` } });
  if (r.status !== 403) fail(`refused export → ${r.status}`);
  // Allowed when the dialog opens, refused when Download is pressed.
  await setContent(slug, T.owner, "Exportable for now.\n");
  for (const [where, url] of [["app", `${APP}/${slug}`], ["tenant", null]]) {
    const { c, p } = await ctx(browser, { token: where === "app" ? T.reader : null });
    const w = watch(c, p);
    await p.goto(url ?? (await tenantUrl(slug)), { waitUntil: "networkidle" });
    await p.locator(".pb-title").first().waitFor({ timeout: 30000 });
    await openMenu(p);
    await p.getByRole("menuitem", { name: /^Export/ }).first().click();
    const dlg = p.getByRole("dialog", { name: /Export page/ });
    await dlg.waitFor({ timeout: 10000 });
    await setContent(slug, T.owner, "---\nallow_export: false\n---\nNot any more.\n");
    const start = p.url();
    await dlg.getByRole("button", { name: /^Download/ }).click();
    const err = dlg.locator(".pbx-error");
    await err.waitFor({ timeout: 15000 });
    const text = await err.innerText();
    if (!/turned off exporting/.test(text)) fail(`${where}: the refusal reads "${text}"`);
    await shot(p, `export-refused-${where}`);
    if (OWNER_SHOTS) await p.screenshot({ path: keep(`bug1-refused-in-app-${where}.png`) });
    if (w.pages.length || p.url() !== start) fail(`${where}: a refusal opened or left a page: ${JSON.stringify(w.pages)} ${p.url()}`);
    await c.close();
    await setContent(slug, T.owner, "Exportable for now.\n");
  }
});

/* A classic document's Export PDF prints in place. */
await step("exports-classic", async () => {
  const { c, p } = await ctx(browser, { token: T.reader });
  await stubPrint(c);
  const w = watch(c, p);
  await p.goto(`${APP}/public-handbook`, { waitUntil: "networkidle" });
  await leaveFullScreen(p);
  const start = p.url();
  await openMenu(p);
  await p.getByRole("menuitem", { name: /Export PDF/ }).click();
  await p.waitForFunction(() => window.__printed === true, null, { timeout: 10000 });
  if (w.pages.length || w.bad.length || p.url() !== start) fail(`classic Export PDF: ${JSON.stringify(w)}`);
  await c.close();
});

/* An end-to-end encrypted document: Download Markdown is made here, saved here, in place. */
await step("exports-encrypted", async () => {
  const e2e = await import("../../../src/lib/e2e.ts");
  const key = e2e.generateKey();
  const text = "# Sealed notes\n\nOnly this browser can read **this**.\n";
  const sealed = await e2e.seal(key, { title: "Sealed notes", content: text });
  const made = await api("POST", "/api/v1/documents", null, { title: null, content: sealed, encrypted: true, expires_in: "never", access_level: "link" });
  if (made.status >= 300) fail(`encrypted publish → ${made.status} ${JSON.stringify(made.body)}`);
  const slug = made.body.slug;
  const { c, p } = await ctx(browser, {});
  const w = watch(c, p);
  await p.goto(`${APP}/${slug}#k=${e2e.exportKey(key)}`, { waitUntil: "networkidle" });
  await p.getByText("Only this browser can read").waitFor({ timeout: 30000 });
  await leaveFullScreen(p);
  const start = p.url();
  await openMenu(p);
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 15000 }), p.getByRole("menuitem", { name: /Download Markdown/ }).click()]);
  const file = path.join(OUT, `${Date.now().toString(36)}-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  if (!/\.md$/.test(dl.suggestedFilename())) fail(`encrypted: ${dl.suggestedFilename()}`);
  if (fs.readFileSync(file, "utf8") !== text) fail("encrypted: not the decrypted Markdown");
  await p.waitForTimeout(800);
  if (w.pages.length || p.url() !== start) fail(`encrypted: ${JSON.stringify(w.pages)} ${p.url()}`);
  await c.close();
});

/* An AI app's export link (MCP export_page), clicked: the file downloads; a link that no longer works
   is a readable page, not raw JSON. */
await step("exports-mcp", async () => {
  const tok = mcpToken(S.users.owner.email);
  const r = await mcp(tok, "export_page", { document: W.page, format: "html" });
  const url = r.data?.download_url;
  if (!url) fail(`export_page: ${r.text}`);
  const { c, p } = await ctx(browser, {});
  await p.setContent(`<a id=l href="${url}" target=_blank>Download</a><a id=x href="${url}x" target=_blank>Old link</a>`);
  // The browser reports the download on the page that opened the link, or on the new tab.
  const anyDownload = new Promise((ok) => {
    p.once("download", ok);
    c.once("page", (np) => np.once("download", ok));
  });
  const [dl] = await Promise.all([Promise.race([anyDownload, new Promise((_, no) => setTimeout(() => no(new Error("no download from the MCP link")), 15000))]), p.click("#l")]);
  if (!/\.html$/.test(dl.suggestedFilename())) fail(`mcp link: ${dl.suggestedFilename()}`);
  const [np] = await Promise.all([c.waitForEvent("page"), p.click("#x")]);
  await np.waitForLoadState();
  const body = await np.locator("body").innerText();
  if (!/This download link has expired/.test(body) || /^\s*\{/.test(body)) fail(`expired link page: ${body.slice(0, 200)}`);
  await np.screenshot({ path: OWNER_SHOTS ? keep("bug1-mcp-expired-link.png") : path.join(SHOTS, "export-mcp-expired.png") });
  await c.close();
});

// ── The exported HTML and the PDF: the title never sits on the cover (cover+icon, cover, icon, none) ──
const overlap = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const box = (p, sel) => p.locator(sel).first().boundingBox().catch(() => null);
function checkHead(where, name, t, cov, ic) {
  if (!t) fail(`${where} ${name}: no title`);
  if (overlap(t, cov)) fail(`${where} ${name}: the title overlaps the cover ${JSON.stringify({ t, cov })}`);
  if (ic && overlap(t, ic)) fail(`${where} ${name}: the title overlaps the icon ${JSON.stringify({ t, ic })}`);
  if (cov && t.y < cov.y + cov.height) fail(`${where} ${name}: the title isn't below the cover`);
  if (cov && ic && !(ic.y < cov.y + cov.height && ic.y + ic.height > cov.y + cov.height)) fail(`${where} ${name}: the icon doesn't sit on the cover's bottom edge ${JSON.stringify({ ic, cov })}`);
}
await step("head", async () => {
  const variants = [
    ["cover-icon", (cv) => `---\nicon: 🚀\ncover: asset:${cv}\n---\n`],
    ["cover", (cv) => `---\ncover: asset:${cv}\n---\n`],
    ["icon", () => `---\nicon: 📘\n---\n`],
    ["none", () => ""],
  ];
  for (const [name, front] of variants) {
    const slug = await mk(`Head ${name}`);
    const cv = await uploadAsset(slug, T.owner, `Cover ${name}`, ["#22c55e", "#0ea5e9"]);
    await setContent(slug, T.owner, `${front(cv)}${BODY}`);
    await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: "link" });
    // 1. The page as a reader sees it (and as it prints with the browser's own Print).
    {
      const { c, p } = await ctx(browser, { width: 1200, height: 900 });
      await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
      await p.locator(".pb-title").first().waitFor({ timeout: 30000 });
      await p.waitForTimeout(1200);
      await p.screenshot({ path: keep(`head-${name}-1-reader.png`) });
      checkHead("reader", name, await box(p, ".pb-title"), await box(p, ".pb-cover-img"), await box(p, ".pb-head__icon"));
      await c.close();
    }
    const { c, p } = await ctx(browser, { token: T.owner, width: 1200, height: 900 });
    await stubPrint(c);
    await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
    await p.locator(".pb-live .ProseMirror").waitFor({ timeout: 30000 });
    await p.waitForTimeout(800);
    // 2. The HTML export, opened as a file, on screen and printed.
    const html = await exportVia(p, { format: "html" });
    const v = await c.newPage();
    await v.setViewportSize({ width: 1200, height: 900 });
    await v.goto(`file://${html.file}`);
    await v.waitForTimeout(500);
    await v.screenshot({ path: keep(`head-${name}-2-html.png`) });
    checkHead("html", name, await box(v, "h1.title"), await box(v, ".cover"), await box(v, ".icon-box"));
    await v.emulateMedia({ media: "print" });
    await v.waitForTimeout(200);
    checkHead("html print", name, await box(v, "h1.title"), await box(v, ".cover"), await box(v, ".icon-box"));
    if (BROWSER === "chromium") await v.pdf({ path: keep(`head-${name}-2-html-printed.pdf`), format: "A4", printBackground: true });
    await v.close();
    // 3. The PDF: the print layer, laid out for print.
    await exportVia(p, { format: "pdf" });
    await p.emulateMedia({ media: "print" });
    await p.waitForTimeout(400);
    checkHead("pdf", name, await box(p, ".pbx-print .pb-title"), await box(p, ".pbx-print .pb-cover-img"), await box(p, ".pbx-print .pb-head__icon"));
    await p.screenshot({ path: keep(`head-${name}-3-pdf-layout.png`), fullPage: true });
    if (BROWSER === "chromium") await p.pdf({ path: keep(`head-${name}-3.pdf`), format: "A4", printBackground: true });
    await p.emulateMedia({ media: "screen" });
    await p.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    log(`head ${name}: ok`);
    await c.close();
  }
});

// ── Editor type: no classic option on a page; Markdown mode is temporary; back from classic ──
const blocksReady = (p) => p.locator('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
await step("no-classic", async () => {
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${W.page}`, { waitUntil: "networkidle" });
  await blocksReady(p);
  await openMenu(p);
  if (await p.getByRole("menuitem", { name: /classic editor/i }).count()) fail("the page's ⋯ still offers the classic editor");
  if (!(await p.getByRole("menuitem", { name: /Edit as Markdown/ }).count())) fail("Edit as Markdown is missing");
  await p.screenshot({ path: keep("bug3-page-menu.png") });
  await c.close();
});

await step("markdown-mode", async () => {
  const slug = await mk("Markdown mode probe");
  await setContent(slug, T.owner, "---\nicon: 🧪\n---\nFirst paragraph.\n");
  const { c, p } = await ctx(browser, { token: T.owner });
  await p.goto(`${APP}/${slug}`, { waitUntil: "networkidle" });
  await blocksReady(p);
  await openMenu(p);
  await p.getByRole("menuitem", { name: /Edit as Markdown/ }).click();
  const ta = p.locator(".pb-live textarea.dxe-source__text");
  await ta.waitFor({ timeout: 10000 });
  // A clear way back, on screen.
  const back = p.getByRole("region", { name: "Markdown source" }).getByRole("button", { name: "Edit with blocks" });
  await back.waitFor({ timeout: 5000 });
  await p.screenshot({ path: keep("bug3-markdown-mode.png") });
  await ta.click();
  await ta.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await p.keyboard.type("\n## Added in Markdown\n\nTyped as **Markdown**.\n");
  await waitSaved(p);
  const d = await docOf(slug, T.owner);
  if (!d.content.includes("## Added in Markdown")) fail(`markdown edit not saved:\n${d.content}`);
  if (d.editor !== "blocks") fail(`the editor type changed: ${d.editor}`);
  await back.click();
  await blocksReady(p);
  await p.locator(".pb-live .ProseMirror h2", { hasText: "Added in Markdown" }).waitFor({ timeout: 10000 });
  await p.screenshot({ path: keep("bug3-back-to-blocks.png") });
  // Markdown mode again, then reload: blocks, and still a page.
  await openMenu(p);
  await p.getByRole("menuitem", { name: /Edit as Markdown/ }).click();
  await ta.waitFor({ timeout: 10000 });
  await p.reload({ waitUntil: "networkidle" });
  await blocksReady(p);
  if (await p.locator(".pb-live textarea.dxe-source__text").count()) fail("Markdown mode survived a reload");
  await p.locator(".pb-live .ProseMirror strong", { hasText: "Markdown" }).waitFor({ timeout: 10000 });
  // …and another page opened from here starts in blocks too.
  await openMenu(p);
  await p.getByRole("menuitem", { name: /Edit as Markdown/ }).click();
  await ta.waitFor({ timeout: 10000 });
  await p.goto(`${APP}/${W.page}`, { waitUntil: "networkidle" });
  await blocksReady(p);
  if (await p.locator(".pb-live textarea.dxe-source__text").count()) fail("Markdown mode followed to another page");
  if ((await docOf(slug, T.owner)).editor !== "blocks") fail("not a page after Markdown mode");
  await c.close();
});

async function recover(url, label, { tenant = false } = {}) {
  // A page someone switched to the classic editor before the option went away.
  const slug = await mk(`Was a page ${label}`);
  await setContent(slug, T.owner, "---\nicon: 🧭\n---\nStill a page at heart.\n");
  await api("POST", "/api/v1/pages", T.owner, { title: "Its child", parent: slug });
  await api("PUT", `/api/v1/documents/${slug}/access/level`, T.owner, { level: "link" });
  const sw = await api("PUT", `/api/v1/documents/${slug}/editor`, T.owner, { editor: "classic" });
  if (sw.status !== 200) fail(`switch to classic → ${sw.status}`);
  const addr = await url(slug);
  for (const [who, token] of [["owner", T.owner], ["editor", T.member], ["reader", T.reader]]) {
    const { c, p } = await ctx(browser, { token });
    if (tenant) {
      await fetch(`${APP}/api/revalidate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tag: "host:acme.localhost" }) });
      await p.goto(`${APP}/robots.txt`);
      await p.goto(addr, { waitUntil: "networkidle" });
      await leaveFullScreen(p);
      const signIn = p.getByRole("button", { name: /Sign in to read/ }).or(p.getByRole("link", { name: /Sign in to read/ })).or(p.getByRole("link", { name: /^Sign in$/ })).or(p.getByRole("button", { name: /^Sign in$/ }));
      await signIn.first().click({ timeout: 20000 });
      await p.waitForURL((u) => u.hostname === "acme.localhost" && !u.hash.includes("mdt="), { timeout: 30000 }).catch(() => {});
    }
    await p.goto(addr, { waitUntil: "networkidle" });
    await p.getByText("Still a page at heart.").first().waitFor({ timeout: 30000 });
    // Its editors get the framed reader (the banner, the menu); a reader may get full screen.
    if (who === "reader") await leaveFullScreen(p);
    const banner = p.getByRole("button", { name: /^Switch back to the page editor$/ });
    if (who === "reader") {
      await p.waitForTimeout(1500);
      if (await banner.count()) fail(`${label}: a reader sees the switch-back banner`);
      await openMenu(p);
      if (await p.getByRole("menuitem", { name: /Switch back to the page/ }).count()) fail(`${label}: a reader can switch it back`);
      await c.close();
      continue;
    }
    await banner.first().waitFor({ timeout: 20000 });
    await p.screenshot({ path: keep(`bug3-recover-banner-${label}-${who}.png`) });
    await openMenu(p);
    if (!(await p.getByRole("menuitem", { name: /Switch back to the page editor/ }).count())) fail(`${label} ${who}: no switch-back item in ⋯`);
    await p.screenshot({ path: keep(`bug3-recover-menu-${label}-${who}.png`) });
    await p.keyboard.press("Escape");
    if (who === "editor") {
      await banner.first().click();
      await p.getByRole("dialog").getByRole("button", { name: /^Switch back$/ }).click();
      await blocksReady(p);
      const d = await docOf(slug, T.owner);
      if (d.editor !== "blocks") fail(`${label}: not a page again: ${d.editor}`);
      await p.locator(".pb-head__icon").first().waitFor({ timeout: 10000 });
      await p.screenshot({ path: keep(`bug3-recovered-${label}.png`) });
    }
    await c.close();
  }
}
await step("recover", () => recover(async (s) => `${APP}/${s}`, "app"));
await step("recover-tenant", () => recover(tenantUrl, "tenant", { tenant: true }));

await browser.close();
fs.writeFileSync(path.join(SHOTS, "export-results.json"), JSON.stringify(results, null, 1));
console.log(`\nResults (${BROWSER}):`);
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
