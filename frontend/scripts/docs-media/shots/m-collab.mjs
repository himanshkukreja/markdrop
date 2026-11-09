/**
 * Docs media, group M: Collaboration (/collaboration/*): comments, suggested edits and AI help,
 * notifications, assign and sign-off, Jira in pages, insights and exports, settings. Shot format: ../shots.mjs.
 *
 * Not the demo world of seed.py: the real-stack e2e world plus collab-docs-setup.mjs (Riya Sharma, Alex Chen,
 * Sam Lee and Maya Patel at Acme; "Checkout redesign: launch plan" and "Pricing page refresh" with their
 * threads; the fake Jira connected for Riya and Alex). Start the stack with the fakes:
 *
 *   PB_DOCS_WORLD=1 PB_FAKE_COMMENTS_AI=1 PB_FAKE_JIRA=1 PB_STACK_ID=45 PB_WORK=… zsh e2e/pages/real/up.sh start
 *   (cd e2e/pages/real; PB_STACK_ID=45 PB_WORK=… node collab-docs-setup.mjs)
 *   STACK_ID=45 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- <collab-… ids>
 *
 * Markdrop's own screens only: no Atlassian logo, colours or interface (Jira shows as Markdrop's chips,
 * cards and lists). Shots that change something make their own page (capture.mjs deletes it next shot).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, ok } from "./_demo.mjs";

const PY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../backend/.venv/bin/python");
/** Notifications about pages earlier shots made (and capture.mjs deleted) leave the bell. */
function dropOrphanNotes() {
  const db = Number(process.env.STACK_ID || 0) ? `markdrop_docs_demo_${process.env.STACK_ID}` : "markdrop_docs_demo";
  execFileSync(PY, ["-c", `import pymongo
from bson import ObjectId
c = pymongo.MongoClient("mongodb://127.0.0.1:27019")["${db}"]
live = {str(d["_id"]) for d in c["documents"].find({}, {"_id": 1})}
r = c["notifications"].delete_many({"doc_id": {"$nin": list(live)}})
c["comment_threads"].delete_many({"doc_id": {"$nin": list(live)}})`]);
}

const OVERVIEW = "/collaboration/overview";
const COMMENTS = "/collaboration/comments";
const SUGGEST = "/collaboration/suggested-edits";
const NOTIFY = "/collaboration/notifications";
const ASSIGN = "/collaboration/assign-and-sign-off";
const JIRA = "/collaboration/jira-in-pages";
const INSIGHTS = "/collaboration/insights-and-exports";
const SETTINGS = "/collaboration/settings-and-privacy";

const WIDE = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844 };
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const plan = (fx) => `/${fx.collab.plan}`;
const pricing = (fx) => `/${fx.collab.pricing}`;
const panel = (h) => h.page.locator("aside.mdc-panel");
const card = (h, tid) => h.page.locator(`article.mdc-thread[data-thread-id="${tid}"]`).first();
const C = (slug) => `/api/v1/documents/${slug}/comments`;
/** Between a shot's prepare, steps and after (capture.mjs hands each a fresh copy of the shot). */
const S = {};

/** A short launch plan, made fresh for a shot that changes it (not kept: no demo_seed). */
const LAUNCH = `We launch the new checkout on Tuesday 18 November, once QA signs off on the payment flows. The old checkout stays available as a fallback for one week.

## Rollout

Rollout happens in three waves: our own team first, then 10% of customers, then everyone. Each wave runs for two days before the next one starts.

- Card retries ship before the first wave
- The refund flow for annual plans follows in the second wave

## Support

Support gets the new help article two days before the first wave, with screenshots of every step.
`;

async function freshPage(h, { title = "Checkout launch plan", content = LAUNCH, who = "riya" } = {}) {
  const r = await ok(h, "POST", "/api/v1/pages", { title, content, workspace: h.fx.workspace.id, folder: h.fx.workspace.folder, auto_cover: false }, who);
  return r.document.slug;
}

async function thread(h, slug, who, anchor, body, extra = {}) {
  const r = await ok(h, "POST", C(slug), { anchor, body, ...extra }, who);
  return (r.thread || r).id;
}
const text = (exact) => ({ type: "text", quote: { exact } });

