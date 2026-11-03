/**
 * MCP end to end on the real stack: each of the 11 page tools through the hosted /mcp endpoint (an
 * OAuth access token minted like the OAuth flow does), then a page with every block written with
 * update_page, opened in the editor and the reader, and checked to round-trip.
 *
 *   BROWSER=chromium node mcp.mjs   (expects seed.json: run real.mjs first)
 */
import fs from "node:fs";
import path from "node:path";
import { APP, SHOTS, log, fail, seedNow, mcpToken, api, mcp, docOf, launch, ctx, shot, stepper, pngBytes, waitSaved } from "./lib.mjs";

const S = seedNow();
const T = Object.fromEntries(Object.entries(S.users).map(([k, u]) => [k, u.token]));
const ada = mcpToken("ada@acme.test");
const adaRead = mcpToken("ada@acme.test", true);
const cy = mcpToken("cy@else.test");
const browser = await launch();
const { step, results } = stepper(browser);
const st = {};
const ok = async (tok, name, args) => {
  const r = await mcp(tok, name, args);
  if (r.isError) fail(`${name} → ${r.text}`);
  return r;
};
const refused = async (tok, name, args, re) => {
  const r = await mcp(tok, name, args);
  if (!r.isError && r.status === 200) fail(`${name} should be refused: ${r.text.slice(0, 200)}`);
  if (re && !re.test(r.text)) fail(`${name} refusal says: ${r.text.slice(0, 200)}`);
  return r;
};

const ALL = `---
icon: 🧪
cover: gallery:ocean
cover_y: 30
---

## Text

Plain **bold** *italic* ~~strike~~ \`code\` and a [link](https://example.com).

> A quote.

---

- Bulleted
  - Nested
1. Numbered
2. Second

- [ ] To-do
- [x] Done

| Case | Expected |
| --- | --- |
| Sign in | Dashboard opens |

\`\`\`python
print("hello")
\`\`\`

\`\`\`mermaid
graph TD
  A[Start] --> B[Finish]
\`\`\`

Inline math $E = mc^2$.

$$
a^2 + b^2 = c^2
$$

:::details{summary="Why does this happen?"}
Because of this.
:::

:::details{summary="FAQ" heading="2"}
Questions and answers.
:::

:::note
Background or context.
:::

:::tip[A title]
A shortcut.
:::

:::warning{icon="⏳" color="yellow"}
Careful.
:::

:::danger
Data loss.
:::

![A diagram](https://example.com/diagram.png "Its caption")

::markdrop{src="q3-report"}

::markdrop{src="pricing-calc" mode="preview"}

::markdrop{src="launch-plan" mode="card"}

Read :markdrop[Launch plan]{src="launch-plan"} first.

::toc

::breadcrumb

::bookmark{url="https://example.com/" title="Example Domain" site="example.com"}

::embed{src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"}

Due :date[2026-11-10], owner :person[Ben Member]{id="${S.users.member.id}"}, press :kbd[⌘ K].
`;

await step("tools", async () => {
  // list_page_templates
  const tl = await ok(ada, "list_page_templates", {});
  if (tl.data.templates.length !== 7) fail("templates");
  // create_page (template, workspace folder) and a sub-page
  const cp = await ok(ada, "create_page", { title: "MCP every block", workspace: S.ws, folder: S.folder, template: "prd" });
  st.slug = cp.data.slug;
  log("create_page →", cp.data.url, cp.data.workspace_url);
  const sub = await ok(ada, "create_page", { title: "MCP child", parent: st.slug, content: "## Child\n\nHello.\n" });
  st.child = sub.data.slug;
  await refused(cy, "create_page", { title: "x", parent: st.slug });
  await refused(adaRead, "create_page", { title: "x" });
  // get_page
  let g = await ok(ada, "get_page", { document: st.slug });
  if (g.data.editor !== "blocks" || !g.data.children?.length) fail(`get_page: ${JSON.stringify(g.data).slice(0, 300)}`);
  // update_page with every block
  const up = await ok(ada, "update_page", { document: st.slug, markdown: ALL, base_rev: g.data.rev });
  log("update_page", up.text.slice(0, 100));
  g = await ok(ada, "get_page", { document: st.slug });
  if (g.data.markdown !== ALL) fail(`get_page markdown differs from what update_page wrote\n${g.data.markdown}`);
  const states = Object.fromEntries((g.data.embeds || []).map((e) => [e.slug, e.state]));
  log("get_page embeds", JSON.stringify(states));
  // A stranger's MCP read: locked items have no title or label.
  await api("PUT", `/api/v1/documents/${st.slug}/access/level`, T.owner, { level: "link" });
  const gc = await ok(cy, "get_page", { document: st.slug });
  for (const t of ["Launch plan", "Q3 report", "Pricing calculator"]) if (JSON.stringify(gc.data).includes(t)) fail(`stranger's get_page names ${t}`);
  // stale base_rev
  await refused(ada, "update_page", { document: st.slug, markdown: "x", base_rev: 1 }, /rev|changed|newer|stale/i);
  // append_blocks
  await ok(ada, "append_blocks", { document: st.slug, markdown: "## Appended\n\nBy the MCP test." });
  // replace_section
  await ok(ada, "replace_section", { document: st.slug, heading: "Appended", markdown: "## Appended\n\nReplaced by replace_section." });
  await refused(ada, "replace_section", { document: st.slug, heading: "No such heading", markdown: "x" }, /heading|section|not/i);
  // insert_embed (as embed after a heading, and as a link at the end)
  await ok(ada, "insert_embed", { document: st.slug, item: "team-photo", as: "embed", after_heading: "Text" });
  await ok(ada, "insert_embed", { document: st.slug, item: "launch-plan", as: "link" });
  await refused(cy, "insert_embed", { document: st.slug, item: "launch-plan", as: "embed" });
  // upload_page_image
  const png = Buffer.from(await pngBytes(browser, "MCP image", ["#16a34a", "#0ea5e9"])).toString("base64");
  const img = await ok(ada, "upload_page_image", { document: st.slug, filename: "mcp.png", content_base64: png });
  log("upload_page_image", JSON.stringify(img.data).slice(0, 160));
  await ok(ada, "append_blocks", { document: st.slug, markdown: img.data.markdown });
  // set_page_properties
  await ok(ada, "set_page_properties", { document: st.slug, properties: { full_width: true, font: "serif" } });
  // list_subpages
  const ls = await ok(ada, "list_subpages", { document: st.slug });
  if (!JSON.stringify(ls.data).includes(st.child)) fail("list_subpages lacks the child");
  // move_page: the child to top level (readers change: needs confirm), then back
  const mv = await mcp(ada, "move_page", { document: st.child, parent: null });
  log("move_page w/o confirm:", mv.isError, mv.text.slice(0, 140));
  await ok(ada, "move_page", { document: st.child, parent: null, confirm_access_change: true });
  await ok(ada, "move_page", { document: st.child, parent: st.slug, confirm_access_change: true });
  // The edit lock: update refused (423), append allowed.
  const lock = await api("POST", `/api/v1/documents/${st.slug}/lock`, T.member);
  if (lock.status !== 200) fail(`lock → ${lock.status}`);
  const cur = await ok(ada, "get_page", { document: st.slug });
  await refused(ada, "update_page", { document: st.slug, markdown: cur.data.markdown + "\nx\n", base_rev: cur.data.rev }, /editing/i);
  await ok(ada, "append_blocks", { document: st.slug, markdown: "Appended while Ben edits." });
  await api("DELETE", `/api/v1/documents/${st.slug}/lock`, T.member);
  fs.writeFileSync(path.join(SHOTS, "mcp-page.md"), (await docOf(st.slug, T.owner)).content);
});

