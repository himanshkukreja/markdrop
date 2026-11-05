/**
 * Docs media, group G: Pages (/pages/*) and Ask Markdrop on a page. Shot format: ../shots.mjs.
 *
 * The demo world has no pages, so each shot makes the page it needs in Acme › Guides (shots/_demo.mjs).
 * Riya owns Acme; Alex is a member, Maya an admin. The AI shots need the sandbox API started through
 * e2e/pages/real/api_run.py with PB_FAKE_ASK_AI=1 PB_FAKE_PAGES_AI=1 PB_FAKE_MEETINGS_AI=1.
 */
import { api, demoPage, meeting, ok } from "./_demo.mjs";

const RELEASE = `Everything that has to happen before 2.5 goes out, and who does it.

## Before the release

- [x] Freeze the branch on Monday
- [ ] Dry run of the migration on staging
- [ ] Update the onboarding guide with the new screenshots
- [ ] Tell Globex before the release

## Release day

Ship in the morning, India time, so support has the whole day. Riya posts the release notes and Alex watches the error rate for the first two hours.

## After the release

Write down what went wrong in the retro, and move anything unfinished to the 2.6 plan.
`;

const ONBOARDING = `What a new teammate does in their first week, and who helps.

## Day one

Get your laptop, your accounts and a buddy. Your buddy books a 30-minute tour of the product with you.

## First week

Ship one small change, sit in on two customer calls, and read the release notes from the last three versions.
`;

/** The Release checklist page (each shot makes its own: capture.mjs cleans up before every shot). */
const releasePage = (h) => demoPage(h, { title: "Release checklist 2.5", content: RELEASE });

/** View mode: wait for the page and its bar, nothing hovered. */
async function openView(h, slug) {
  await h.goto(`/${slug}`);
  await h.loc("[data-page-mode='edit']").waitFor({ timeout: 30000 });
  await h.settle(500);
  await h.page.mouse.move(5, 895);
}

/** Edit mode (clicks Edit until the editor is live, like e2e lib editPage). */
async function openEdit(h, slug) {
  await openView(h, slug);
  const live = h.page.locator(".pb-live .ProseMirror");
  for (let i = 0; i < 40 && !(await live.count()); i++) {
    const busy = await h.page.locator("[data-page-mode='edit']").first().getAttribute("aria-busy").catch(() => null);
    if (busy !== "true") await h.page.locator("[data-page-mode='edit']").first().click({ timeout: 2000 }).catch(() => {});
    await h.sleep(300);
  }
  await live.first().waitFor({ timeout: 30000 });
  await h.settle(600);
}

/** The bar and the top of the page (title and first lines). */
const topOfPage = async (h, height = 380) => {
  const bar = await h.page.locator(".pb-barwrap").first().boundingBox();
  return { box: { x: 0, y: bar ? bar.y : 0, width: 1440, height } };
};

async function caretAtEndOf(h, text) {
  const para = h.page.locator(".pb-live .ProseMirror").getByText(text, { exact: false }).first();
  await para.click();
  await h.page.keyboard.press("End");
}

