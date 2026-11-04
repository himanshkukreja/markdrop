/**
 * Diagnosis for fix/open-flash: open every kind of item from the workspace listing (a page, a
 * classic document, an HTML / PDF / CSV / MP4 file) as the owner and as a member, unthrottled and on
 * slow 3G, and record what the new tab paints between the click and the content: a DOM timeline
 * (openProbe.mjs) and a video, cut into its distinct frames (a contact sheet per open).
 *
 *   PB_STACK_ID=23 PB_WORK=… [BROWSER=webkit] [LABEL=before|after] [KINDS=page,doc] [WHO=owner,member]
 *   [PROFILES=fast,slow3g] [NO_RESEED=1] node open.mjs
 *
 * Writes <OPEN_OUT or $PB_WORK/open>/<LABEL>/<browser>/<who>-<kind>-<profile>.{json,webm,png}
 * and a summary.json; exits 1 when any open painted a foreign look.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { APP, API, WORKER, STACK, STACK_ID, BROWSER, WORK, log, reseed, launch, ctx } from "./lib.mjs";
import { armOpenProbe, settledTimeline, foreign, fmt, slow3g, TARGET } from "./openProbe.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(here, "../../../..").split("/.claude/worktrees/")[0];
const PY = path.join(ROOT, "backend", ".venv", "bin", "python");
const LABEL = process.env.LABEL || "after";
const OUT = path.join(process.env.OPEN_OUT || path.join(WORK, "open"), LABEL, BROWSER);
fs.mkdirSync(OUT, { recursive: true });

if (!process.env.NO_RESEED || !fs.existsSync(path.join(STACK, "seed-open.json"))) {
  reseed();
  execFileSync(PY, [path.join(here, "seed_open.py")], { stdio: "inherit", env: { ...process.env, STACK_ID: String(STACK_ID), PB_STACK: STACK } });
}
const O = JSON.parse(fs.readFileSync(path.join(STACK, "seed-open.json"), "utf8"));
const KINDS = (process.env.KINDS || "page,doc,html,pdf,sheet,video").split(",");
const WHO = (process.env.WHO || "owner,member").split(",");
const PROFILES = (process.env.PROFILES || "fast,slow3g").split(",");

/** The distinct frames of a video, tiled (ffmpeg's mpdecimate drops the repeats). */
function contactSheet(video, png) {
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-vf",
      "mpdecimate=hi=1200:lo=400:frac=0.2,setpts=N/FRAME_RATE/TB,scale=480:-1,drawtext=text='%{n}':x=8:y=8:fontsize=28:fontcolor=red,tile=4x3:padding=4:color=white",
      "-frames:v", "1", "-fps_mode", "vfr", png]);
  } catch (e) {
    log("contact sheet failed", String(e.message).slice(0, 200));
  }
}

const browser = await launch();
const summary = [];
let bad = 0;
for (const who of WHO) {
  const token = O.users[who].token;
  for (const prof of PROFILES) {
    for (const kind of KINDS) {
      const slug = O.items[kind];
      const name = `${who}-${kind}-${prof}`;
      const vdir = path.join(OUT, ".video", name);
      fs.rmSync(vdir, { recursive: true, force: true });
      const { c, p } = await ctx(browser, { token, video: vdir });
      await armOpenProbe(c);
      await p.goto(`${APP}/w/${O.ws}`, { waitUntil: "load", timeout: 90000 });
      const link = p.locator(`#main a[href="/${slug}"]`).first();
      await link.waitFor({ timeout: 60000 });
      if (prof === "slow3g") await slow3g(c, { app: APP, api: API, worker: WORKER });
      const [tab] = await Promise.all([c.waitForEvent("page"), link.click()]);
      const tl = await settledTimeline(tab, { timeout: prof === "slow3g" ? 120000 : 45000 });
      await tab.waitForTimeout(300);
      const vid = tab.video();
      await c.close();
      const webm = path.join(OUT, `${name}.webm`);
      if (vid) {
        fs.copyFileSync(await vid.path(), webm);
        contactSheet(webm, path.join(OUT, `${name}.png`));
      }
      fs.rmSync(vdir, { recursive: true, force: true });
      const f = foreign(tl);
      const end = tl[tl.length - 1];
      const off = !end || end.chrome !== TARGET[kind].chrome || end.body !== TARGET[kind].body;
      if (f.length || off) bad++;
      fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ slug, timeline: tl, foreign: f }, null, 1));
      summary.push({ name, settled: end ?? null, offTarget: off, foreign: f.length, timeline: fmt(tl) });
      log(`${f.length || off ? "✗" : "✓"} ${name}: ${fmt(tl)}${off ? "  (settled off target)" : ""}`);
    }
  }
}
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
await browser.close();
log(`${bad} of ${summary.length} opens painted a foreign look → ${OUT}`);
process.exit(bad ? 1 : 0);
