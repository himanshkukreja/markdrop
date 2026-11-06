/**
 * Test decks for the slide viewer (worker/src/pptx.js): a small but realistic .pptx built in memory
 * (content types, a layout and master with placeholder positions, notes, a picture, a table, a chart,
 * SmartArt, a group and a hidden slide), plus the ZIP writer the refusal tests use.
 *
 *   node worker/test/pptx-fixture.mjs out.pptx     writes the sample deck (for screenshots)
 */
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

const enc = new TextEncoder();

/** {name: string | Uint8Array} → a ZIP (deflate, or stored with `store`); `flags` sets bit 0 (encrypted). */
export function zip(files, { store = false, flags = 0 } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const packed = store ? data : zlib.deflateRawSync(data);
    const nameBytes = enc.encode(name);
    const crc = zlib.crc32(data);
    const method = store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(packed.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBytes.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBytes, packed);
    centrals.push(ch, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const W = 12192000, H = 6858000;

const xfrm = (x, y, cx, cy, tag = "a:xfrm") => `<${tag}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></${tag}>`;
const ph = (type, idx) => `<p:nvPr><p:ph${type ? ` type="${type}"` : ""}${idx ? ` idx="${idx}"` : ""}/></p:nvPr>`;
const run = (t, attrs = "", extra = "") => `<a:r><a:rPr lang="en-US"${attrs}>${extra}</a:rPr><a:t>${t}</a:t></a:r>`;
const para = (inner, ppr = "") => `<a:p>${ppr}${inner}</a:p>`;
function sp({ id, name, type, idx, box, paras, txBox = false }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${txBox ? ' txBox="1"' : ""}/>` +
    `${type !== undefined || idx ? ph(type, idx) : "<p:nvPr/>"}</p:nvSpPr><p:spPr>${box ? xfrm(...box) : ""}</p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paras.join("")}</p:txBody></p:sp>`;
}
const slideXml = (shapes, attrs = "") =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${NS}${attrs}><p:cSld><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join("")}` +
  `</p:spTree></p:cSld></p:sld>`;
const rels = (list) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}">` +
  list.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${ext ? ' TargetMode="External"' : ""}/>`).join("") +
  `</Relationships>`;
const notesXml = (text) =>
  `<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
  sp({ id: 2, name: "Slide Image", type: "sldImg", paras: [] }).replace("<p:txBody><a:bodyPr/><a:lstStyle/></p:txBody>", "") +
  sp({ id: 3, name: "Notes", type: "body", idx: "1", paras: text.split("\n").map((l) => para(run(l))) }) +
  sp({ id: 4, name: "Slide Number", type: "sldNum", idx: "5", paras: [para(`<a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld>`)] }) +
  `</p:spTree></p:cSld></p:notes>`;

// A 4×3 PNG (opaque blue), so the picture has bytes a browser can draw.
export const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNQTX4NRww4OQBKDBFlIRMo1wAAAABJRU5ErkJggg==", "base64"));

/** The sample deck: 6 slides (the 6th hidden), notes on 1, 2 and 4, plus `extra` files. */
export function sampleDeck({ extra = {}, slides: only, contentTypes } = {}) {
  const S = [];
  // 1. Title slide: placeholders without their own position (the layout's).
  S.push({
    xml: slideXml([
      sp({ id: 2, name: "Title 1", type: "ctrTitle", paras: [para(run("Q3 Board Review"))] }),
      sp({ id: 3, name: "Subtitle 2", type: "subTitle", idx: "1", paras: [para(run("Markdrop &amp; friends · October 2026"))] }),
      sp({ id: 4, name: "Date", type: "dt", idx: "10", paras: [para(run("10/14/2026"))] }),
    ]),
    notes: "Welcome everyone.\nKeep this under two minutes.",
  });
  // 2. Bullets: a body placeholder (bullets by default), levels, runs, links (one unsafe), buNone.
  S.push({
    xml: slideXml([
      sp({ id: 2, name: "Title", type: "title", paras: [para(run("Highlights"))] }),
      sp({ id: 3, name: "Content", idx: "1", paras: [
        para(run("Revenue up ") + run("42%", ' b="1"') + run(" quarter on quarter")),
        para(run("Brazil launch on track"), '<a:pPr lvl="1"/>'),
        para(run("Read the memo", "", '<a:hlinkClick r:id="rIdL1"/>')),
        para(run("Do not click", "", '<a:hlinkClick r:id="rIdL2"/>')),
        para(run("Plain closing line"), '<a:pPr><a:buNone/></a:pPr>'),
        para(""),
      ] }),
    ]),
    rels: [["rIdL1", "hyperlink", "https://example.com/memo?a=1&amp;b=2", true], ["rIdL2", "hyperlink", "javascript:alert(1)", true]],
    notes: "Mention the walrus discount.",
  });
  // 3. Two columns: a text box on the left, a picture on the right (same top).
  S.push({
    xml: slideXml([
      sp({ id: 2, name: "Title", type: "title", paras: [para(run("Plan vs actual"))] }),
      sp({ id: 3, name: "TextBox 3", txBox: true, box: [457200, 1600200, 5000000, 3000000], paras: [
        para(run("1. Ship pages"), ""), para(run("Numbered"), '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
        para(run("Again"), '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
      ] }),
      `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 4" descr="Quarterly chart screenshot"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill><p:spPr>${xfrm(6400800, 1600200, 4800000, 3600000)}</p:spPr></p:pic>`,
    ]),
    rels: [["rIdImg", "image", "../media/image1.png"]],
  });
  // 4. A table with a header row and a merged cell.
  const tc = (t, attrs = "") => `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${para(run(t))}</a:txBody><a:tcPr/></a:tc>`;
  S.push({
    xml: slideXml([
      sp({ id: 2, name: "Title", type: "title", paras: [para(run("Revenue by region"))] }),
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Table 4"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `${xfrm(457200, 1600200, 11000000, 2000000, "p:xfrm")}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
      `<a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/><a:gridCol w="3000000"/></a:tblGrid>` +
      `<a:tr h="370840">${tc("Region")}${tc("Q2")}${tc("Q3")}</a:tr>` +
      `<a:tr h="370840">${tc("LATAM")}${tc("1.2M")}${tc("1.7M")}</a:tr>` +
      `<a:tr h="370840">${tc("Total (all regions)", ' gridSpan="2"')}${tc("", ' hMerge="1"')}${tc("4.9M")}</a:tr>` +
      `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    ]),
    notes: "Total excludes one-offs.",
  });
  // 5. A chart and SmartArt.
  S.push({
    xml: slideXml([
      sp({ id: 2, name: "Title", type: "title", paras: [para(run("Growth"))] }),
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `${xfrm(457200, 1600200, 5000000, 4000000, "p:xfrm")}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
      `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdC"/></a:graphicData></a:graphic></p:graphicFrame>`,
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `${xfrm(6400800, 1600200, 5000000, 4000000, "p:xfrm")}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">` +
      `<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rIdD" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/>` +
      `</a:graphicData></a:graphic></p:graphicFrame>`,
    ]),
    rels: [["rIdC", "chart", "../charts/chart1.xml"], ["rIdD", "diagramData", "../diagrams/data1.xml"]],
  });
  // 6. Hidden: a group (child space scaled) and an EMF picture a browser can't draw.
  S.push({
    attrs: ' show="0"',
    xml: null,
    shapes: [
      sp({ id: 2, name: "Title", type: "title", paras: [para(run("Appendix"))] }),
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="8" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="4000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="8000000" cy="4000000"/></a:xfrm></p:grpSpPr>` +
      sp({ id: 9, name: "Grouped", txBox: true, box: [0, 0, 8000000, 4000000], paras: [para(run("Inside a group"))] }) +
      `</p:grpSp>`,
      `<p:pic><p:nvPicPr><p:cNvPr id="10" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdE"/></p:blipFill>` +
      `<p:spPr>${xfrm(6400800, 1600200, 2000000, 2000000)}</p:spPr></p:pic>`,
    ],
    rels: [["rIdE", "image", "../media/image2.emf"]],
  });
  S[5].xml = slideXml(S[5].shapes, S[5].attrs);

  const use = only ? S.slice(0, only) : S;
  const files = {
    "[Content_Types].xml": contentTypes ?? (`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`),
    "_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${use.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join("")}</p:sldIdLst>` +
      `<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels([["rIdM", "slideMaster", "slideMasters/slideMaster1.xml"],
      ...use.map((_, i) => [`rIdS${i + 1}`, "slide", `slides/slide${i + 1}.xml`])]),
    "ppt/slideMasters/slideMaster1.xml": slideXml([
      sp({ id: 2, name: "Title", type: "title", box: [457200, 274638, 11277600, 1143000], paras: [] }),
      sp({ id: 3, name: "Body", type: "body", idx: "1", box: [457200, 1600200, 11277600, 4525963], paras: [] }),
    ]).replace("<p:sld ", "<p:sldMaster ").replace("</p:sld>", "</p:sldMaster>"),
    "ppt/slideLayouts/slideLayout1.xml": slideXml([
      sp({ id: 2, name: "Title", type: "ctrTitle", box: [914400, 2130425, 10363200, 1470025], paras: [] }),
      sp({ id: 3, name: "Subtitle", type: "subTitle", idx: "1", box: [1828800, 3886200, 8534400, 1752600], paras: [] }),
    ]).replace("<p:sld ", "<p:sldLayout ").replace("</p:sld>", "</p:sldLayout>"),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/slideLayouts/slideLayout2.xml": slideXml([
      sp({ id: 2, name: "Title", type: "title", box: [457200, 274638, 11277600, 1143000], paras: [] }),
      sp({ id: 3, name: "Content", idx: "1", box: [457200, 1600200, 11277600, 4525963], paras: [] }),
    ]).replace("<p:sld ", "<p:sldLayout ").replace("</p:sld>", "</p:sldLayout>"),
    "ppt/slideLayouts/_rels/slideLayout2.xml.rels": rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/media/image1.png": PNG,
    "ppt/media/image2.emf": new Uint8Array([1, 0, 0, 0]),
    "ppt/charts/chart1.xml": `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Monthly active teams</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>`,
    "ppt/diagrams/data1.xml": `<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>` +
      `<dgm:pt modelId="0" type="doc"><dgm:t><a:p><a:r><a:t>ignored doc node</a:t></a:r></a:p></dgm:t></dgm:pt>` +
      ["Discover", "Decide", "Deliver"].map((t, i) => `<dgm:pt modelId="${i + 1}"><dgm:t><a:bodyPr/><a:p><a:r><a:t>${t}</a:t></a:r></a:p></dgm:t></dgm:pt>`).join("") +
      `<dgm:pt modelId="9" type="parTrans"><dgm:t><a:p><a:r><a:t>connector</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`,
  };
  use.forEach((s, i) => {
    const n = i + 1;
    files[`ppt/slides/slide${n}.xml`] = s.xml;
    const list = [["rIdLay", "slideLayout", `../slideLayouts/slideLayout${n === 1 ? 1 : 2}.xml`], ...(s.rels || [])];
    if (s.notes) {
      list.push(["rIdN", "notesSlide", `../notesSlides/notesSlide${n}.xml`]);
      files[`ppt/notesSlides/notesSlide${n}.xml`] = notesXml(s.notes);
    }
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = rels(list);
  });
  return zip({ ...files, ...extra });
}

if (process.argv[1] && process.argv[1].endsWith("pptx-fixture.mjs") && process.argv[2]) {
  writeFileSync(process.argv[2], sampleDeck());
  console.log("wrote", process.argv[2]);
}