/** Opens a page and waits for its body and (when it opens by itself, or `open`) the comments panel. */
async function view(h, slug, { open = true } = {}) {
  await h.goto(`/${slug}`);
  await h.loc(".pb-paper").waitFor({ timeout: 30000 });
  await h.settle(900);
  if (open && !(await panel(h).count())) {
    await h.page.locator(".mdc-topbtn").first().click();
    await panel(h).waitFor({ timeout: 10000 });
  }
  await h.settle(500);
}

/** Selects `t` in the page's rendered body and fires selectionchange (the "Comment" button follows it). */
async function selectText(h, t) {
  await h.page.evaluate((s) => {
    const root = document.querySelector(".pb-paper");
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(s);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + s.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
    }
    throw new Error("text not found: " + s);
  }, t);
  await h.sleep(300);
}

/** Drags the fake cursor across `t` like a person selecting it, then selects it for real. */
async function dragSelect(h, t) {
  const box = await h.page.evaluate((s) => {
    const root = document.querySelector(".pb-paper");
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = n.data.indexOf(s);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + s.length);
        const rs = [...r.getClientRects()];
        return { x1: rs[0].left + 1, y1: rs[0].top + rs[0].height / 2, x2: rs[rs.length - 1].right - 1, y2: rs[rs.length - 1].top + rs[rs.length - 1].height / 2 };
      }
    }
    return null;
  }, t);
  if (!box) throw new Error("text not found: " + t);
  await h.move([box.x1, box.y1]);
  await h.page.mouse.down();
  await h.move([box.x2, box.y2], { duration: 900 });
  await h.page.mouse.up();
  await selectText(h, t);
}

const still = async (h) => {
  await h.settle(600);
  await h.page.mouse.move(5, 5);
};

