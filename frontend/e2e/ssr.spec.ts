/**
 * Smoke tests 6 and 9 (REVAMP_PLAN §11.4): what the server sends for `/[slug]`.
 *
 * Guards §5.0 "ISR" and "Anonymous SSR": the document is rendered into the server HTML (no JS
 * needed to read it), the HTML is theme-agnostic, and an immersive document's HTML carries no site
 * header (§4.1: SiteHeader is rendered by DocumentView only in the framed state).
 */
import { expect, test } from "@playwright/test";
import { createDoc, longMarkdown, uniq } from "./support/stack";
import { getPage, settle, visit } from "./support/ui";

test("6 · /[slug] server HTML contains the rendered markdown", async ({ request, browser }) => {
  const marker = uniq("ssr");
  const doc = await createDoc({ title: `SSR ${marker}`, content: longMarkdown(`SSR ${marker}`) });

  // A plain request: no JavaScript at all.
  const res = await getPage(request, `/${doc.slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html, "headings are rendered, with the sanitizer's user-content- ids").toMatch(/<h2[^>]*id="user-content-first-section"[^>]*>\s*(<[^>]+>\s*)*First section/);
  expect(html).toContain(`SSR ${marker}`);
  expect(html).toMatch(/<strong>bold<\/strong>/);
  expect(html).toMatch(/<code[^>]*>inline code<\/code>/);
  expect(html).toMatch(/<table[\s>]/);
  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*>/);
  expect(html, "the markdown source is not what's served").not.toMatch(/^## First section$/m);

  // ISR: a second anonymous request is served from the cache. `next dev` never caches
  // (Cache-Control: no-store), so the header check only applies to a `next start` stack.
  const again = await getPage(request, `/${doc.slug}`);
  const cache = again.headers()["x-nextjs-cache"];
  const devServer = (again.headers()["cache-control"] || "").includes("no-store") && !cache;
  test.info().annotations.push({
    type: "isr",
    description: devServer ? "dev server: ISR cache header not checked (run against `next start`)" : `x-nextjs-cache: ${cache}`,
  });
  if (!devServer) expect(cache).toMatch(/HIT|STALE/);

  // With JavaScript disabled the text is still there to read. Only meaningful on a production
  // server (`next start`): `next dev` streams /[slug] through loading.tsx, and without JS the
  // streamed boundary is never swapped in, so a no-JS page there is blank by design of dev mode.
  // The raw-HTML assertions above are the dev-safe check. Force it with E2E_PROD_SERVER=1.
  const prodServer = process.env.E2E_PROD_SERVER === "1" || !devServer;
  if (prodServer) {
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    const page = await noJs.newPage();
    await visit(page, `/${doc.slug}`);
    await expect(page.getByRole("heading", { name: "First section" }).first()).toBeVisible();
    await expect(page.getByText(/Token buckets let bursts through/).first()).toBeVisible();
    await noJs.close();
  } else {
    test.info().annotations.push({ type: "no-js", description: "dev server: visual no-JS check skipped (set E2E_PROD_SERVER=1 against `next start`)" });
  }
});

test("9 · immersive hard reload: no site header in the server HTML or after hydration", async ({ request, page }) => {
  const marker = uniq("immersive");
  const doc = await createDoc({ title: `Immersive ${marker}`, content: longMarkdown(`Immersive ${marker}`) });

  const html = await (await getPage(request, `/${doc.slug}`)).text();
  expect(html).toContain(`Immersive ${marker}`);
  expect(html, "no <header> element in the server HTML").not.toMatch(/<header[\s>]/i);
  expect(html, "no banner landmark in the server HTML").not.toMatch(/role="banner"/i);

  // A hard load of the reader: hydration doesn't bring a site header back.
  await visit(page, `/${doc.slug}`);
  await expect(page.getByRole("heading", { name: "First section" }).first()).toBeVisible();
  await settle(page);
  await expect(page.getByRole("banner")).toHaveCount(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "First section" }).first()).toBeVisible();
  await settle(page);
  await expect(page.getByRole("banner")).toHaveCount(0);
});
