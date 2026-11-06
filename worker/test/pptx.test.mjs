/**
 * The PowerPoint slide viewer (src/pptx.js + /v/pptx/ in src/index.js):
 *   node --test worker/test/pptx.test.mjs
 *
 * - The reader: slides in the deck's slide-list order (numbered as the API's search numbers them, so
 *   `?at=5` is Ask's "slide 5"), titles, bullets and levels, runs, links (http(s) / mailto only),
 *   two shapes side by side as one row, tables with merged cells, pictures from ppt/media (EMF named,
 *   not drawn), a chart's title, SmartArt text, groups, hidden slides, speaker notes without the
 *   notes page's slide number.
 * - The guards (as services/file_text.py): a DOCTYPE, macros, an encrypted or password-protected
 *   deck, a ZIP bomb, something that isn't a deck.
 * - The page: the reader it ships is this module's (evaluated from the page itself), ?at= and the
 *   download link (?dl=1&fn=), nothing from the query reaches the script unescaped, sandboxed when
 *   opened on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { sampleDeck, zip } from "./pptx-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { pptxLib } = await import(pathToFileURL(path.join(here, "..", "src", "pptx.js")).href);
const { default: worker } = await import(pathToFileURL(path.join(here, "..", "src", "index.js")).href);
const lib = pptxLib();
const ORIGIN = "https://markdrop-artifacts.markdrop-in.workers.dev";

const texts = (item) => lib.plain([item]);
const flat = (slide) => slide.rows.flat();

test("slides in order with titles, bullets, runs and safe links only", async () => {
  const deck = await lib.readDeck(sampleDeck());
  assert.equal(deck.slides.length, 6);
  assert.deepEqual(deck.slides.map((s) => s.title), ["Q3 Board Review", "Highlights", "Plan vs actual", "Revenue by region", "Growth", "Appendix"]);
  assert.deepEqual(deck.slides.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  assert.equal(deck.width, 12192000);

  // 1: the title slide, its date placeholder left out; entities decoded.
  const [title, subtitle, ...rest] = flat(deck.slides[0]);
  assert.equal(title.role, "title");
  assert.equal(title.centered, true);
  assert.equal(texts(subtitle), "Markdrop & friends · October 2026");
  assert.equal(rest.length, 0);

  // 2: a body placeholder has bullets by default; levels; bold; buNone; empty paragraphs dropped.
  const body = flat(deck.slides[1])[1];
  assert.equal(body.role, "body");
  assert.deepEqual(body.paras.map((p) => [p.lvl, p.bullet]), [[0, "•"], [1, "•"], [0, "•"], [0, "•"], [0, null]]);
  assert.deepEqual(body.paras[0].runs[1], { t: "42%", b: true });
  assert.equal(body.paras[2].runs[0].href, "https://example.com/memo?a=1&b=2");
  assert.equal(body.paras[3].runs[0].href, undefined, "a javascript: link is dropped (the text stays)");
  assert.equal(body.paras[3].runs[0].t, "Do not click");
});

test("side by side stays side by side; tables, pictures, charts, SmartArt, groups", async () => {
  const deck = await lib.readDeck(sampleDeck());
  // 3: a text box and a picture with the same top form one row, left to right.
  const row = deck.slides[2].rows[1];
  assert.deepEqual(row.map((i) => i.kind), ["text", "image"]);
  assert.deepEqual(row[0].paras.map((p) => p.bullet), [null, "1.", "2."], "a text box has bullets only when asked");
  assert.equal(row[1].part, "ppt/media/image1.png");
  assert.equal(row[1].type, "image/png");
  assert.equal(row[1].alt, "Quarterly chart screenshot");
  const bytes = await deck.media(row[1].part);
  assert.deepEqual([...bytes.slice(1, 4)], [80, 78, 71]); // "PNG"

  // 4: the table: header row, a cell spanning two columns (the merged one skipped).
  const table = flat(deck.slides[3])[1];
  assert.equal(table.kind, "table");
  assert.equal(table.header, true);
  assert.deepEqual(table.rows.map((r) => r.map((c) => c.colspan)), [[1, 1, 1], [1, 1, 1], [2, 1]]);
  assert.equal(texts({ kind: "text", paras: table.rows[2][0].paras }), "Total (all regions)");

  // 5: a chart is named with its title; SmartArt is its nodes' text (not the doc node or connectors).
  const [chart, smart] = deck.slides[4].rows[1];
  assert.equal(chart.kind, "missing");
  assert.equal(chart.label, "Chart: Monthly active teams");
  assert.equal(texts(smart), "Discover\nDecide\nDeliver");

  // 6: hidden; a group's child mapped to slide space; an EMF named, not drawn.
  const s6 = deck.slides[5];
  assert.equal(s6.hidden, true);
  const [grouped, emf] = s6.rows[1];
  assert.equal(texts(grouped), "Inside a group");
  assert.deepEqual([grouped.box.x, grouped.box.cx], [457200, 4000000]);
  assert.equal(emf.kind, "missing");
  assert.match(emf.label, /^EMF picture/);
});

test("speaker notes, without the notes page's own slide number", async () => {
  const deck = await lib.readDeck(sampleDeck());
  assert.equal(deck.slides[0].notes, "Welcome everyone.\nKeep this under two minutes.");
  assert.equal(deck.slides[1].notes, "Mention the walrus discount.");
  assert.equal(deck.slides[2].notes, "");
  assert.doesNotMatch(deck.slides[3].notes, /\b3\b/);
});

/** A minimal deck: slide files named in one order, listed in another. */
function listedDeck(listOrder, extra = {}) {
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const slide = (t) => `<p:sld ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
  return {
    "ppt/presentation.xml": `<p:presentation ${NS}><p:sldIdLst>${listOrder.map((n, i) => `<p:sldId id="${256 + i}" r:id="r${n}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${listOrder.map((n) => `<Relationship Id="r${n}" Type="${R}" Target="slides/slide${n}.xml"/>`).join("")}</Relationships>`,
    ...Object.fromEntries(listOrder.map((n) => [`ppt/slides/slide${n}.xml`, slide(`File ${n}`)])),
    ...extra,
  };
}

test("numbered by the slide list (as the API's search is), not by file name; stored ZIPs read too", async () => {
  const deck = await lib.readDeck(zip(listedDeck([3, 1, 2]), { store: true }));
  assert.deepEqual(deck.slides.map((s) => [s.n, s.title]), [[1, "File 3"], [2, "File 1"], [3, "File 2"]]);
  // A prefix other than p: / a: (the namespace decides).
  const files = listedDeck([1]);
  files["ppt/slides/slide1.xml"] = files["ppt/slides/slide1.xml"]
    .replace(/<(\/?)p:/g, "<$1pp:").replace(/<(\/?)a:/g, "<$1dr:").replace("xmlns:p=", "xmlns:pp=").replace("xmlns:a=", "xmlns:dr=");
  assert.equal((await lib.readDeck(zip(files))).slides[0].title, "File 1");
});

test("?at= opens that slide, clamped to the deck", () => {
  assert.equal(lib.startSlide("3", 6), 3);
  assert.equal(lib.startSlide(99, 6), 6);
  for (const v of [0, -2, "abc", null, undefined, NaN]) assert.equal(lib.startSlide(v, 6), 1, String(v));
  assert.equal(lib.startSlide(2.7, 6), 2);
});

async function refused(bytes, re) {
  await assert.rejects(lib.readDeck(bytes), (e) => {
    assert.equal(e.deck, true, e.message);
    assert.match(e.message, re);
    return true;
  });
}

test("refused: DOCTYPE, macros, encrypted, password-protected, a ZIP bomb, not a deck", async () => {
  const doctype = listedDeck([1]);
  doctype["ppt/slides/slide1.xml"] = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]>' + doctype["ppt/slides/slide1.xml"];
  await refused(zip(doctype), /XML this viewer won't read/);
  await refused(zip(listedDeck([1], { "ppt/vbaProject.bin": "macro" })), /macros/);
  await refused(zip(listedDeck([1]), { flags: 1 }), /encrypted/);
  const ole = new Uint8Array(512);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await refused(ole, /password-protected/);
  await refused(zip({ ...listedDeck([1]), "ppt/media/zeros.bin": new Uint8Array(20 * 1024 * 1024) }), /expands too far/);
  await refused(zip({ "word/document.xml": "<w:document/>" }), /isn't a PowerPoint deck/);
  await refused(new TextEncoder().encode("just some text, not a zip"), /isn't a readable PowerPoint deck/);
});

const env = {
  ARTIFACT_SIGNING_KEY: "k",
  ARTIFACTS: {
    async head(key) {
      return key === "art/u1/deck.pptx"
        ? { size: 4, httpEtag: '"e"', httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }, customMetadata: { public: "1" } }
        : null;
    },
    async get(key) { return key === "art/u1/deck.pptx" ? { body: new Blob([new Uint8Array([80, 75, 3, 4])]).stream() } : null; },
  },
};
const get = (p, headers = {}) => worker.fetch(new Request(ORIGIN + p, { headers }), env);

test("the viewer page: this module's reader, ?at=, the download link, nothing unescaped from the query", async () => {
  const r = await get("/v/pptx/art/u1/deck.pptx?theme=dark&at=3&t=aa.bb_cc&fn=" + encodeURIComponent('Q3 deck</script><script>alert(1)</script>.pptx'));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /"src":"\/r\/art\/u1\/deck\.pptx\?t=aa\.bb_cc"/);
  assert.match(html, /"at":3/);
  assert.match(html, /"download":"\/r\/art\/u1\/deck\.pptx\?t=aa\.bb_cc&dl=1&fn=Q3%20deck%3C%2Fscript%3E/);
  assert.equal((html.match(/<\/script>/g) || []).length, 1, "the file name never closes the script");
  assert.doesNotMatch(html, /<!--/);
  const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new vm.Script(js));
  // The reader the page carries is this module's: run it on the sample deck.
  const libSrc = /\/\*pptx-lib\*\/([\s\S]*?)\/\*end-pptx-lib\*\//.exec(html)[1];
  const shipped = new Function(`${libSrc}; return PPTX;`)();
  const deck = await shipped.readDeck(sampleDeck());
  assert.equal(deck.slides[3].title, "Revenue by region");
  assert.equal(shipped.startSlide(3, deck.slides.length), 3);

  assert.match(await (await get("/v/pptx/art/u1/deck.pptx?at=-1")).text(), /"at":0/);
  assert.match(await (await get("/v/pptx/art/u1/deck.pptx?at=x")).text(), /"at":0/);
  assert.match(await (await get("/v/pptx/art/u1/deck.pptx")).text(), /"download":"\/r\/art\/u1\/deck\.pptx\?dl=1"/);
});

test("the viewer page opened on its own is sandboxed; the deck's bytes are served inline", async () => {
  const top = await get("/v/pptx/art/u1/deck.pptx", { "sec-fetch-dest": "document" });
  assert.equal(top.headers.get("content-security-policy"), "sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox");
  const framed = await get("/v/pptx/art/u1/deck.pptx", { "sec-fetch-dest": "iframe" });
  assert.equal(framed.headers.get("content-security-policy"), null);
  const raw = await get("/r/art/u1/deck.pptx");
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-disposition"), "inline");
  const dl = await get("/r/art/u1/deck.pptx?dl=1&fn=Board.pptx");
  assert.match(dl.headers.get("content-disposition"), /^attachment; filename="Board\.pptx"/);
});
