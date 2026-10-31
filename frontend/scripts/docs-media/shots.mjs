/**
 * The docs media shot list (capture.mjs runs it). One entry per asset:
 *
 *   id        unique; `npm run docs:media -- <id>` captures just this one
 *   page      the docs page it illustrates ("/workspaces/custom-domain"); the asset lands in
 *             public/docs-assets/<page without leading slash>/ (videos: public/docs-assets/videos/)
 *   dir       the folder under public/docs-assets/ instead of the page's (optional)
 *   name      file name without extension (default: id); dark variants get ".dark"
 *   kind      "screenshot" | "clip" | "video"
 *   auth      "owner" (Riya) | "alex" | "sam" | "maya" | "dana" | "jordan" | "anon"
 *   url       where to start (path on the app, a full URL, or (fx) => url)
 *   viewport  CSS px (screenshot default 1440×900 at 2×; clip 1440×900 → 1440 wide; video 1440×810 → 1920×1080)
 *   themes    default: screenshots ["light", "dark"], clips and videos ["light"]
 *   prepare   async (h) => {}  — runs before the shot (clips/videos: not recorded)
 *   steps     async (h) => {}  — screenshots: before the capture; clips/videos: what is recorded
 *   crop      screenshot region: "viewport" | {selector, pad} | {union: [sel…], pad} | {box: {x,y,width,height}}
 *             | async (h) => one of those. Selectors: CSS string, {role, name}, {text}, {label}, {css}
 *   poster    clip/video poster time in seconds (default: last frame / 2 s)
 *   videoId   videos: the ::video{id=…} slot in content/docs/videos.json (default: id)
 *
 * The helpers `h` (capture.mjs → helpers): goto, settle, click, hover, move, type (human-paced),
 * paste, press, scrollTo, wheel, caption (on-screen text + WebVTT chapters), hideCursor, loc,
 * sandbox (POST to the sandbox API), fx (seed fixtures: users, workspace ids, slugs), tenant(host, path).
 *
 * The demo world (seed.py): Riya Sharma owns workspace "Acme" (folders Guides › Setup, Releases,
 * Sales; site name "Acme"; teal accent; docs.acme.com live + default, help.acme.com awaiting DNS).
 */

/** The seeded domain state: docs.acme.com live + default, help.acme.com awaiting DNS. */
const restoreDomains = async (h) => {
  const ws = h.fx.workspace.id;
  await h.sandbox("/__sandbox/domains/reset", { workspace_id: ws, keep: [] });
  await h.sandbox("/__sandbox/domain", { workspace_id: ws, host: "docs.acme.com", primary: true });
  await h.sandbox("/__sandbox/domain", { workspace_id: ws, host: "help.acme.com", pending: true });
};

const escapeImmersive = async (h) => {
  // Document and file pages open full screen; Escape brings the top bar back.
  await h.page.keyboard.press("Escape");
  await h.sleep(500);
};