export default [
  // ── Overview: the hero ──────────────────────────────────────────────────────
  {
    id: "collab-hero",
    page: OVERVIEW,
    name: "hero",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await view(h, h.fx.collab.plan);
      await still(h);
    },
    crop: { box: { x: 264, y: 0, width: 1336, height: 760 } },
  },

  // ── Comments ───────────────────────────────────────────────────────────────
  {
    id: "collab-thread",
    page: COMMENTS,
    name: "thread",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await view(h, h.fx.collab.plan);
      await still(h);
    },
    crop: (h) => ({ selector: `article.mdc-thread[data-thread-id="${h.fx.collab.threads.signoff}"]`, pad: 10 }),
  },
  {
    id: "collab-comment-flow",
    page: COMMENTS,
    name: "comment-flow",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      S.slug = await freshPage(h);
      await view(h, S.slug, { open: false });
      await h.page.mouse.move(700, 500);
    },
    steps: async (h) => {
      await h.sleep(300);
      await dragSelect(h, "two days before the next one starts");
      await h.click(".mdc-selbtn");
      const box = panel(h).locator(".mdc-draft textarea");
      await box.waitFor({ timeout: 8000 });
      await h.type(null, "Is two days enough? @Ale", { speed: 2.4 });
      await h.page.locator(".mdc-mentions [role=option]").first().waitFor({ timeout: 8000 });
      await h.sleep(250);
      await h.press("Enter", 250);
      await h.click(panel(h).locator(".mdc-draft button:has-text('Comment')"));
      const t = panel(h).locator("article.mdc-thread[data-thread-id]").first();
      await t.waitFor({ timeout: 8000 });
      const tid = await t.getAttribute("data-thread-id");
      await h.sleep(500);
      // Alex answers from his own browser: it shows up here without a reload (the wait is cut).
      await h.cut(async () => {
        await ok(h, "POST", `${C(S.slug)}/${tid}/replies`, { body: "Yes, the second wave is only 10% of customers." }, "member");
        await t.locator(".mdc-msg").nth(1).waitFor({ timeout: 15000 });
        await h.sleep(300);
      });
      await h.sleep(1000);
      await h.click(t.locator("button[aria-label='Resolve']"));
      await h.sleep(700);
    },
  },
  {
    id: "collab-live",
    page: COMMENTS,
    name: "live",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      S.slug = await freshPage(h);
      // Alex has the page open in his own browser (his avatar shows in Riya's top bar).
      const tok = (await h.sandbox("/__sandbox/mint", { email: h.fx.users.member.email })).token;
      const other = await h.page.context().browser().newContext({ viewport: { width: 1280, height: 800 } });
      await other.addInitScript((t) => { localStorage.setItem("markdrop_token", t); localStorage.setItem("md_consent", "denied"); }, tok);
      await other.route("**/*", (route) => {
        const u = new URL(route.request().url());
        return ["localhost", "127.0.0.1"].includes(u.hostname) ? route.continue() : route.abort();
      });
      const p2 = await other.newPage();
      await p2.goto(`${h.APP}/${S.slug}`, { waitUntil: "domcontentloaded" });
      S.other = other;
      await view(h, S.slug, { open: false });
      await h.sleep(2500);
      await h.page.mouse.move(900, 600);
    },
    steps: async (h) => {
      await h.sleep(500);
      const tid = await thread(h, S.slug, "member", text("three waves"), "Could we do this in two waves? The change is small.");
      await h.page.locator(".mdc-topbtn__n").waitFor({ timeout: 15000 });
      await h.sleep(600);
      await h.click(".mdc-topbtn");
      const t = card(h, tid);
      await t.waitFor({ timeout: 10000 });
      await h.sleep(500);
      await h.click(t.locator(".mdc-replybtn"));
      await h.type(null, "Fine by me, if support is ready.", { speed: 2.4 });
      await h.click(t.getByRole("button", { name: "Reply", exact: true }).last());
      await h.sleep(300);
      await h.cut(async () => {
        await ok(h, "POST", `${C(S.slug)}/${tid}/replies`, { body: "They are. I'll update the plan." }, "member");
        await t.locator(".mdc-msg").nth(2).waitFor({ timeout: 15000 });
      });
      await h.sleep(1200);
    },
    after: async (h) => {
      if (S.other) await S.other.close().catch(() => {});
    },
  },
  {
    id: "collab-phone-sheet",
    page: COMMENTS,
    name: "phone-sheet",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: PHONE,
    userAgent: PHONE_UA,
    prepare: async (h) => {
      await h.goto(plan(h.fx));
      await h.loc(".pb-paper").waitFor({ timeout: 30000 });
      await h.settle(900);
      await h.page.locator(".mdc-floatbtn, .mdc-topbtn").first().click();
      await panel(h).waitFor({ timeout: 10000 });
      await still(h);
    },
    crop: "viewport",
  },
  {
    id: "collab-phone-sheet-clip",
    page: COMMENTS,
    name: "phone-sheet-clip",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: PHONE,
    userAgent: PHONE_UA,
    out: 780,
    tail: 400,
    prepare: async (h) => {
      await h.goto(plan(h.fx));
      await h.loc(".pb-paper").waitFor({ timeout: 30000 });
      await h.settle(900);
      await h.page.mouse.move(200, 500);
    },
    steps: async (h) => {
      await h.sleep(500);
      await h.click(h.page.locator(".mdc-floatbtn, .mdc-topbtn").first());
      await panel(h).waitFor({ timeout: 10000 });
      await h.sleep(900);
      const t = card(h, h.fx.collab.threads.waves);
      await t.scrollIntoViewIfNeeded().catch(() => {});
      await h.click(t, { after: 900 });
      await h.sleep(600);
    },
  },

  // ── Suggested edits and AI help ─────────────────────────────────────────────
  {
    id: "collab-suggestion",
    page: SUGGEST,
    name: "suggestion",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await view(h, h.fx.collab.plan);
      await card(h, h.fx.collab.threads.waves).scrollIntoViewIfNeeded();
      await still(h);
    },
    keepScroll: true,
    crop: (h) => ({ selector: `article.mdc-thread[data-thread-id="${h.fx.collab.threads.waves}"]`, pad: 10 }),
  },
  {
    id: "collab-suggest-accept",
    page: SUGGEST,
    name: "suggest-accept",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      S.slug = await freshPage(h);
      S.tid = await thread(h, S.slug, "admin", text("three waves: our own team first, then 10% of customers, then everyone"),
        "Two waves is enough for a change this size.", { suggestion: "two waves: our own team first, then everyone" });
      await view(h, S.slug);
      await card(h, S.tid).click({ position: { x: 120, y: 20 } }).catch(() => {});
      await h.settle(600);
      await h.page.mouse.move(600, 500);
    },
    steps: async (h) => {
      await h.sleep(600);
      const c = card(h, S.tid).locator('[data-testid="suggestion-card"]');
      await h.hover(c.locator("ins").first(), 700);
      await h.click(c.getByRole("button", { name: "Accept" }));
      await h.page.locator(".pb-paper", { hasText: "two waves: our own team first, then everyone" }).waitFor({ timeout: 15000 });
      await h.move([420, 330]);
      await h.sleep(1500);
    },
  },
  {
    id: "collab-apply-ai",
    page: SUGGEST,
    name: "apply-ai",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      S.slug = await freshPage(h);
      S.tid = await thread(h, S.slug, "member", text("two days before the next one starts"),
        "Can we make this \"three days, so support can catch up\"? Two felt rushed last time.");
      await view(h, S.slug);
      await card(h, S.tid).click({ position: { x: 120, y: 20 } }).catch(() => {});
      await h.settle(600);
      await h.page.mouse.move(600, 500);
    },
    steps: async (h) => {
      await h.sleep(500);
      await h.click(card(h, S.tid).getByRole("button", { name: "Apply with AI" }));
      const ed = card(h, S.tid).locator('[data-testid="suggestion-editor"]');
      await ed.waitFor({ timeout: 15000 });
      await h.page.waitForFunction((tid) => {
        const t = document.querySelector(`article.mdc-thread[data-thread-id="${tid}"] [data-testid="suggestion-editor"] textarea`);
        return t && t.value.length > 5;
      }, S.tid, { timeout: 15000 });
      await h.sleep(1300);
      await h.click(ed.getByRole("button", { name: "Suggest" }));
      await card(h, S.tid).locator('[data-testid="suggestion-card"]').waitFor({ timeout: 15000 });
      await h.sleep(1500);
    },
  },
  {
    id: "collab-summary",
    page: SUGGEST,
    name: "summary",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await view(h, h.fx.collab.plan);
      await panel(h).getByRole("button", { name: "More" }).first().click();
      await h.page.getByRole("menuitem", { name: "Summarize discussion" }).click();
      await h.loc('[data-testid="discussion-summary"]').waitFor({ timeout: 20000 });
      await h.page.waitForFunction(() => /Launch moves/.test(document.querySelector('[data-testid="discussion-summary"]')?.textContent || ""), null, { timeout: 20000 });
      await still(h);
    },
    crop: { selector: '[data-testid="discussion-summary"]', pad: 12 },
  },
  {
    id: "collab-summarize-clip",
    page: SUGGEST,
    name: "summarize",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      await view(h, h.fx.collab.plan);
      await h.page.mouse.move(600, 500);
    },
    steps: async (h) => {
      await h.sleep(500);
      await h.click(panel(h).getByRole("button", { name: "More" }).first());
      await h.click(h.page.getByRole("menuitem", { name: "Summarize discussion" }));
      await h.page.waitForFunction(() => /Launch moves/.test(document.querySelector('[data-testid="discussion-summary"]')?.textContent || ""), null, { timeout: 20000 });
      await h.sleep(2600);
    },
  },
  {
    id: "collab-tone",
    page: SUGGEST,
    name: "tone-check",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      S.slug = await freshPage(h);
      S.tid = await thread(h, S.slug, "member", text("three waves"), "Do we really need three waves?");
      await view(h, S.slug);
      const t = card(h, S.tid);
      await t.click({ position: { x: 120, y: 20 } }).catch(() => {});
      const ta = t.locator(".mdc-composer textarea").first();
      if (!(await ta.isVisible().catch(() => false))) await t.locator(".mdc-replybtn").click();
      await t.locator(".mdc-composer textarea").first().fill("NO. This was agreed weeks ago!!!");
      await t.getByRole("button", { name: "Reply", exact: true }).last().click();
      await h.page.getByRole("dialog", { name: "Before you post" }).waitFor({ timeout: 20000 });
      await still(h);
    },
    crop: { selector: { role: "dialog", name: "Before you post" }, pad: 16 },
  },

  // ── Notifications ───────────────────────────────────────────────────────────
  {
    id: "collab-bell",
    page: NOTIFY,
    name: "bell",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 900 },
    prepare: async (h) => {
      dropOrphanNotes();
      await h.goto("/dashboard");
      await h.settle(800);
      const bell = h.page.locator('button[title="Notifications"]:visible, [data-testid="rail-inbox"]:visible').first();
      await bell.click();
      await h.page.getByRole("dialog", { name: "Notifications" }).or(h.page.locator('[aria-label="Notifications"][role="dialog"]')).first().waitFor({ timeout: 15000 });
      await h.settle(900);
      await h.page.mouse.move(5, 895);
    },
    crop: { selector: { css: '[role="dialog"][aria-label="Notifications"]' }, pad: 8 },
  },
  {
    id: "collab-email-settings",
    page: NOTIFY,
    name: "email-settings",
    kind: "screenshot",
    auth: "owner",
    url: "/settings/account",
    viewport: { width: 1440, height: 1100 },
    prepare: async (h) => {
      await h.loc("#email-comment-mentions").waitFor({ timeout: 30000 });
      await h.loc("#email-comment-mentions").scrollIntoViewIfNeeded();
      await still(h);
    },
    keepScroll: true,
    crop: async (h) => {
      const a = await h.page.locator("#email-comment-mentions-label").boundingBox();
      const sel = await h.page.locator("#email-comment-activity").boundingBox();
      const b = await h.page.getByText("Daily comments digest", { exact: true }).first().boundingBox();
      const x = a.x - 24;
      return { box: { x, y: a.y - 20, width: Math.min(1440 - x, sel.x + sel.width - x + 24), height: b.y + 70 - (a.y - 20) } };
    },
  },

  // ── Assign, Home and sign-off ───────────────────────────────────────────────
  {
    id: "collab-home-waiting",
    page: ASSIGN,
    name: "home",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 980, height: 1200 },
    prepare: async (h) => {
      dropOrphanNotes();
      await h.goto("/dashboard");
      await h.loc('[data-testid="home-comment-waiting"]').first().waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { union: ['[data-testid="home-today"]', '[data-testid="home-actions"]'], pad: 12 },
  },
  {
    id: "collab-assigned",
    page: ASSIGN,
    name: "assigned",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      await view(h, h.fx.collab.plan);
      await card(h, h.fx.collab.threads.runbook).scrollIntoViewIfNeeded();
      await still(h);
    },
    keepScroll: true,
    crop: (h) => ({ selector: `article.mdc-thread[data-thread-id="${h.fx.collab.threads.runbook}"]`, pad: 10 }),
  },
  {
    id: "collab-signoff-guard",
    page: ASSIGN,
    name: "signoff-guard",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 900 },
    prepare: async (h) => {
      const block = `:::signoff{#b-relgo1 person="${h.fx.users.riya.id}" label="Launch go-ahead" options="Approved|Not approved"}\nQA passed on all payment flows.\n:::`;
      S.slug = await freshPage(h, { title: "Checkout launch: go-ahead", content: `${LAUNCH}\n${block}\n` });
      await thread(h, S.slug, "member", text("three waves"), "Do we need three waves?");
      await thread(h, S.slug, "admin", text("help article"), "Who reviews the help article?");
      await view(h, S.slug, { open: false });
      const so = h.page.locator(".pb-signoff").first();
      await so.scrollIntoViewIfNeeded();
      await so.getByRole("button", { name: "Approved", exact: true }).click();
      await so.locator(".pb-signoff__confirm").waitFor({ timeout: 15000 });
      await still(h);
    },
    keepScroll: true,
    crop: { selector: ".pb-signoff", pad: 14 },
  },

  // ── Insights and exports ────────────────────────────────────────────────────
  {
    id: "collab-insights",
    page: INSIGHTS,
    name: "insights",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await view(h, h.fx.collab.plan);
      await panel(h).getByRole("button", { name: "More" }).first().click();
      await h.page.getByRole("menuitem", { name: "Comment insights" }).click();
      await h.loc('[data-testid="comment-insights"]').waitFor({ timeout: 20000 });
      await still(h);
    },
    crop: { selector: { css: '[role="dialog"]:has([data-testid="comment-insights"])' }, pad: 0 },
  },
  {
    id: "collab-export",
    page: INSIGHTS,
    name: "export",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 1000 },
    prepare: async (h) => {
      await view(h, h.fx.collab.plan);
      await panel(h).getByRole("button", { name: "More" }).first().click();
      await h.page.getByRole("menuitem", { name: /Export with comments/ }).click();
      await h.page.getByRole("dialog").filter({ hasText: "Include comments" }).first().waitFor({ timeout: 20000 });
      await still(h);
    },
    crop: { selector: { css: '[role="dialog"]:has-text("Include comments")' }, pad: 0 },
  },

  // ── Settings and privacy ────────────────────────────────────────────────────
  {
    id: "collab-share-switches",
    page: SETTINGS,
    name: "share-switches",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 1100 },
    prepare: async (h) => {
      await view(h, h.fx.collab.pricing, { open: false });
      await h.page.getByRole("button", { name: "Share", exact: true }).first().click();
      await h.page.locator("label", { hasText: "Show comments publicly" }).first().waitFor({ timeout: 20000 });
      await h.page.locator("label", { hasText: "Show comments publicly" }).first().scrollIntoViewIfNeeded();
      await still(h);
    },
    keepScroll: true,
    crop: { union: [{ css: 'label:has-text("Signed-in people who can open it")' }, { css: 'label:has-text("Show comments publicly")' }], pad: 10 },
  },
  {
    id: "collab-anon-signin",
    page: SETTINGS,
    name: "sign-in-to-comment",
    kind: "screenshot",
    auth: "anon",
    url: "/dashboard",
    viewport: { width: 1440, height: 900 },
    prepare: async (h) => {
      S.slug = await freshPage(h, { title: "Checkout launch plan" });
      await ok(h, "PUT", `/api/v1/documents/${S.slug}/access/level`, { level: "link" });
      await h.goto(`/${S.slug}`);
      await h.loc(".pb-paper").waitFor({ timeout: 30000 });
      await h.settle(800);
      await selectText(h, "three waves: our own team first");
      await h.page.locator(".mdc-selbtn:visible").first().waitFor({ timeout: 10000 });
      await h.settle(300);
    },
    keepScroll: true,
    crop: async (h) => {
      const b = await h.page.locator(".mdc-selbtn:visible").first().boundingBox();
      const p = await h.page.locator(".pb-paper p", { hasText: "three waves" }).first().boundingBox();
      const y1 = Math.min(b.y, p.y) - 40, y2 = Math.max(b.y + b.height, p.y + p.height) + 40;
      const x1 = Math.min(b.x, p.x) - 24, x2 = Math.max(b.x + b.width, p.x + p.width) + 24;
      return { box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } };
    },
  },

  // ── Jira in pages ───────────────────────────────────────────────────────────
  {
    id: "collab-jira-chip-card",
    page: JIRA,
    name: "chip-and-card",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1440, height: 1100 },
    prepare: async (h) => {
      await view(h, h.fx.collab.plan, { open: false });
      await h.loc('[data-testid="jira-card"] [data-testid="jira-status"]').waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { union: [{ css: '.pb-paper li:has-text("Card retries")' }, '[data-testid="jira-card"]'], pad: 16 },
  },
  {
    id: "collab-jira-list",
    page: JIRA,
    name: "list",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1440, height: 1100 },
    prepare: async (h) => {
      await view(h, h.fx.collab.plan, { open: false });
      await h.loc('[data-testid="jira-list-row"]').first().waitFor({ timeout: 30000 });
      await h.loc('[data-testid="jira-list"]').scrollIntoViewIfNeeded();
      await still(h);
    },
    keepScroll: true,
    crop: { selector: '[data-testid="jira-list"]', pad: 14 },
  },
  {
    id: "collab-jira-anon",
    page: JIRA,
    name: "signed-out",
    kind: "screenshot",
    auth: "anon",
    url: "/dashboard",
    viewport: { width: 1440, height: 1100 },
    prepare: async (h) => {
      S.slug = await freshPage(h, { title: "Checkout launch plan", content: "Card retries ship with :jira[PAY-1] before the first wave.\n\n::jira{key=PAY-2}\n" });
      // What an editor's page remembers when they add an issue: its key and title, for readers without Jira.
      for (const key of ["PAY-1", "PAY-2"]) await ok(h, "POST", `/api/v1/jira/pages/${S.slug}/remember`, { site: "acme.atlassian.net", key });
      await ok(h, "PUT", `/api/v1/documents/${S.slug}/access/level`, { level: "link" });
      await h.goto(`/${S.slug}`);
      await h.loc('[data-testid="jira-card"]').waitFor({ timeout: 30000 });
      await still(h);
    },
    crop: { union: [{ css: '.pb-paper p:has-text("Card retries")' }, '[data-testid="jira-card"]'], pad: 16 },
  },
  {
    id: "collab-jira-paste",
    page: JIRA,
    name: "paste-link",
    kind: "clip",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      S.slug = await freshPage(h, { title: "Website launch checklist", content: "The cookie banner has to be live for EU visitors before we switch on the new pricing page.\n\nTracked in\n" });
      await h.goto(`/${S.slug}`);
      await h.loc(".pb-paper").waitFor({ timeout: 30000 });
      await h.page.locator('[data-page-mode="edit"]').first().click();
      await h.loc('.pb-live .ProseMirror[contenteditable="true"]').waitFor({ timeout: 30000 });
      await h.settle(1200);
      await h.page.mouse.move(700, 500);
    },
    steps: async (h) => {
      await h.sleep(400);
      await h.click(h.page.locator(".pb-live .ProseMirror").getByText("Tracked in").first());
      await h.press("End", 200);
      await h.type(null, " ", { speed: 2 });
      await h.sleep(500);
      await h.page.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData("text/plain", "https://acme.atlassian.net/browse/WEB-2");
        document.querySelector(".pb-live .ProseMirror").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await h.loc('.pb-live [data-testid="jira-inline"][data-key="WEB-2"]').waitFor({ timeout: 10000 });
      await h.sleep(900);
      await h.type(null, " and ", { speed: 2 });
      await h.type(null, "@WEB-1", { speed: 1.6 });
      await h.page.locator(".dxe-people [role=option]", { hasText: "WEB-1" }).first().waitFor({ state: "attached", timeout: 8000 });
      await h.sleep(500);
      await h.press("Enter", 300);
      await h.loc('.pb-live [data-testid="jira-inline"][data-key="WEB-1"]').waitFor({ timeout: 10000 });
      await h.sleep(1500);
    },
  },
  {
    id: "collab-jira-card-status",
    page: JIRA,
    name: "card-status",
    kind: "clip",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      S.slug = await freshPage(h, { title: "Invoices: open issues", content: "The invoice footer is blocked on the new legal copy.\n\n::jira{key=PAY-3}\n\nWe'll pick it up once legal replies.\n" });
      await view(h, S.slug, { open: false });
      await h.loc('[data-testid="jira-card"] [data-testid="jira-status"]').waitFor({ timeout: 30000 });
      await h.settle(600);
      await h.page.mouse.move(800, 600);
    },
    steps: async (h) => {
      await h.sleep(500);
      const c = h.page.locator('[data-testid="jira-card"]').first();
      await h.click(c.locator('[data-testid="jira-status"]'));
      await h.sleep(500);
      await h.click(h.page.getByRole("menuitem", { name: /In Progress/ }).first());
      await c.locator(".jr-status", { hasText: /In Progress/i }).waitFor({ timeout: 15000 });
      await h.sleep(900);
      await h.click(c.getByTestId("jira-comment"));
      await h.type(null, "Legal sent the copy.", { speed: 2.4 });
      await h.click(h.page.getByTestId("jira-comment-send"));
      await h.sleep(1300);
    },
    after: async (h) => {
      await h.sandbox("/__sandbox/jira/move", { key: "PAY-3", status: "Blocked", workspace_id: h.fx.workspace.id }).catch(() => {});
    },
  },
  {
    id: "collab-jira-live-list",
    page: JIRA,
    name: "live-list",
    kind: "clip",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      S.slug = await freshPage(h, { title: "Website work", content: "Everything open on the website, always current:\n\n::jira-list{project=WEB cols=\"status,assignee,priority,due\" title=\"Website issues\"}\n" });
      await view(h, S.slug, { open: false });
      await h.loc('[data-testid="jira-list-row"]').first().waitFor({ timeout: 30000 });
      await h.settle(600);
      await h.page.mouse.move(900, 600);
    },
    steps: async (h) => {
      await h.sleep(900);
      const row = h.page.locator('[data-testid="jira-list-row"]', { hasText: "Cookie banner" }).first();
      await h.hover(row, 500);
      // And a row's status menu moves an issue, as you.
      await h.click(row.locator('[data-testid="jira-status"]'));
      await h.sleep(400);
      await h.click(h.page.getByRole("menuitem", { name: /^Done/ }).first());
      await row.locator(".jr-status", { hasText: /Done/i }).waitFor({ timeout: 15000 });
      await h.sleep(1400);
    },
    after: async (h) => {
      await h.sandbox("/__sandbox/jira/move", { key: "WEB-2", status: "To Do", workspace_id: h.fx.workspace.id }).catch(() => {});
    },
  },
  {
    id: "collab-jira-thread",
    page: JIRA,
    name: "thread-to-issue",
    kind: "clip",
    auth: "member",
    url: "/dashboard",
    viewport: { width: 1200, height: 720 },
    tail: 500,
    prepare: async (h) => {
      S.slug = await freshPage(h);
      S.tid = await thread(h, S.slug, "admin", text("new help article"), "The help article needs screenshots of the new checkout. Who takes it?");
      await ok(h, "POST", `${C(S.slug)}/${S.tid}/replies`, { body: "I can, but let's track it so it doesn't slip." }, "member");
      await view(h, S.slug);
      await card(h, S.tid).click({ position: { x: 120, y: 20 } }).catch(() => {});
      await h.settle(600);
      await h.page.mouse.move(600, 500);
    },
    steps: async (h) => {
      await h.sleep(500);
      const th = card(h, S.tid);
      await h.click(th.getByRole("button", { name: "Create Jira issue" }).first());
      await h.loc('[data-testid="jira-create"]').waitFor({ timeout: 20000 });
      await h.sleep(1800);
      await h.click('[data-testid="jira-create"]');
      await th.getByTestId("jira-thread").waitFor({ timeout: 20000 });
      await h.sleep(1800);
    },
  },
  {
    id: "collab-jira-thread-shot",
    page: JIRA,
    name: "thread-issue",
    kind: "screenshot",
    auth: "member",
    url: "/dashboard",
    viewport: WIDE,
    prepare: async (h) => {
      S.slug = await freshPage(h);
      S.tid = await thread(h, S.slug, "admin", text("new help article"), "The help article needs screenshots of the new checkout. Who takes it?");
      await ok(h, "POST", `/api/v1/jira/pages/${S.slug}/threads/${S.tid}/issue`, { fields: { project: "PAY", issue_type: "Task", summary: "Screenshots for the new checkout help article", description: "From the launch plan discussion." } }, "member");
      await view(h, S.slug);
      await card(h, S.tid).getByTestId("jira-thread").waitFor({ timeout: 20000 });
      await still(h);
    },
    crop: (h) => ({ selector: `article.mdc-thread[data-thread-id="${S.tid}"]`, pad: 10 }),
  },
];
