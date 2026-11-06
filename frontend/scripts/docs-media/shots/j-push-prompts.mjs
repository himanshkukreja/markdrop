/**
 * Docs media, group J: the one-tap "turn on notifications" prompts (/pages/mentions-and-notifications).
 * Shot format: ../shots.mjs.
 *
 * The Home card shows only where a click can turn push on: a production build (the service worker;
 * `next dev` has none) and an API with push keys. So these stills are taken against the page-builder
 * real stack (e2e/pages/real/up.sh, a production build) started with PB_PUSH=1, seeded with this demo
 * world, e.g. for PB_STACK_ID=47:
 *
 *   PB_PUSH=1 PB_STACK_ID=47 zsh e2e/pages/real/up.sh start
 *   STACK_ID=47 DOCS_MEDIA_DATA=$PB_WORK/stack/data backend/.venv/bin/python frontend/scripts/docs-media/seed.py
 *   STACK_ID=47 DOCS_MEDIA_DATA=$PB_WORK/stack/data npm run docs:media -- push-prompt-home
 */
export default [
  {
    id: "push-prompt-home",
    page: "/pages/mentions-and-notifications",
    name: "push-prompt",
    kind: "screenshot",
    auth: "owner",
    url: "/dashboard",
    viewport: { width: 900, height: 860 }, // a tablet-width Home: the buttons under the text
    prepare: async (h) => {
      // The capture context grants the clipboard only, which leaves notifications "denied" (the card
      // then hides, as it should). A device that hasn't turned them on yet: allowed, not subscribed.
      const origin = new URL(h.page.url()).origin;
      await h.page.context().grantPermissions(["notifications"], { origin });
      await h.goto("/dashboard");
      await h.loc('[data-testid="push-prompt-home"]').waitFor({ timeout: 20000 }).catch(() => {
        throw new Error("no Home card: run against a production build with an API started with PB_PUSH=1 (see this file)");
      });
      await h.settle(600);
      await h.page.mouse.move(5, 855); // no hover state on the buttons
    },
    crop: { selector: '[data-testid="push-prompt-home"]', pad: 24 },
  },
];
