/**
 * `::markdrop` blocks: the link rules, attribute validation and what each API answer draws.
 *   node --test src/docs/embed.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SANDBOX,
  STATES,
  clock,
  embedAttrs,
  embedPlainLine,
  embedView,
  formatBytes,
  frameHeight,
  parseAspect,
  parseMarkdropSrc,
  safeFrameUrl,
  themedFrameSrc,
} from "./embed.mjs";

const ART = "https://markdrop-artifacts.markdrop-in.workers.dev";

test("src: only a Markdrop link names a file", () => {
  assert.equal(parseMarkdropSrc("https://markdrop.in/acme-pricing"), "acme-pricing");
  assert.equal(parseMarkdropSrc("https://www.markdrop.in/acme_pricing/"), "acme_pricing");
  assert.equal(parseMarkdropSrc("  https://markdrop.in/Abc-1?utm=x#top "), "Abc-1");
  for (const bad of [
    "http://markdrop.in/acme", // not https
    "https://markdrop.in/", // no slug
    "https://markdrop.in/w/acme/doc", // a deeper path
    "https://evil.example/acme",
    "https://markdrop.in.evil.example/acme",
    "https://user:pw@markdrop.in/acme",
    "https://markdrop.in/a%2Fb",
    "https://markdrop.in/has.dot",
    "javascript:alert(1)",
    "acme-pricing",
    "",
    null,
  ])
    assert.equal(parseMarkdropSrc(bad), null, String(bad));
  // A local stack names its own app host.
  assert.equal(parseMarkdropSrc("http://localhost:3410/acme", ["localhost:3410"]), "acme");
  assert.equal(parseMarkdropSrc("http://localhost:3410/acme"), null);
});

test("attributes: valid values kept, bad ones dropped with a warning, a bad src is an error", () => {
  const a = embedAttrs({ src: "https://markdrop.in/acme", title: "Calc", height: "640", mode: "preview", version: "3" });
  assert.deepEqual(
    { slug: a.slug, title: a.title, height: a.height, mode: a.mode, version: a.version, errors: a.errors, warnings: a.warnings },
    { slug: "acme", title: "Calc", height: 640, mode: "preview", version: 3, errors: [], warnings: [] },
  );
  assert.equal(embedAttrs({ src: "https://markdrop.in/acme" }, { label: "From label" }).title, "From label");
  const bad = embedAttrs({ src: "https://example.com/x", height: "9000", aspect: "wide", mode: "auto", version: "v2", captions: "https://x/c.vtt", width: "10" });
  assert.equal(bad.slug, null);
  assert.match(bad.errors[0], /isn't a Markdrop link/);
  assert.equal(bad.height, null);
  assert.equal(bad.aspect, null);
  assert.equal(bad.mode, "live");
  assert.equal(bad.version, null);
  assert.equal(bad.captions, null);
  assert.equal(bad.warnings.length, 6, bad.warnings.join("\n"));
  assert.match(embedAttrs({}).errors[0], /needs src=/);
  const both = embedAttrs({ src: "https://markdrop.in/a", height: "300", aspect: "9:16" });
  assert.equal(both.aspect, "9:16");
  assert.match(both.warnings[0], /aspect wins/);
  const media = embedAttrs({ src: "https://markdrop.in/a", captions: "/docs-assets/v/tour.en.vtt", chapters: "/docs-assets/../x.vtt" });
  assert.equal(media.captions, "/docs-assets/v/tour.en.vtt");
  assert.equal(media.chapters, null);
});

test("aspect and frame height", () => {
  assert.equal(parseAspect("16:9"), 16 / 9);
  assert.equal(parseAspect("9/16"), 9 / 16);
  assert.equal(parseAspect("1:5"), null);
  assert.equal(parseAspect("0:1"), null);
  assert.equal(frameHeight({ aspect: "16:9" }, "html", 800), 450);
  assert.equal(frameHeight({ aspect: "9:16" }, "html", 2000), 2000); // capped
  assert.equal(frameHeight({ height: 300 }, "pdf", 800), 300);
  assert.equal(frameHeight({}, "pdf", 800), 720);
  assert.equal(frameHeight({}, "sheet", 800), 520);
});

test("viewer pages get the reader's theme; raw pages and signed links stay intact", () => {
  assert.equal(themedFrameSrc(`${ART}/v/pdf/art/u/k.pdf`, "dark"), `${ART}/v/pdf/art/u/k.pdf?theme=dark`);
  assert.equal(themedFrameSrc(`${ART}/v/sheet/art/u/k.xlsx?t=abc`, "light"), `${ART}/v/sheet/art/u/k.xlsx?t=abc&theme=light`);
  assert.equal(themedFrameSrc(`${ART}/r/art/u/k.html`, "dark"), `${ART}/r/art/u/k.html`);
  assert.equal(themedFrameSrc("not a url", "dark"), null);
});

test("only the artifact origin is framed", () => {
  assert.equal(safeFrameUrl(`${ART}/r/art/u/k.html`, ART), `${ART}/r/art/u/k.html`);
  assert.equal(safeFrameUrl("https://evil.example/r/x", ART), null);
  assert.equal(safeFrameUrl("javascript:alert(1)", ART), null);
  assert.equal(safeFrameUrl("http://evil.example/x"), null);
  assert.equal(safeFrameUrl("http://127.0.0.1:8797/r/art/x"), "http://127.0.0.1:8797/r/art/x");
});

const attrs = (extra = {}) => embedAttrs({ src: "https://markdrop.in/acme", ...extra });
const ok = (extra = {}) => ({ state: "ok", slug: "acme", title: "Acme pricing", size_bytes: 20480, type_label: "HTML page", ...extra });

test("view: each renderer draws its own way", () => {
  const html = embedView(ok({ renderer: "html", frame_url: `${ART}/r/art/u/k.html` }), attrs(), { theme: "dark", artifactOrigin: ART });
  assert.equal(html.type, "frame");
  assert.equal(html.sandbox, SANDBOX);
  assert.equal(html.paper, true);
  assert.equal(html.src, `${ART}/r/art/u/k.html`);
  assert.equal(html.open, "https://markdrop.in/acme");
  assert.deepEqual(html.meta, ["20 KB"]);

  const pdf = embedView(ok({ renderer: "pdf", frame_url: `${ART}/v/pdf/art/u/k.pdf`, type_label: "PDF" }), attrs(), { theme: "light", artifactOrigin: ART });
  assert.equal(pdf.type, "frame");
  assert.equal(pdf.paper, false);
  assert.equal(pdf.src, `${ART}/v/pdf/art/u/k.pdf?theme=light`);

  for (const r of ["sheet", "docx", "bundle", "text"]) assert.equal(embedView(ok({ renderer: r, frame_url: `${ART}/v/${r}/art/u/k` }), attrs(), { artifactOrigin: ART }).type, "frame", r);

  const video = embedView(ok({ renderer: "video", raw_url: `${ART}/r/art/u/v.mp4`, poster_url: `${ART}/r/art/u/v.poster.jpg`, media: { duration: 125.2, width: 1920, height: 1080 } }), attrs(), { artifactOrigin: ART });
  assert.equal(video.type, "video");
  assert.equal(video.src, `${ART}/r/art/u/v.mp4`);
  assert.equal(video.poster, `${ART}/r/art/u/v.poster.jpg`);
  assert.equal(video.duration, "2:05");
  assert.deepEqual(video.meta, ["2:05"]);

  assert.equal(embedView(ok({ renderer: "audio", raw_url: `${ART}/r/art/u/a.mp3` }), attrs(), { artifactOrigin: ART }).type, "audio");
  assert.equal(embedView(ok({ renderer: "image", raw_url: `${ART}/r/art/u/a.png` }), attrs(), { artifactOrigin: ART }).type, "image");
  const doc = embedView(ok({ renderer: "doc", excerpt: "Hello" }), attrs(), { artifactOrigin: ART });
  assert.equal(doc.type, "card");
  assert.equal(doc.excerpt, "Hello");
  assert.deepEqual(doc.meta, []);
});

test("view: mode=card, a pinned version, the page's title wins", () => {
  const v = embedView(ok({ renderer: "pdf", frame_url: `${ART}/v/pdf/x`, pinned: true, version: 3 }), attrs({ mode: "card", title: "Price list" }), { artifactOrigin: ART });
  assert.equal(v.type, "card");
  assert.equal(v.title, "Price list");
  assert.deepEqual(v.meta, ["20 KB", "Version 3"]);
});

test("view: states never carry the file's title or bytes", () => {
  for (const state of ["private", "password", "signin", "encrypted", "unavailable", "unsupported"]) {
    const v = embedView({ state, slug: "acme", title: "LEAK" }, attrs(), { artifactOrigin: ART });
    assert.equal(v.type, "state", state);
    assert.equal(v.state, state);
    assert.notEqual(v.title, "LEAK");
    assert.equal(v.open, STATES[state].open ? "https://markdrop.in/acme" : null, state);
  }
  assert.equal(embedView({ state: "weird" }, attrs()).state, "unavailable");
  assert.equal(embedView(null, attrs()).type, "loading");
  assert.equal(embedView(null, embedAttrs({ src: "https://x.example/a" })).state, "invalid");
});

test("view: an address off the artifact origin is never framed", () => {
  const v = embedView(ok({ renderer: "html", frame_url: "https://evil.example/r/x" }), attrs(), { artifactOrigin: ART });
  assert.equal(v.type, "state");
  assert.equal(v.state, "unsupported");
  const vid = embedView(ok({ renderer: "video", raw_url: "javascript:alert(1)" }), attrs(), { artifactOrigin: ART });
  assert.equal(vid.state, "unsupported");
});

test("plain Markdown twin and formatting", () => {
  assert.equal(embedPlainLine({ src: "https://markdrop.in/acme", title: "Calc [v2]" }), "[Markdrop file: Calc v2](https://markdrop.in/acme)");
  assert.equal(embedPlainLine({ src: "https://x.example/acme" }), null);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(25 * 1024 * 1024), "25 MB");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(clock(undefined), "");
});
