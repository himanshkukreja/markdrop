/**
 * End-to-end encryption, envelope v2 and the flows around it (the 2026-11 rework):
 * link + password mode, paste-the-link recovery, legacy mdx1 documents still opening and being
 * re-saved as mdx2 under the same link, a key rotation a stale tab can't undo (409), keyless
 * settings through PATCH, the key surviving a trip through sign-in — and, throughout, that no
 * request URL, body, header or cookie ever carries the key or the password.
 *
 * Needs the local stack (playwright.config.ts). The sandbox API's /__sandbox/user mints users.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import * as e2e from "../src/lib/e2e";
import { API_URL, createDoc, createEncryptedDoc, readDoc, uniq } from "./support/stack";
import { settle, visit } from "./support/ui";

/**
 * Records everything the context sends; `assertClean` fails if any of it holds one of the secrets.
 *
 * Skipped: `next dev`'s hot-reload channel (the /_next/webpack-hmr socket and the requests it
 * triggers, marked `next-hmr-refresh`). It reports the whole client router state, URL fragment
 * included, to the local dev server. Production has no such channel, and its router requests strip
 * the URL from that state (next/dist/client/flight-data-helpers prepareFlightRouterStateForRequest).
 */
function watchRequests(context: BrowserContext) {
  const seen: string[] = [];
  context.on("request", (r) => {
    if (r.headers()["next-hmr-refresh"]) return;
    seen.push(r.url());
    const body = r.postData();
    if (body) seen.push(body);
    for (const [k, v] of Object.entries(r.headers())) seen.push(`${k}: ${v}`);
  });
  context.on("page", (page) => {
    page.on("websocket", (ws) => {
      if (ws.url().includes("/_next/webpack-hmr")) return;
      seen.push(ws.url());
      ws.on("framesent", (f) => seen.push(String(f.payload)));
    });
  });
  return async (...secrets: string[]) => {
    const cookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`);
    for (const secret of secrets.filter(Boolean)) {
      for (const item of [...seen, ...cookies]) {
        expect(item.includes(secret), `a request or cookie carried a secret: ${item.slice(0, 200)}`).toBe(false);
      }
    }
  };
}

async function sealV2(title: string | null, content: string, password?: string) {
  const key = e2e.generateKey();
  const envelope = await e2e.seal(key, { title, content }, { password: password ?? null });
  return { envelope, key: e2e.exportKey(key) };
}

async function createV2Doc(title: string, content: string, opts: { password?: string; token?: string; access?: "link" | "private" } = {}) {
  const { envelope, key } = await sealV2(title, content, opts.password);
  const doc = await createDoc({ title: null, content: envelope, encrypted: true, access_level: opts.access }, opts.token);
  return { ...doc, key };
}

/** The edit secret in this tab's sessionStorage, where the publish flow leaves it. */
async function withSecret(context: BrowserContext, slug: string, secret: string) {
  await context.addInitScript(([s, v]) => {
    try { sessionStorage.setItem(`secret:${s}`, v); } catch { /* about:blank */ }
  }, [slug, secret] as const);
}

async function expectNoEnvelope(page: Page) {
  expect(await page.evaluate(() => /mdx[12]\./.test(document.body.innerText))).toBe(false);
}

test("v2 · publish with a password: the server gets neither; readers are asked for it in the browser", async ({ browser }) => {
  const marker = uniq("pw");
  const password = `correct horse ${marker}`;
  const ctx = await browser.newContext();
  const assertClean = watchRequests(ctx);
  const page = await ctx.newPage();
  await visit(page, "/new");
  await settle(page);
  await page.getByPlaceholder("Untitled document").fill(`Pw title ${marker}`);
  await page.locator("textarea").first().fill(`# Pw ${marker}\n\nBehind a password ${marker}.`);
  await page.getByRole("button", { name: /(^|:\s*)Encrypt(ed)?$/ }).first().click();
  await page.getByText("Encrypt in this browser", { exact: true }).first().click();
  await page.getByText("Also require a password", { exact: true }).first().click();
  await page.getByRole("textbox", { name: "Password", exact: true }).first().fill(password);
  await page.keyboard.press("Escape");

  const createReq = page.waitForRequest((r) => r.method() === "POST" && /\/api\/v1\/documents\/?$/.test(r.url()));
  await page.getByRole("button", { name: /^Publish(?!\s*settings)/i }).first().click();
  const sent = (await createReq).postDataJSON() as { title: string | null; content: string; encrypted: boolean; read_password: string | null };
  expect(sent.encrypted).toBe(true);
  expect(sent.title).toBeNull();
  expect(sent.read_password ?? null).toBeNull();
  expect(sent.content).toMatch(/^mdx2\./);
  expect(e2e.requiresPassword(sent.content)).toBe(true);

  await page.waitForURL(/\?new=1#k=[A-Za-z0-9_-]{43}$/, { timeout: 120_000 });
  const url = new URL(page.url());
  const slug = url.pathname.slice(1);
  const key = url.hash.slice(3);
  // The publisher isn't asked for what they just typed, and can copy the password on its own.
  await expect(page.getByRole("heading", { name: `Pw ${marker}` }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy password/ })).toBeVisible();
  await expectNoEnvelope(page);
  await assertClean(key, password);
  await ctx.close();

  // A reader with the full link: a password prompt, checked here.
  const reader = await browser.newContext();
  const assertReaderClean = watchRequests(reader);
  const r = await reader.newPage();
  await visit(r, `/${slug}#k=${key}`);
  await expect(r.getByRole("heading", { name: /also needs a password/i })).toBeVisible();
  await r.getByRole("textbox", { name: "Password", exact: true }).fill("not it");
  await r.getByRole("button", { name: "Open", exact: true }).click();
  await expect(r.getByRole("alert").filter({ hasText: /doesn't open it/ })).toBeVisible();
  await expect(r.getByText(/tampered|altered/i)).toHaveCount(0);
  await r.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await r.getByRole("button", { name: "Open", exact: true }).click();
  await expect(r.getByRole("heading", { name: `Pw ${marker}` }).first()).toBeVisible();
  await expectNoEnvelope(r);
  await assertReaderClean(key, password);
  await reader.close();
});

test("v2 · no key: paste the full link, parsed locally, opens it", async ({ browser }) => {
  const marker = uniq("paste");
  const doc = await createV2Doc(`Paste ${marker}`, `# Paste ${marker}\n\nRecovered ${marker}.`);
  const ctx = await browser.newContext();
  const assertClean = watchRequests(ctx);
  const page = await ctx.newPage();
  await visit(page, `/${doc.slug}`);
  await expect(page.getByText(/This document is end-to-end encrypted/i).first()).toBeVisible();
  await page.getByRole("button", { name: /Paste it here/ }).click();
  await page.getByLabel("Full link").fill(`https://markdrop.in/${doc.slug}#k=nope`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /doesn't contain a key/ })).toBeVisible();
  await page.getByLabel("Full link").fill(`https://markdrop.in/${doc.slug}#k=${doc.key}`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Paste ${marker}` }).first()).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(`#k=${doc.key}`);
  // Readers don't keep keys unless they ask to.
  expect(await page.evaluate(() => localStorage.getItem("markdrop_doc_keys"))).toBeNull();
  await assertClean(doc.key);
  await ctx.close();
});

test("v2 · a legacy mdx1 document opens with its old link, and re-saving writes mdx2 under the same link", async ({ browser }) => {
  const marker = uniq("legacy");
  const doc = await createEncryptedDoc(`Legacy ${marker}`, `# Legacy ${marker}\n\nOld format ${marker}.`);
  expect(doc.content.startsWith("mdx1.")).toBe(true);
  const ctx = await browser.newContext();
  const assertClean = watchRequests(ctx);
  await withSecret(ctx, doc.slug, doc.edit_secret);
  const page = await ctx.newPage();
  await visit(page, `/${doc.slug}?edit=1#k=${doc.key}`);
  const editor = page.getByRole("textbox", { name: "Markdown" }).first();
  await expect(editor).toHaveValue(new RegExp(`Old format ${marker}`));
  await editor.fill(`# Legacy ${marker}\n\nEdited ${marker}.`);
  const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes(`/api/v1/documents/${doc.slug}`));
  await page.getByRole("button", { name: "Save changes" }).click();
  const answered = await put;
  expect(answered.status()).toBe(200);
  const body = answered.request().postDataJSON() as { content: string; base_rev?: number; title: string | null };
  expect(body.content.startsWith("mdx2.")).toBe(true);
  expect(body.title).toBeNull();
  expect(body.base_rev).toBe(1);
  await expect(page.getByRole("heading", { name: `Legacy ${marker}` }).first()).toBeVisible();
  expect((await readDoc(doc.slug)).body?.content).toMatch(/^mdx2\./);
  await assertClean(doc.key);
  await ctx.close();

  // The same old link's key opens the new version (straight from the API: the page's cached
  // server render can lag a save by up to a minute, which the live socket then catches up).
  const stored = (await readDoc(doc.slug)).body?.content as string;
  const opened = await e2e.unseal(e2e.importKey(doc.key), stored);
  expect(opened.content).toContain(`Edited ${marker}.`);
  const reader = await browser.newContext();
  const r = await reader.newPage();
  await expect(async () => {
    await visit(r, `/${doc.slug}?fresh=${Date.now()}#k=${doc.key}`);
    await expect(r.getByText(`Edited ${marker}.`)).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  await reader.close();
});

test("v2 · a new key issued in one tab can't be undone by a stale tab (409, nothing written)", async ({ browser }) => {
  const marker = uniq("rotate");
  const doc = await createV2Doc(`Rotate ${marker}`, `# Rotate ${marker}\n\nVersion one ${marker}.`);
  const ctx = await browser.newContext();
  const assertClean = watchRequests(ctx);
  await withSecret(ctx, doc.slug, doc.edit_secret);
  const stale = await ctx.newPage();
  await visit(stale, `/${doc.slug}?edit=1#k=${doc.key}`);
  const staleEditor = stale.getByRole("textbox", { name: "Markdown" }).first();
  await expect(staleEditor).toHaveValue(new RegExp(`Version one ${marker}`));

  // Tab A issues a new key.
  const a = await ctx.newPage();
  await visit(a, `/${doc.slug}?edit=1#k=${doc.key}`);
  await expect(a.getByRole("textbox", { name: "Markdown" }).first()).toHaveValue(new RegExp(`Version one ${marker}`));
  await a.getByRole("button", { name: "Settings" }).click();
  await a.getByText("Issue a new key", { exact: true }).click();
  await a.getByRole("button", { name: "Done" }).click();
  await a.getByRole("button", { name: "Save with new key" }).click();
  await expect(a.getByText(/New key issued/)).toBeVisible();
  await a.waitForURL(/#k=[A-Za-z0-9_-]{43}$/);
  const newKey = new URL(a.url()).hash.slice(3);
  expect(newKey).not.toBe(doc.key);
  const rotated = (await readDoc(doc.slug)).body?.content as string;

  // The stale tab saves its old-key version: refused, the rotation stands.
  await staleEditor.fill(`# Rotate ${marker}\n\nStale overwrite ${marker}.`);
  await stale.getByRole("button", { name: "Save changes" }).click();
  await expect(stale.getByText(/Not saved: there's a newer version/)).toBeVisible();
  expect((await readDoc(doc.slug)).body?.content).toBe(rotated);
  // Loading the latest version with the old key: the honest screen, not "tampered".
  await stale.getByRole("button", { name: /Load the latest version/ }).click();
  await stale.getByRole("button", { name: "Cancel" }).first().click().catch(() => {});
  await assertClean(doc.key, newKey);
  await ctx.close();

  const reader = await browser.newContext();
  const r = await reader.newPage();
  await visit(r, `/${doc.slug}#k=${doc.key}`);
  await expect(r.getByRole("heading", { name: /doesn't open the current version/ })).toBeVisible();
  await expect(r.getByText(/tampered|altered/i)).toHaveCount(0);
  await visit(r, `/${doc.slug}#k=${newKey}`);
  await expect(r.getByText(`Version one ${marker}.`)).toBeVisible();
  await reader.close();
});

test("v2 · without the key, an expiry change goes through PATCH …/settings and the envelope is untouched", async ({ browser }) => {
  const marker = uniq("keyless");
  const doc = await createV2Doc(`Keyless ${marker}`, `# Keyless ${marker}`);
  const before = (await readDoc(doc.slug)).body?.content;
  const ctx = await browser.newContext();
  await withSecret(ctx, doc.slug, doc.edit_secret);
  const page = await ctx.newPage();
  const puts: string[] = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/api/v1/documents/")) puts.push(r.url()); });
  await visit(page, `/${doc.slug}?edit=1`);
  await expect(page.getByText(/can't be edited without the key/)).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByLabel("Expires").selectOption("7d");
  await page.getByRole("button", { name: "Done" }).click();
  const patch = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/v1/documents/${doc.slug}/settings`));
  await page.getByRole("button", { name: "Save settings" }).click();
  const answered = await patch;
  expect(answered.status()).toBe(200);
  expect(answered.request().postDataJSON()).toMatchObject({ expires_in: "7d" });
  const after = (await readDoc(doc.slug)).body!;
  expect(after.content).toBe(before);
  expect(after.expires_at).toBeTruthy();
  expect(puts).toEqual([]);
  await ctx.close();
});

test("v2 · the key survives a trip through sign-in (stashed in this tab, never in a URL)", async ({ browser }) => {
  const marker = uniq("signin");
  const res = await fetch(`${API_URL}/__sandbox/user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${marker}@example.com`, name: "Reader" }),
  });
  expect(res.ok).toBe(true);
  const user = (await res.json()) as { token: string };
  const doc = await createV2Doc(`Private ${marker}`, `# Private ${marker}\n\nSigned-in only ${marker}.`, { token: user.token, access: "private" });

  const ctx = await browser.newContext();
  const assertClean = watchRequests(ctx);
  const page = await ctx.newPage();
  await visit(page, `/${doc.slug}#k=${doc.key}`);
  await settle(page);
  const signIn = page.getByRole("link", { name: /Sign in to open/ }).first();
  await expect(signIn).toBeVisible();
  await signIn.click();
  await page.waitForURL(/\/login\?next=/);
  expect(page.url()).not.toContain(doc.key);
  // Signing in ends with a push to `next` (the page without its fragment).
  await page.evaluate((t) => localStorage.setItem("markdrop_token", t), user.token);
  await visit(page, `/${doc.slug}`);
  await expect(page.getByRole("heading", { name: `Private ${marker}` }).first()).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(`#k=${doc.key}`);
  // Single use: the stash is gone.
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("md_pending_key:")))).toEqual([]);
  await assertClean(doc.key);
  await ctx.close();
});