export default [
  // ── View mode and Edit ──────────────────────────────────────────────────────
  {
    id: "pages-view-mode",
    page: "/pages/overview",
    name: "view-mode",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => openView(h, await releasePage(h)),
    crop: (h) => topOfPage(h, 420),
  },
  {
    id: "pages-edit-mode",
    page: "/pages/overview",
    name: "edit-mode",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      await openEdit(h, slug);
      await caretAtEndOf(h, "Tell Globex before the release");
      await h.page.keyboard.type(" (Sam)");
      await h.page.locator(".pb-save").filter({ hasText: "Saved" }).first().waitFor({ timeout: 20000 }).catch(() => {});
      await h.settle(800);
      await h.page.mouse.move(5, 895);
    },
    crop: (h) => topOfPage(h, 420),
  },

  // ── Editing together: someone else is editing (Edit anyway) ────────────────
  {
    id: "pages-edit-anyway",
    page: "/pages/editing-together",
    name: "edit-anyway",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      // Alex is editing in his own browser: he opened Edit and typed (his editor holds the page).
      const { token } = await h.sandbox("/__sandbox/mint", { email: h.fx.users.alex.email });
      const c2 = await h.page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
      await c2.addInitScript((t) => { try { localStorage.setItem("markdrop_token", t); localStorage.setItem("md_consent", "denied"); } catch {} }, token);
      const p2 = await c2.newPage();
      await p2.goto(`${h.APP}/${slug}?edit=1`, { waitUntil: "domcontentloaded" });
      await p2.locator(".pb-live .ProseMirror[contenteditable='true']").first().waitFor({ timeout: 40000 });
      await p2.locator(".pb-live .ProseMirror").getByText("Tell Globex before the release").first().click();
      await p2.keyboard.press("End");
      await p2.keyboard.type(" (Sam, by Thursday)");
      for (let i = 0; i < 40; i++) {
        const st = await api(h, "GET", `/api/v1/documents/${slug}/lock`, undefined, "riya");
        if (st.body?.holder) break;
        await h.sleep(500);
      }
      h.page.once("close", () => c2.close().catch(() => {}));
      await openView(h, slug);
      await h.page.locator("[data-page-mode='edit']").first().click();
      await h.loc({ role: "button", name: "Edit anyway" }).waitFor({ timeout: 30000 });
      await h.settle(600);
      await h.page.mouse.move(5, 895);
    },
    crop: async (h) => {
      const bar = await h.page.locator(".pb-barwrap").first().boundingBox();
      const banner = await h.page.locator(".pb-banner").filter({ hasText: "is editing" }).first().boundingBox();
      const top = Math.min(bar?.y ?? banner.y, banner.y);
      return { box: { x: 0, y: top, width: 1440, height: Math.max(banner.y + banner.height + 160 - top, 300) } };
    },
  },
  {
    id: "pages-keep-both",
    page: "/pages/working-together",
    name: "keep-both",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      await openEdit(h, slug);
      // Riya changes a line; her lock is then let go (as if her laptop slept) and Alex changes the same line.
      await caretAtEndOf(h, "Ship in the morning");
      await h.page.keyboard.type(" Support is told the day before.");
      await h.page.locator(".pb-save").filter({ hasText: "Saved" }).first().waitFor({ timeout: 20000 }).catch(() => {});
      await h.sleep(1500);
      await h.page.context().setOffline(true);
      await caretAtEndOf(h, "Support is told the day before.");
      await h.page.keyboard.type(" Maya writes the status page note.");
      await h.sleep(800);
      await api(h, "DELETE", `/api/v1/documents/${slug}/lock`, undefined, "riya");
      const d = await ok(h, "GET", `/api/v1/documents/${slug}`, undefined, "alex");
      await ok(h, "POST", `/api/v1/documents/${slug}/lock?intent=edit`, undefined, "alex");
      const theirs = d.content.replace(/Ship in the morning[^\n]*/, "Ship in the afternoon, after the standup, so the US team is online. Alex watches the error rate.");
      await ok(h, "PUT", `/api/v1/documents/${slug}`, { title: d.title, content: theirs, base_rev: d.rev }, "alex");
      await api(h, "DELETE", `/api/v1/documents/${slug}/lock`, undefined, "alex");
      await h.page.context().setOffline(false);
      await h.page.keyboard.type(" ");
      await h.page.locator(".pb-banner[data-tone='warn']").filter({ hasText: "same part" }).first().waitFor({ timeout: 45000 });
      await h.settle(600);
      await h.page.mouse.move(5, 895);
    },
    crop: async (h) => {
      const banner = await h.page.locator(".pb-banner[data-tone='warn']").first().boundingBox();
      const bar = await h.page.locator(".pb-barwrap").first().boundingBox();
      const top = Math.min(bar?.y ?? banner.y, banner.y);
      return { box: { x: 0, y: top, width: 1440, height: banner.y + banner.height + 420 - top } };
    },
  },

  // ── Ask Markdrop on a page (⌘J): scopes, an answer, Insert ──────────────────
  {
    id: "assistant-page",
    page: "/workspaces/ask-markdrop",
    name: "assistant-page",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      await openView(h, slug);
      await h.page.keyboard.press("Meta+j");
      const box = h.page.getByTestId("assistant");
      await box.waitFor({ timeout: 20000 });
      await box.getByTestId("assistant-scopes").waitFor({ timeout: 20000 });
      await box.getByTestId("chat-new").click({ timeout: 3000 }).catch(() => {});
      await box.locator("textarea").fill("What's still open before the release?");
      await box.locator("textarea").press("Enter");
      await box.getByTestId("chat-followups").waitFor({ timeout: 30000 }).catch(() => {});
      await box.locator(".ch-tool--label", { hasText: "Insert" }).first().waitFor({ timeout: 30000 });
      await h.settle(600);
      await h.page.mouse.move(5, 895);
    },
    crop: { selector: "[data-testid='assistant']", pad: 0 },
  },
  {
    id: "assistant-scopes",
    page: "/workspaces/ask-markdrop",
    name: "assistant-scopes",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      await openView(h, slug);
      await h.page.keyboard.press("Meta+j");
      const box = h.page.getByTestId("assistant");
      await box.waitFor({ timeout: 20000 });
      await box.getByTestId("chat-new").click({ timeout: 3000 }).catch(() => {});
      await box.getByTestId("assistant-scopes").waitFor({ timeout: 20000 });
      await box.getByTestId("chat-starters").waitFor({ timeout: 20000 }).catch(() => {});
      await h.settle(500);
      await h.page.mouse.move(5, 895);
    },
    crop: { selector: "[data-testid='assistant']", pad: 0 },
  },
  {
    id: "assistant-clip",
    page: "/workspaces/ask-markdrop",
    name: "assistant",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      await openView(h, slug);
      await h.page.mouse.move(900, 500);
    },
    steps: async (h) => {
      await h.sleep(300);
      await h.page.keyboard.press("Meta+j");
      const box = h.page.getByTestId("assistant");
      await box.waitFor({ timeout: 20000 });
      await box.getByTestId("chat-new").click({ timeout: 2000 }).catch(() => {});
      await h.sleep(300);
      await h.type(box.locator("textarea"), "What's still open before the release?", { speed: 2 });
      await h.press("Enter");
      await box.locator(".ch-tool--label", { hasText: "Insert" }).first().waitFor({ timeout: 30000 });
      await h.sleep(600);
      await h.click(box.locator(".ch-tool--label", { hasText: "Insert" }).first());
      await h.page.locator(".pb-live .ProseMirror").first().waitFor({ timeout: 30000 });
      await h.sleep(1500);
    },
  },

  // ── Sub-page templates ──────────────────────────────────────────────────────
  {
    id: "pages-subpage-gallery",
    page: "/pages/sub-pages",
    name: "subpage-gallery",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      await h.goto(`/pages/new?parent=${slug}`);
      await h.loc(".pb-tg").waitFor({ timeout: 30000 });
      await h.loc(".pb-template").first().waitFor({ timeout: 20000 });
      await h.settle(700);
      await h.page.mouse.move(5, 895);
    },
    crop: { selector: ".pb-tg", pad: 0 },
  },

  // ── @ mentions ──────────────────────────────────────────────────────────────
  {
    id: "pages-mention",
    page: "/pages/mentions-and-notifications",
    name: "mention",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      await openEdit(h, slug);
      await caretAtEndOf(h, "Write down what went wrong");
      await h.page.keyboard.press("Enter");
      await h.page.keyboard.type("Retro owner: @");
      await h.loc("[role=listbox][aria-label='Mention someone']").waitFor({ timeout: 15000 });
      await h.settle(500);
    },
    crop: async (h) => {
      const list = await h.page.locator("[role=listbox][aria-label='Mention someone']").boundingBox();
      const line = await h.page.locator(".pb-live .ProseMirror").getByText("Retro owner:").first().boundingBox();
      const x = Math.min(list.x, line.x) - 60, y = line.y - 120;
      return { box: { x, y, width: Math.max(list.x + list.width, line.x + line.width) - x + 80, height: list.y + list.height + 30 - y } };
    },
  },

  // ── Page AI (the writing tools) ─────────────────────────────────────────────
  {
    id: "pages-ai-menu",
    page: "/pages/ai",
    name: "ai-menu",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      const slug = await releasePage(h);
      await openEdit(h, slug);
      const para = h.page.locator(".pb-live .ProseMirror p").filter({ hasText: "Ship in the morning" }).first();
      await para.click({ clickCount: 3 });
      await h.sleep(500);
      await h.page.locator(".dxe-tb__btn--ai").first().click({ timeout: 10000 });
      await h.loc("[role=menu][aria-label='Ask AI']").waitFor({ timeout: 10000 });
      await h.settle(500);
    },
    crop: async (h) => {
      const menu = await h.page.locator("[role=menu][aria-label='Ask AI']").boundingBox();
      const para = await h.page.locator(".pb-live .ProseMirror p").filter({ hasText: "Ship in the morning" }).first().boundingBox();
      const x = Math.min(menu.x, para.x) - 40, y = Math.min(menu.y, para.y) - 70;
      const right = Math.max(menu.x + menu.width, para.x + para.width) + 40;
      return { box: { x, y, width: right - x, height: Math.max(menu.y + menu.height, para.y + para.height) + 30 - y } };
    },
  },

  // ── Meeting memory: From meetings in View mode (the bar's button) ───────────
  {
    id: "pages-meeting-memory",
    page: "/pages/meeting-memory",
    name: "from-meetings",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    prepare: async (h) => {
      await meeting(h);
      const slug = await demoPage(h, { title: "Onboarding guide refresh", content: ONBOARDING });
      await openView(h, slug);
      await h.loc("[data-testid='mm-bar']").waitFor({ timeout: 40000 });
      await h.page.locator("[data-testid='mm-bar']").first().click();
      await h.loc(".mm[data-open] .mm__panel").waitFor({ timeout: 20000 });
      await h.loc(".mm-fact").first().waitFor({ timeout: 20000 });
      await h.settle(700);
      await h.page.mouse.move(5, 895);
    },
    // The right of the bar (From meetings, Edit) and the panel under it.
    crop: async (h) => {
      const bar = await h.page.locator(".pb-barwrap").first().boundingBox();
      const panel = await h.page.locator(".mm[data-open] .mm__panel").boundingBox();
      const x = Math.max(0, panel.x - 340);
      return { box: { x, y: bar ? bar.y : 0, width: 1440 - x, height: panel.y + panel.height + 16 - (bar ? bar.y : 0) } };
    },
  },
];
