/**
 * Simpler workspaces UI, against a live local stack (the real API, not the mock).
 *
 * Regression guards for what the live click-through found:
 *  - dropping files on a folder card or a rail folder left the page-wide "Drop to add to …"
 *    overlay stuck on screen (the folder's handler stops the drop, and no dragleave follows a drop);
 *  - a workspace created in the app was missing from the rail until a reload, and its
 *    "Get set up" checklist never ticked "Invite your team" (the counts it read were always 0).
 *
 * Needs E2E_FIXTURES (users.owner) and E2E_AUTH_SECRET, like the other signed-in smoke tests.
 */
import { expect, test, type Page } from "@playwright/test";
import { API_URL, fixtureUsers, mintAccessToken, uniq } from "./support/stack";
import { settle, signIn, visit } from "./support/ui";

const users = fixtureUsers();
test.skip(!users, "needs seeded users: set E2E_FIXTURES to the sandbox fixtures.json (users.owner, users.other)");

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/** What a desktop drag does to the element under the pointer: enter, over, then drop (no leave). */
async function dropMarkdownOn(page: Page, selector: ReturnType<Page["locator"]>, name: string) {
  await selector.evaluate(async (el, n) => {
    const dt = new DataTransfer();
    dt.items.add(new File([`# ${n}\n\nDropped in a test.`], `${n}.md`, { type: "text/markdown" }));
    for (const type of ["dragenter", "dragover"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, name);
}

test("a drop on a folder card or a rail folder files it there and clears the page-wide overlay", async ({ page, context }) => {
  const token = mintAccessToken(users!.owner);
  const ws = await api<{ id: string }>(token, "/api/v1/workspaces", { method: "POST", body: JSON.stringify({ name: uniq("Drop") }) });
  const folder = await api<{ id: string }>(token, `/api/v1/workspaces/${ws.id}/folders`, { method: "POST", body: JSON.stringify({ name: "Specs" }) });
  await signIn(context, token);
  await visit(page, `/w/${ws.id}`);
  await settle(page);

  const overlay = page.getByText(/^Drop to add to /);
  const card = page.getByRole("main").getByText("Specs", { exact: true }).first();
  await expect(card).toBeVisible();
  await dropMarkdownOn(page, card, "card-drop");
  await expect(page.getByText(/file added to Specs/)).toBeVisible();
  await expect(overlay).toBeHidden();

  const railFolder = page.getByRole("treeitem", { name: /Specs/ }).first();
  await expect(railFolder).toBeVisible();
  await dropMarkdownOn(page, railFolder, "rail-drop");
  await expect(overlay).toBeHidden();
  await expect.poll(async () => {
    const r = await api<{ items: { folder?: { id: string } | null }[] }>(token, `/api/v1/workspaces/${ws.id}/items?folder=${folder.id}`);
    return r.items.length;
  }).toBe(2);
});

test("a new workspace shows in the rail at once and its checklist ticks the invite", async ({ page, context }) => {
  const token = mintAccessToken(users!.owner);
  await signIn(context, token);
  const name = uniq("Team");
  await visit(page, "/settings/workspaces");
  await settle(page);
  await page.getByRole("main").getByRole("button", { name: /New workspace/ }).first().click();
  await page.getByRole("dialog").getByRole("textbox").first().fill(name);
  await page.getByRole("dialog").getByRole("button", { name: /Create/ }).click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f]{24}/);
  // The rail lists it without a reload.
  await expect(page.getByRole("treeitem", { name: new RegExp(name) }).first()).toBeVisible();
  await expect(page.getByText("1 of 4 done")).toBeVisible();

  // Invite someone from the checklist: "Invite your team" is done straight away.
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Email addresses").fill(`${uniq("invitee")}@example.com`);
  await dlg.getByRole("button", { name: /^Invite/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText("2 of 4 done")).toBeVisible();
});
