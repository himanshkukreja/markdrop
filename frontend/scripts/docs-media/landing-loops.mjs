#!/usr/bin/env node
/**
 * The Markdrop Guides landing page's loops (frontend/public/guides-landing/): cuts the recorded
 * masters of shots/e-guides-landing.mjs (or any video file) into seamless silent loops and encodes
 * them for the page.
 *
 *   STACK_ID=51 npm run docs:media -- --keep-raw --no-manifest landing-fix     record (masters in .data/<N>/raw)
 *   node scripts/docs-media/landing-loops.mjs [loop names…]                    cut + encode (all when none given)
 *
 * Per loop and theme: speed up, crop, scale to the display size at 2×, then the end cross-fades into
 * the start (a seamless loop), and out come <name>(.dark).mp4 (H.264, faststart), .webm (VP9) and
 * .webp (the poster). Light and dark are the shot's two themes. Encodes run at low priority (nice).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../..");
const STACK_ID = Number(process.env.STACK_ID || 0);
const DATA = path.join(process.env.DOCS_MEDIA_DATA || path.join(HERE, ".data"), STACK_ID ? String(STACK_ID) : "");
const OUT = path.join(FRONTEND, "public/guides-landing");
const FFMPEG = process.env.FFMPEG || (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
const FFPROBE = process.env.FFPROBE || (existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe");

/**
 * name      the files' base name in public/guides-landing
 * shot      the recording (capture.mjs shot id; its master is .data/<N>/raw/<shot>-<theme>/master.mp4),
 *           or `file` for any other video (themes: ["light"])
 * from/to   the part of the master to use (seconds, before speed-up)
 * speed     playback speed-up
 * crop      [w, h, x, y] in the master's pixels (ffmpeg's crop, before scaling), optional
 * width     output width in pixels (about 2× the size it's shown at)
 * hold      seconds to hold the last frame before the cross-fade, optional
 * fade      seconds of cross-fade from the end back into the start
 * poster    the poster's moment, in seconds of the finished loop
 * crf       H.264 / VP9 quality (lower is better)
 */
const IMPORT_VIDEO = path.join(FRONTEND, "public/docs-assets/videos/guides-import-video.mp4");
const LOOPS = [
  // The hero's laptop: the whole Fix list loop.
  { name: "hero-fix", shot: "landing-fix", themes: ["light", "dark"], from: 0.2, to: 17.3, speed: 1.35, width: 1600, fade: 0.5, poster: 2.2, crf: [28, 45] },
  // The Fix list section: the drafted fix as a suggestion in the editor, and Accept.
  { name: "fix-editor", shot: "landing-editor", themes: ["light", "dark"], from: 0.3, speed: 1, width: 1200, fade: 0.4, poster: 1.0, crf: [27, 44] },
  // The hero's cards (and the Private pages section).
  { name: "demo-calc", shot: "landing-calc", themes: ["light", "dark"], from: 0.3, speed: 1.15, width: 800, fade: 0.4, poster: 2.8, crf: [27, 44] },
  { name: "private-unlock", shot: "landing-private", themes: ["light", "dark"], from: 0.3, speed: 1.1, width: 800, fade: 0.4, poster: 6.4, crf: [27, 44] },
  // Move in: a GitBook import, from the docs video (guides-import-video), the progress part sped up.
  { name: "import", file: IMPORT_VIDEO, from: 10.6, to: 29.4, speed: 3, hold: 1.4, crop: [1520, 690, 140, 150], width: 960, fade: 0.4, poster: 5.4, crf: [28, 45] },
];

const run = (args) => execFileSync("nice", ["-n", "15", FFMPEG, "-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "inherit" });
const duration = (file) => Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
const kb = (f) => `${(statSync(f).size / 1024).toFixed(0)} KB`;

function build(loop, theme) {
  const src = loop.file || path.join(DATA, "raw", `${loop.shot}-${theme}`, "master.mp4");
  if (!existsSync(src)) {
    console.warn(`  ! ${loop.name} [${theme}]: no ${path.relative(FRONTEND, src)} (record it first)`);
    return;
  }
  const total = duration(src);
  const from = loop.from || 0;
  const to = loop.to || total;
  const hold = loop.hold || 0;
  const len = (to - from) / loop.speed + hold; // after speed-up, with the last frame held
  const x = loop.fade;
  const pre = [
    `trim=start=${from}:end=${to}`, "setpts=PTS-STARTPTS", `setpts=PTS/${loop.speed}`, "fps=30",
    hold ? `tpad=stop_mode=clone:stop_duration=${hold}` : null,
    loop.crop ? `crop=${loop.crop.join(":")}` : null, `scale=${loop.width}:-2:flags=lanczos:out_range=tv:out_color_matrix=bt709`, "format=yuv420p",
  ].filter(Boolean).join(",");
  // A = from x to the end, B = the first x seconds; A's last x seconds fade into B, whose last frame
  // is A's first: the loop has no seam. Length: len - x. Video range (tv) and BT.709, tagged: the
  // recordings are full-range JPEG frames, which some decoders refuse.
  const graph = [
    `[0:v]${pre},split[a0][b0]`,
    `[a0]trim=start=${x},setpts=PTS-STARTPTS[a]`,
    `[b0]trim=end=${x},setpts=PTS-STARTPTS[b]`,
    `[a][b]xfade=transition=fade:duration=${x}:offset=${(len - 2 * x).toFixed(3)},format=yuv420p[v]`,
  ].join(";");
  mkdirSync(OUT, { recursive: true });
  const base = path.join(OUT, `${loop.name}${theme === "dark" ? ".dark" : ""}`);
  const master = `${base}.master.mp4`;
  run(["-i", src, "-filter_complex", graph, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", master]);
  const [crf264, crf9] = loop.crf || [27, 38];
  run(["-i", master, "-an", "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-crf", String(crf264), "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-g", "60", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-movflags", "+faststart", `${base}.mp4`]);
  run(["-i", master, "-an", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf9), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
    "-g", "60", "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", `${base}.webm`]);
  run(["-ss", String(loop.poster ?? 0), "-i", master, "-frames:v", "1", "-c:v", "libwebp", "-quality", "78", "-compression_level", "6", `${base}.webp`]);
  rmSync(master, { force: true });
  console.log(`  ${loop.name}${theme === "dark" ? ".dark" : ""}: ${(len - x).toFixed(1)} s · mp4 ${kb(`${base}.mp4`)} · webm ${kb(`${base}.webm`)} · poster ${kb(`${base}.webp`)}`);
}

const want = process.argv.slice(2);
for (const loop of LOOPS.filter((l) => !want.length || want.includes(l.name))) {
  for (const theme of loop.themes || ["light"]) build(loop, theme);
}
