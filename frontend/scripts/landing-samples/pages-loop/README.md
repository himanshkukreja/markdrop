# The landing page's Pages loop

The Pages section of markdrop.in (`src/components/landing/desk/Pages.tsx`) plays a muted loop of the real page editor: `public/landing-desk/pages.{mp4,webm,webp}` and the dark twins `pages.dark.*`. This folder records and encodes it.

## What it shows

On a page called "Launch review" in Acme's workspace, typing `/` opens the block menu. A callout and a to-do are added. Then `/embed` opens the item picker, and the Q3 report PDF and a team photo from the workspace are embedded and render live. The page saves itself. The loop is about 23 seconds long, and the poster is the moment the PDF has rendered under the callout and the to-do, with "Saved" showing.

The PDF frame is the production Worker viewer: `record.mjs` imports `worker/src/index.js` with an in-memory R2. The PDF (an Acme Q3 report) and the photo (an illustration) are generated on the first run. All the data is fictional.

## Re-record

You need the page builder's mock API (`server.mjs`; by default the main checkout's `.work/page-builder/mock/server.mjs`), ffmpeg in `/opt/homebrew/bin`, and `frontend/node_modules` (a symlink to the main checkout's is fine).

```sh
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH"
cd frontend/scripts/landing-samples/pages-loop
zsh stack.sh up            # mock API :8797 + next dev :3197 of this checkout (MOCK=… for another mock path)
node record.mjs            # both themes → .data/<theme>/master.mp4 (+ take.json, end.png)
node record.mjs sheet      # optional: a contact sheet per theme to check the take (.data/<theme>/sheet.png)
node record.mjs encode     # → ../../../public/landing-desk/pages(.dark).{mp4,webm,webp}
zsh stack.sh down
```

`node record.mjs all` records and then encodes. `THEMES=light` records one theme, `HEADED=1` shows the browser, and `KEEP=1` keeps the raw frames.

Encoding runs with `nice -n 10`, one file at a time. On the owner's Mac, ask before running other heavy jobs at the same time.

## After the UI polish

The selectors are in `SEL` at the top of `record.mjs`. The take also relies on:

- the slash menu filters `callout`, `todo` and `embed`;
- the picker's **Search items** field and its **Acme** tab.

If the polish renames any of these, update them there. Check the result with `node record.mjs sheet` before encoding.

If the new loop's size or aspect ratio changes, update the `w` and `h` of the `LoopVideo` in `Pages.tsx`. They are now 1200 × 900.

Output sizes: about 420–440 KB MP4, about 470–490 KB WebM, and a 25 KB poster per theme. To make the files smaller, raise `CUT.crf` or `CUT.speed`.