await step("roundtrip", async () => {
  const before = (await docOf(st.slug, T.owner)).content;
  const { c, p } = await ctx(browser, { token: T.owner });
  const puts = [];
  p.on("request", (r) => { if (r.method() === "PUT" && r.url().includes(`/documents/${st.slug}`)) puts.push(r.postData()); });
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|Vercel/.test(m.text())) log("[console]", m.text().slice(0, 200)); });
  await p.goto(`${APP}/${st.slug}?edit=1`, { waitUntil: "networkidle" });
  await p.locator('.ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
  await p.waitForTimeout(5000);
  await shot(p, "50-mcp-every-block-editor", { full: true, wait: 1500 });
  if (puts.length) fail(`opening the editor saved without an edit (${puts.length} PUT)`);
  // Ask the editor for its Markdown: unchanged.
  // A small edit at the very end; everything else must stay byte-identical.
  await p.locator(".ProseMirror").getByText("Appended while Ben edits.").click();
  await p.waitForTimeout(250);
  await p.keyboard.press("End");
  await p.keyboard.type(" Edited.");
  await waitSaved(p);
  await p.waitForTimeout(1000);
  const after = (await docOf(st.slug, T.owner)).content;
  const expect = before.replace("Appended while Ben edits.", "Appended while Ben edits. Edited.");
  if (after !== expect) {
    fs.writeFileSync(path.join(SHOTS, "mcp-before.md"), before);
    fs.writeFileSync(path.join(SHOTS, "mcp-after.md"), after);
    fail("the editor changed more than the edit (see mcp-before.md / mcp-after.md)");
  }
  await p.getByRole("button", { name: "Done" }).click();
  await p.locator(".pb-page").waitFor();
  await c.close();
  // The reader renders every block.
  const m = await ctx(browser, { token: T.member });
  await m.p.goto(`${APP}/${st.slug}`, { waitUntil: "networkidle" });
  await m.p.waitForTimeout(4000);
  const checks = {
    table: ".pb-page table", code: ".pb-page pre code", mermaid: ".pb-page svg", katex: ".pb-page .katex", details: ".pb-page details",
    callout: ".pb-page .pb-callout", checkbox: ".pb-page input[type=checkbox]", embedImg: ".pb-embed__img", frame: ".pb-page iframe",
    card: ".pb-card, .pb-embed--card", mention: ".pb-mention", toc: ".pb-toc, nav.pb-toc", bookmark: ".pb-bookmark", web: ".pb-webembed iframe",
    person: ".pb-mention--person", date: ".pb-mention--date", kbd: ".pb-page kbd", quote: ".pb-page blockquote", img: ".pb-page figure img, .pb-page img",
  };
  const missing = [];
  for (const [k, sel] of Object.entries(checks)) if (!(await m.p.locator(sel).count())) missing.push(k);
  await shot(m.p, "51-mcp-every-block-view", { full: true, wait: 2000 });
  if (missing.length) fail(`the reader lacks: ${missing.join(", ")}`);
  await m.c.close();
});

await browser.close();
console.log("\nResults (MCP):");
for (const [n, r] of results) console.log(`  ${r === "ok" ? "✓" : "✗"} ${n}: ${r}`);
process.exit(results.some(([, r]) => r !== "ok") ? 1 : 0);