export default [
  // ── 1. My files (dashboard) ────────────────────────────────────────────────
  {
    id: "my-files",
    page: "/get-started/tour",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 1440, height: 900 },
    prepare: async (h) => {
      await h.loc({ role: "heading", name: "My files" }).waitFor();
      await h.page.mouse.move(5, 895); // no hover state on a row
    },
    // The sidebar and the first rows of My files.
    crop: { box: { x: 0, y: 56, width: 1290, height: 700 } },
  },

  // ── 2. Share dialog: who can open it ───────────────────────────────────────
  {
    id: "share-dialog-access",
    page: "/sharing/who-can-open",
    kind: "screenshot",
    auth: "owner",
    url: "/release-notes-2-4",
    prepare: async (h) => {
      await escapeImmersive(h);
      await h.loc({ role: "button", name: "Share" }).click();
      await h.loc("input[name='md-share-level']").waitFor({ state: "attached" });
      await h.sleep(700); // the md-pop animation
    },
    // Title through the line listing the file's addresses (+ "More options").
    crop: async (h) => {
      const dialog = h.loc(".md-dialog:has(input[name='md-share-level'])");
      const box = await dialog.boundingBox();
      const more = await h.loc({ text: "More options: password and expiry" }).boundingBox();
      return { box: { x: box.x, y: box.y, width: box.width, height: more.y + more.height + 14 - box.y } };
    },
  },

  // ── 3. Look and domain: the DNS records of a domain awaiting DNS ────────────
  {
    id: "dns-records",
    page: "/workspaces/custom-domain",
    kind: "screenshot",
    auth: "owner",
    url: (fx) => `/settings/workspaces/${fx.workspace.id}?tab=look`,
    prepare: async (h) => {
      // help.acme.com awaits DNS: nothing published in the sandbox resolver.
      await restoreDomains(h);
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(600);
      const card = h.loc("section[aria-labelledby='ws-domain-h']");
      await card.waitFor();
      await h.scrollTo({ text: "help.acme.com", exact: true }, { block: "start" });
      await h.page.mouse.move(5, 5);
    },
    crop: async (h) => {
      // The help.acme.com card: the smallest element holding both its host line and its records.
      const handle = await h.page.evaluateHandle(() => {
        const section = document.querySelector("section[aria-labelledby='ws-domain-h']");
        let best = null;
        for (const el of section.querySelectorAll("*")) {
          const t = el.textContent || "";
          if (t.includes("Awaiting DNS") && t.includes("Routing record") && !t.includes("docs.acme.com")) {
            if (!best || best.contains(el)) best = el;
          }
        }
        return best;
      });
      await handle.evaluate((el) => el.setAttribute("data-mdcap", "help-card"));
      return { selector: "[data-mdcap=help-card]", pad: 16 };
    },
  },

  // ── 4. Upload page with a PDF chosen ───────────────────────────────────────
  {
    id: "upload-form",
    page: "/get-started/first-file",
    kind: "screenshot",
    headed: true, // the preview is Chrome's PDF viewer in a blob iframe, which headless can't draw
    auth: "owner",
    url: "/upload",
    prepare: async (h) => {
      const file = new URL("./.data/fixtures/q3-board-deck-v1.pdf", import.meta.url).pathname;
      await h.page.locator("input[type=file]").first().setInputFiles({
        name: "Q3 Board Deck.pdf", mimeType: "application/pdf", buffer: (await import("node:fs")).readFileSync(file),
      });
      await h.loc({ role: "button", name: "Publish", exact: true }).waitFor();
      await h.sleep(7000); // the preview renders page 1 and its thumbnails
      await h.page.mouse.move(5, 895);
    },
    crop: { selector: "main", pad: 0 },
  },

  // ── 5. The PDF reader ──────────────────────────────────────────────────────
  {
    id: "viewer-pdf",
    page: "/files/supported-types",
    kind: "screenshot",
    auth: "anon",
    url: "/q3-board-deck",
    prepare: async (h) => {
      await escapeImmersive(h);
      const frame = h.page.frameLocator("iframe[src*='/v/pdf/']");
      await frame.getByText(/of 12/).first().waitFor({ timeout: 60_000 });
      await h.sleep(1500); // canvas paint
      await h.page.mouse.move(5, 895);
    },
    crop: { selector: "iframe[src*='/v/pdf/']", pad: 0 },
  },

  // ── 6. Video analytics: retention ──────────────────────────────────────────
  {
    id: "retention-curve",
    page: "/analytics/video-and-audio",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard/analytics/product-demo?tab=video",
    prepare: async (h) => {
      await h.loc("#md-ret").waitFor();
      await h.sleep(1200); // thumbnails
      await h.page.mouse.move(5, 895);
    },
    // The "Who's still watching" card, including the Rewatched and skipped strip.
    crop: { selector: "section:has(> div > #md-ret)", pad: 12 },
  },

  // ── 7. Clip: publish a document from /new ──────────────────────────────────
  {
    id: "publish-from-new",
    page: "/get-started/first-document",
    kind: "clip",
    auth: "anon",
    url: "/new",
    viewport: { width: 1280, height: 800 },
    out: 1440,
    prepare: async (h) => {
      await h.page.evaluate(() => localStorage.removeItem("md_new_draft"));
      await h.loc({ role: "textbox", name: "Markdown" }).waitFor();
    },
    steps: async (h) => {
      await h.type({ role: "textbox", name: "Title" }, "Offsite agenda", { speed: 1.6 });
      await h.paste({ role: "textbox", name: "Markdown" },
        "## Day 1\n\n- 10:00 Strategy for 2027\n- 14:00 Customer panel\n- 16:00 Roadmap workshop\n\n## Day 2\n\n| Time | Session |\n| --- | --- |\n| 09:30 | Retro |\n| 11:00 | Hack morning |\n");
      await h.sleep(300);
      await h.click({ role: "tab", name: "Split" }, { after: 1100 });
      await h.click({ role: "button", name: "Publish", exact: true }, { after: 2200 });
    },
    poster: 7,
    tail: 400,
  },

  // ── 8. Video: put a workspace on its own domain ────────────────────────────
  {
    id: "custom-domain",
    page: "/workspaces/custom-domain",
    kind: "video",
    videoId: "custom-domain",
    auth: "owner",
    url: (fx) => `/settings/workspaces/${fx.workspace.id}?tab=look`,
    prepare: async (h) => {
      // Start from a workspace with no domain on the air: drop docs.acme.com (and help.acme.com)
      // for the take; seed.py puts them back.
      await h.sandbox("/__sandbox/domains/reset", { workspace_id: h.fx.workspace.id, keep: [] });
      await h.page.reload({ waitUntil: "domcontentloaded" });
      await h.settle(800);
      await h.scrollTo("section[aria-labelledby='ws-domain-h']", { block: "start" });
    },
    steps: async (h) => {
      await h.caption("Look and domain › Add a domain", 1200);
      await h.click({ role: "button", name: /Add a domain/ });
      await h.type({ role: "textbox", name: /host|domain/i }, "docs.acme.com");
      await h.sleep(500);
      await h.click({ role: "button", name: "Add domain", exact: true }, { after: 1500 });
      await h.caption("Copy the two records into your DNS", 600);
      await h.scrollTo({ text: /Ownership record/i }, { block: "center" });
      await h.hover({ role: "button", name: /Copy ownership record value/i }, 900);
      await h.click({ role: "button", name: /Copy ownership record value/i }, { after: 900 });
      await h.hover({ role: "button", name: /Copy routing record value/i }, 900);
      await h.click({ role: "button", name: /Copy routing record value/i }, { after: 900 });
      // The records are added at the DNS provider (the sandbox resolver publishes them).
      await h.caption("Records added at your DNS provider · then Check DNS", 400);
      await h.sandbox("/__sandbox/dns", { host: "docs.acme.com", publish: true });
      await h.scrollTo({ role: "button", name: "Check DNS" }, { block: "center" });
      await h.click({ role: "button", name: "Check DNS" }, { after: 3000 });
      await h.caption("Live: readers can open docs.acme.com", 3500);
      await h.goto(h.tenant("docs.acme.com", "/guides/setup/getting-started#mdt-none=1"), { settle: 1200 });
      await h.press("Escape", 600); // out of full screen: the Acme header shows
      await h.caption("Your documents, on your own domain", 2500);
      await h.wheel(500, 16);
      await h.sleep(2500);
    },
    after: restoreDomains,
    poster: 4,
  },
];
