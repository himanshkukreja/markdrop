/**
 * PowerPoint (.pptx) slide viewer for the artifact origin: `/v/pptx/<key>`.
 *
 * No conversion server (no LibreOffice): the viewer page fetches the deck's bytes from /r/ and reads
 * them in the browser. `pptxLib` is that reader. It is written as one self-contained function so the
 * page can carry its source (`(${pptxLib})()`) and the Worker's tests can run the very same code in
 * Node (worker/test/pptx.test.mjs). It must not reference anything outside itself.
 *
 * What a slide becomes (layout approximated, never pixel-perfect):
 *   - its title, then its shapes in reading order (top to bottom; shapes side by side stay side by
 *     side, as columns), text boxes with their bullets and indent levels, bold / italic / underline
 *     and http(s) / mailto links;
 *   - tables as simple tables (merged cells kept), pictures from ppt/media (PNG, JPEG, GIF, WebP,
 *     BMP, SVG; EMF / WMF and other formats a browser can't draw are named instead), SmartArt as
 *     its text, a chart as a labelled box with its title;
 *   - the speaker notes, hidden slides marked as such.
 *
 * Untrusted bytes, the same guards as the API's services/file_text.py: a ZIP with too many parts, one
 * that claims or inflates past the budget or compresses more than ZIP_MAX_RATIO to one (a ZIP bomb),
 * an encrypted one (a password-protected deck is not a ZIP at all), XML carrying a DOCTYPE, and a
 * macro deck (.pptm, renamed or not) are all refused; macros are never opened. Text reaches the page
 * only as text (the UI builds DOM nodes, never HTML strings), and a link only when it is http(s) or
 * mailto.
 */

/* eslint-disable no-var */
export function pptxLib() {
  "use strict";
  var ZIP_MAX_ENTRIES = 5000;
  var ZIP_MAX_TOTAL = 120 * 1024 * 1024;
  var ZIP_MAX_MEMBER = 40 * 1024 * 1024;
  var ZIP_MAX_RATIO = 250;
  var SLIDES_MAX = 400;
  var DEFAULT_W = 12192000, DEFAULT_H = 6858000; // 16:9, in EMU

  function DeckError(message) {
    var e = new Error(message);
    e.deck = true;
    return e;
  }

  // ── ZIP ─────────────────────────────────────────────────────────────────────

  function isOle(buf) {
    return buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
  }

  function zipIndex(buf) {
    if (isOle(buf)) throw DeckError("This deck is password-protected, so it can't be shown here. Download it to open it.");
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var eocd = -1;
    for (var i = buf.length - 22; i >= 0 && i >= buf.length - 65557; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw DeckError("This file isn't a readable PowerPoint deck.");
    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOff === 0xffffffff) throw DeckError("This deck is too large to show here. Download it to open it.");
    if (count > ZIP_MAX_ENTRIES) throw DeckError("This deck has too many parts to show here.");
    var dec = new TextDecoder();
    var entries = Object.create(null), names = [], p = cdOff, claimed = 0, packed = 0;
    for (var k = 0; k < count; k++) {
      if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw DeckError("This deck is damaged.");
      var flags = dv.getUint16(p + 8, true);
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
      if (flags & 1) throw DeckError("This deck is encrypted, so it can't be shown here. Download it to open it.");
      entries[name] = { method: method, csize: csize, usize: usize, lho: lho };
      names.push(name);
      claimed += usize;
      packed += csize;
      p += 46 + nlen + xlen + clen;
    }
    if (claimed > ZIP_MAX_TOTAL * 4 || claimed / Math.max(1, packed) > ZIP_MAX_RATIO) {
      throw DeckError("This deck expands too far to show here.");
    }
    return { buf: buf, dv: dv, entries: entries, names: names, used: 0 };
  }

  async function inflateRaw(data, limit) {
    var reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    var chunks = [], n = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      n += r.value.length;
      if (n > limit) {
        try { await reader.cancel(); } catch (_) { /* already closed */ }
        throw DeckError("This deck expands too far to show here.");
      }
      chunks.push(r.value);
    }
    var out = new Uint8Array(n), o = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
    return out;
  }

  async function zipRead(z, name) {
    var e = z.entries[name];
    if (!e) return null;
    if (e.usize > ZIP_MAX_MEMBER || (e.csize && e.usize / e.csize > ZIP_MAX_RATIO * 4)) {
      throw DeckError("A part of this deck is too large to show here.");
    }
    var p = e.lho;
    if (p + 30 > z.buf.length || z.dv.getUint32(p, true) !== 0x04034b50) throw DeckError("This deck is damaged.");
    var start = p + 30 + z.dv.getUint16(p + 26, true) + z.dv.getUint16(p + 28, true);
    if (start + e.csize > z.buf.length) throw DeckError("This deck is damaged.");
    var raw = z.buf.subarray(start, start + e.csize);
    var budget = Math.min(ZIP_MAX_MEMBER, ZIP_MAX_TOTAL - z.used);
    var out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = await inflateRaw(raw, budget);
    else throw DeckError("This deck uses a compression this viewer can't read.");
    if (out.length > budget) throw DeckError("This deck expands too far to show here.");
    z.used += out.length;
    return out;
  }

  // ── XML ─────────────────────────────────────────────────────────────────────

  // Namespaces by URI → the short prefix the reader uses, whatever prefix the file chose
  // (transitional and strict OOXML alike).
  var NS = {
    "http://schemas.openxmlformats.org/presentationml/2006/main": "p",
    "http://purl.oclc.org/ooxml/presentationml/main": "p",
    "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
    "http://purl.oclc.org/ooxml/drawingml/main": "a",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
    "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
    "http://schemas.openxmlformats.org/package/2006/relationships": "pr",
    "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
    "http://schemas.openxmlformats.org/drawingml/2006/diagram": "dgm",
    "http://purl.oclc.org/ooxml/drawingml/diagram": "dgm",
    "http://schemas.openxmlformats.org/drawingml/2006/chart": "c",
    "http://purl.oclc.org/ooxml/drawingml/chart": "c",
    "http://schemas.openxmlformats.org/package/2006/content-types": "ct",
  };
  var ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

  function unescapeXml(s) {
    if (s.indexOf("&") < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, function (_, e) {
      if (e[0] === "#") {
        var cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
      }
      return ENT[e];
    });
  }

  function qname(raw, scope, isAttr) {
    var c = raw.indexOf(":");
    var prefix = c < 0 ? "" : raw.slice(0, c), local = c < 0 ? raw : raw.slice(c + 1);
    if (isAttr && !prefix) return local;            // an unprefixed attribute has no namespace
    var uri = scope[prefix];
    if (!uri) return local;
    return (NS[uri] || "x") + ":" + local;
  }

  // (Comments as <!-{2}…-{2}>: this source sits in an inline <script>, which must never hold "<!" + "--".)
  var TOKEN = /<!-{2}[\s\S]*?-{2}>|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s\/>!?]+)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  var ATTR = /([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  /** A small, strict-enough XML reader: elements {name, attrs, kids}, text as strings in kids. */
  function parseXml(text) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw DeckError("This deck contains XML this viewer won't read.");
    var root = { name: "#root", attrs: {}, kids: [] };
    var stack = [root], scopes = [{ xml: "http://www.w3.org/XML/1998/namespace" }];
    TOKEN.lastIndex = 0;
    var m;
    while ((m = TOKEN.exec(text))) {
      var top = stack[stack.length - 1];
      if (m[6] !== undefined) {                       // character data
        if (stack.length > 1) top.kids.push(unescapeXml(m[6]));
      } else if (m[1] !== undefined) {                // CDATA
        top.kids.push(m[1]);
      } else if (m[3] !== undefined) {                // a tag
        if (m[2] === "/") {
          if (stack.length > 1) { stack.pop(); scopes.pop(); }
          continue;
        }
        var rawAttrs = [], decl = null, a;
        ATTR.lastIndex = 0;
        while ((a = ATTR.exec(m[4]))) {
          var an = a[1], av = unescapeXml(a[2] !== undefined ? a[2] : a[3]);
          if (an === "xmlns" || an.slice(0, 6) === "xmlns:") {
            decl = decl || Object.create(scopes[scopes.length - 1]);
            decl[an === "xmlns" ? "" : an.slice(6)] = av;
          } else rawAttrs.push([an, av]);
        }
        var scope = decl || scopes[scopes.length - 1];
        var attrs = {};
        for (var i = 0; i < rawAttrs.length; i++) attrs[qname(rawAttrs[i][0], scope, true)] = rawAttrs[i][1];
        var el = { name: qname(m[3], scope, false), attrs: attrs, kids: [] };
        top.kids.push(el);
        if (m[5] !== "/") { stack.push(el); scopes.push(scope); }
      } else if (m[7] !== undefined) {
        throw DeckError("This deck contains XML this viewer can't read.");
      }
    }
    var first = root.kids.filter(function (k) { return typeof k !== "string"; })[0];
    if (!first) throw DeckError("This deck contains XML this viewer can't read.");
    return first;
  }

  function els(el) { return el ? el.kids.filter(function (k) { return typeof k !== "string"; }) : []; }
  function kids(el, name) { return els(el).filter(function (k) { return k.name === name; }); }
  function kid(el, name) {
    if (!el) return null;
    for (var i = 0; i < el.kids.length; i++) if (el.kids[i].name === name) return el.kids[i];
    return null;
  }
  function path(el) {
    for (var i = 1; i < arguments.length && el; i++) el = kid(el, arguments[i]);
    return el || null;
  }
  function all(el, name, out) {
    out = out || [];
    els(el).forEach(function (k) {
      if (k.name === name) out.push(k);
      all(k, name, out);
    });
    return out;
  }
  function textOf(el) {
    if (!el) return "";
    var s = "";
    el.kids.forEach(function (k) { s += typeof k === "string" ? k : textOf(k); });
    return s;
  }

  // ── Package ─────────────────────────────────────────────────────────────────

  function resolve(base, target) {
    if (target[0] === "/") return target.slice(1);
    var parts = base.split("/");
    parts.pop();
    target.split("/").forEach(function (seg) {
      if (seg === "..") parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    });
    return parts.join("/");
  }

  async function xmlPart(z, name) {
    var bytes = await zipRead(z, name);
    return bytes ? parseXml(new TextDecoder().decode(bytes)) : null;
  }

  /** {id: {target, external, type}} for a part's relationships. */
  async function relsOf(z, part) {
    var i = part.lastIndexOf("/");
    var rp = part.slice(0, i + 1) + "_rels/" + part.slice(i + 1) + ".rels";
    var out = Object.create(null);
    var doc = z.entries[rp] ? await xmlPart(z, rp) : null;
    els(doc).forEach(function (r) {
      var id = r.attrs.Id, t = r.attrs.Target || "";
      if (!id) return;
      var external = r.attrs.TargetMode === "External";
      out[id] = { target: external ? t : resolve(part, t), external: external, type: r.attrs.Type || "" };
    });
    return out;
  }

  var MEDIA_TYPES = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  };
  function mediaType(name) {
    var ext = (name.split(".").pop() || "").toLowerCase();
    return MEDIA_TYPES[ext] || null;
  }

  function safeHref(href) {
    var h = String(href || "").trim();
    return /^(https?:|mailto:)/i.test(h) ? h : null;
  }

  // ── Slides ──────────────────────────────────────────────────────────────────

  function num(v, d) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : d;
  }

  function xfrmOf(el) {
    // <a:xfrm> under spPr / grpSpPr, or <p:xfrm> on a graphic frame.
    if (!el) return null;
    var off = kid(el, "a:off"), ext = kid(el, "a:ext");
    if (!off && !ext) return null;
    return {
      x: num(off && off.attrs.x, 0), y: num(off && off.attrs.y, 0),
      cx: num(ext && ext.attrs.cx, 0), cy: num(ext && ext.attrs.cy, 0),
      chOff: kid(el, "a:chOff"), chExt: kid(el, "a:chExt"),
    };
  }

  /** Map a child's box through its group's transform (group child space → slide space). */
  function through(box, groups) {
    for (var i = groups.length - 1; i >= 0; i--) {
      var g = groups[i];
      if (!g || !g.chOff || !g.chExt) continue;
      var cox = num(g.chOff.attrs.x, 0), coy = num(g.chOff.attrs.y, 0);
      var cex = num(g.chExt.attrs.cx, 0) || 1, cey = num(g.chExt.attrs.cy, 0) || 1;
      var sx = g.cx / cex, sy = g.cy / cey;
      box = { x: g.x + (box.x - cox) * sx, y: g.y + (box.y - coy) * sy, cx: box.cx * sx, cy: box.cy * sy };
    }
    return box;
  }

  function phOf(nv) {
    var ph = path(nv, "p:nvPr", "p:ph");
    if (!ph) return null;
    return { type: ph.attrs.type || "", idx: ph.attrs.idx || "" };
  }

  /** Placeholder positions of a layout (or master), keyed "type:<t>" and "idx:<n>". */
  async function placeholderBoxes(z, part) {
    var out = Object.create(null);
    var doc = z.entries[part] ? await xmlPart(z, part) : null;
    var tree = path(doc, "p:cSld", "p:spTree");
    all(tree, "p:sp").forEach(function (sp) {
      var ph = phOf(kid(sp, "p:nvSpPr"));
      var box = xfrmOf(path(sp, "p:spPr", "a:xfrm"));
      if (!ph || !box) return;
      if (ph.idx && !out["idx:" + ph.idx]) out["idx:" + ph.idx] = box;
      var t = ph.type || "body";
      if (!out["type:" + t]) out["type:" + t] = box;
    });
    return out;
  }

  function runsOf(p, rels) {
    var runs = [];
    els(p).forEach(function (k) {
      if (k.name === "a:r" || k.name === "a:fld") {
        var t = textOf(kid(k, "a:t"));
        if (!t) return;
        var pr = kid(k, "a:rPr");
        var a = pr ? pr.attrs : {};
        var run = { t: t };
        if (a.b === "1" || a.b === "true") run.b = true;
        if (a.i === "1" || a.i === "true") run.i = true;
        if (a.u && a.u !== "none") run.u = true;
        if (a.strike && a.strike !== "noStrike") run.s = true;
        if (a.sz) run.sz = num(a.sz, 0) / 100;
        var link = kid(pr, "a:hlinkClick");
        var rid = link && link.attrs["r:id"];
        var rel = rid && rels[rid];
        var href = rel && rel.external ? safeHref(rel.target) : null;
        if (href) run.href = href;
        runs.push(run);
      } else if (k.name === "a:br") {
        runs.push({ br: true });
      }
    });
    return runs;
  }

  /** a:p → {lvl, bullet, align, runs, sz}. `bulleted`: a body placeholder (bullets unless buNone). */
  function parasOf(txBody, rels, bulleted) {
    var out = [], counters = [];
    kids(txBody, "a:p").forEach(function (p) {
      var pr = kid(p, "a:pPr");
      var a = pr ? pr.attrs : {};
      var lvl = Math.max(0, Math.min(8, num(a.lvl, 0)));
      var runs = runsOf(p, rels);
      var text = runs.map(function (r) { return r.t || ""; }).join("").trim();
      if (!text) { counters.length = 0; return; }
      var bullet = null;
      var buChar = kid(pr, "a:buChar"), buNum = kid(pr, "a:buAutoNum");
      if (kid(pr, "a:buNone")) bullet = null;
      else if (buNum) {
        counters.length = lvl + 1;
        var start = num(buNum.attrs.startAt, 1);
        counters[lvl] = counters[lvl] ? counters[lvl] + 1 : start;
        bullet = numbering(counters[lvl], buNum.attrs.type || "arabicPeriod");
      } else if (buChar) bullet = (buChar.attrs.char || "•").slice(0, 2);
      else if (bulleted) bullet = "•";
      if (!buNum) counters.length = lvl;
      var sizes = runs.map(function (r) { return r.sz || 0; }).filter(Boolean);
      out.push({
        lvl: lvl, bullet: bullet, align: { ctr: "center", r: "right", just: "justify" }[a.algn] || null,
        runs: runs, sz: sizes.length ? Math.max.apply(null, sizes) : null,
      });
    });
    return out;
  }

  function numbering(n, type) {
    var core = String(n);
    if (/^alphaLc/.test(type)) core = alpha(n).toLowerCase();
    else if (/^alphaUc/.test(type)) core = alpha(n);
    else if (/^romanLc/.test(type)) core = roman(n).toLowerCase();
    else if (/^romanUc/.test(type)) core = roman(n);
    if (/ParenBoth$/.test(type)) return "(" + core + ")";
    if (/ParenR$/.test(type)) return core + ")";
    if (/Plain$/.test(type)) return core;
    return core + ".";
  }
  function alpha(n) {
    var s = "";
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s || "A";
  }
  function roman(n) {
    var v = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    var r = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
    var s = "";
    for (var i = 0; i < v.length; i++) while (n >= v[i]) { s += r[i]; n -= v[i]; }
    return s;
  }

  var SKIP_PH = { dt: 1, ftr: 1, sldNum: 1, hdr: 1, sldImg: 1 };

  async function walk(z, tree, rels, ctx, groups, out) {
    for (var i = 0; i < tree.kids.length; i++) {
      var el = tree.kids[i];
      if (typeof el === "string") continue;
      if (el.name === "mc:AlternateContent") {
        // The legacy rendering (Fallback) when there is one: the reader knows its elements.
        var pick = kid(el, "mc:Fallback") || kid(el, "mc:Choice");
        if (pick) await walk(z, pick, rels, ctx, groups, out);
      } else if (el.name === "p:grpSp") {
        var g = xfrmOf(path(el, "p:grpSpPr", "a:xfrm"));
        await walk(z, el, rels, ctx, groups.concat([g]), out);
      } else if (el.name === "p:sp") {
        shape(el, rels, ctx, groups, out);
      } else if (el.name === "p:pic") {
        picture(el, rels, ctx, groups, out);
      } else if (el.name === "p:graphicFrame") {
        await frame(z, el, rels, ctx, groups, out);
      }
    }
  }

  function boxFor(own, ph, ctx, groups) {
    var box = own;
    if (!box && ph) box = ctx.layout[ph.idx ? "idx:" + ph.idx : ""] || ctx.layout["type:" + (ph.type || "body")] ||
      ctx.master["type:" + (ph.type || "body")] || null;
    if (!box) return null;
    return own ? through(box, groups) : box;
  }

  function shape(sp, rels, ctx, groups, out) {
    var ph = phOf(kid(sp, "p:nvSpPr"));
    if (ph && SKIP_PH[ph.type]) return;
    var tx = kid(sp, "p:txBody");
    if (!tx) return;
    var role = !ph ? "text"
      : ph.type === "title" || ph.type === "ctrTitle" ? "title"
      : ph.type === "subTitle" ? "subtitle"
      : "body";
    var paras = parasOf(tx, rels, role === "body");
    if (!paras.length) return;
    var box = boxFor(xfrmOf(path(sp, "p:spPr", "a:xfrm")), ph, ctx, groups);
    out.push({ kind: "text", role: role, centered: ph && ph.type === "ctrTitle", paras: paras, box: box });
  }

  function picture(pic, rels, ctx, groups, out) {
    var nv = path(pic, "p:nvPicPr", "p:cNvPr");
    var alt = nv ? (nv.attrs.descr || nv.attrs.title || "").trim() : "";
    var blip = path(pic, "p:blipFill", "a:blip");
    var rid = blip && blip.attrs["r:embed"];
    var rel = rid && rels[rid];
    var box = boxFor(xfrmOf(path(pic, "p:spPr", "a:xfrm")), phOf(kid(pic, "p:nvPicPr")), ctx, groups);
    if (!rel || rel.external) {
      out.push({ kind: "missing", label: alt ? "Picture: " + alt : "Linked picture (not in the file)", box: box });
      return;
    }
    var type = mediaType(rel.target);
    if (!type) {
      var ext = (rel.target.split(".").pop() || "").toUpperCase();
      out.push({ kind: "missing", label: (ext ? ext + " picture" : "Picture") + (alt ? ": " + alt : "") + " (download to see it)", box: box });
      return;
    }
    out.push({ kind: "image", part: rel.target, type: type, alt: alt, box: box });
  }

  async function frame(z, gf, rels, ctx, groups, out) {
    var box = boxFor(xfrmOf(kid(gf, "p:xfrm")), phOf(kid(gf, "p:nvGraphicFramePr")), ctx, groups);
    var data = path(gf, "a:graphic", "a:graphicData");
    if (!data) return;
    var uri = data.attrs.uri || "";
    var tbl = kid(data, "a:tbl");
    if (tbl) {
      var header = path(tbl, "a:tblPr") && path(tbl, "a:tblPr").attrs.firstRow === "1";
      var rows = kids(tbl, "a:tr").map(function (tr) {
        var cells = [];
        kids(tr, "a:tc").forEach(function (tc) {
          if (tc.attrs.hMerge === "1" || tc.attrs.vMerge === "1") return;
          cells.push({
            paras: parasOf(kid(tc, "a:txBody"), rels, false),
            colspan: Math.max(1, Math.min(50, num(tc.attrs.gridSpan, 1))),
            rowspan: Math.max(1, Math.min(500, num(tc.attrs.rowSpan, 1))),
          });
        });
        return cells;
      }).filter(function (r) { return r.length; });
      if (rows.length) out.push({ kind: "table", header: !!header, rows: rows, box: box });
      return;
    }
    if (/\/chart$/.test(uri)) {
      var c = kid(data, "c:chart");
      var rel = c && rels[c.attrs["r:id"]];
      var title = "";
      if (rel && !rel.external && z.entries[rel.target]) {
        try {
          var chart = await xmlPart(z, rel.target);
          title = all(path(chart, "c:chart", "c:title"), "a:t").map(textOf).join("").trim();
        } catch (e) { if (!e.deck) throw e; }
      }
      out.push({ kind: "missing", label: title ? "Chart: " + title : "Chart", chart: true, box: box });
      return;
    }
    if (/\/diagram$/.test(uri)) {
      // SmartArt: its text, from the diagram's data part, as bullets.
      var ids = kid(data, "dgm:relIds");
      var drel = ids && rels[ids.attrs["r:dm"]];
      var lines = [];
      if (drel && !drel.external && z.entries[drel.target]) {
        var dm = await xmlPart(z, drel.target);
        all(path(dm, "dgm:ptLst"), "dgm:pt").forEach(function (pt) {
          if (pt.attrs.type && pt.attrs.type !== "node") return;
          var t = all(pt, "a:t").map(textOf).join("").trim();
          if (t) lines.push(t);
        });
      }
      if (lines.length) {
        out.push({ kind: "text", role: "text", paras: lines.slice(0, 200).map(function (t) {
          return { lvl: 0, bullet: "•", align: null, runs: [{ t: t }], sz: null };
        }), box: box });
      }
      return;
    }
    // An embedded object or anything else: its picture when the frame carries one.
    var inner = all(gf, "p:pic")[0];
    if (inner) picture(inner, rels, ctx, groups, out);
  }

  /** Reading order: top to bottom, and shapes that sit side by side form one row (columns). */
  function rowsOf(items, slideH) {
    var placed = items.filter(function (it) { return it.box; });
    var loose = items.filter(function (it) { return !it.box; });
    placed.sort(function (a, b) { return a.box.y - b.box.y || a.box.x - b.box.x; });
    var rows = [], tol = slideH * 0.02;
    placed.forEach(function (it) {
      var row = rows[rows.length - 1];
      var fits = row && it.box.y < row.bottom - tol && row.items.every(function (o) {
        return it.box.x >= o.box.x + o.box.cx - tol || it.box.x + it.box.cx <= o.box.x + tol;
      });
      if (fits) {
        row.items.push(it);
        row.bottom = Math.max(row.bottom, it.box.y + it.box.cy);
      } else {
        rows.push({ items: [it], bottom: it.box.y + it.box.cy });
      }
    });
    rows.forEach(function (r) { r.items.sort(function (a, b) { return a.box.x - b.box.x; }); });
    loose.forEach(function (it) { rows.push({ items: [it], bottom: 0 }); });
    // The title leads, wherever its shape sits.
    var ti = -1;
    for (var i = 0; i < rows.length && ti < 0; i++) {
      if (rows[i].items.some(function (it) { return it.role === "title"; })) ti = i;
    }
    if (ti > 0) rows.unshift(rows.splice(ti, 1)[0]);
    return rows.map(function (r) { return r.items; });
  }

  function plain(items) {
    return items.map(function (it) {
      if (it.kind !== "text") return "";
      return it.paras.map(function (p) { return p.runs.map(function (r) { return r.br ? "\n" : r.t; }).join(""); }).join("\n");
    }).join("\n").trim();
  }

  async function readSlide(z, part, n, size) {
    var doc = await xmlPart(z, part);
    var rels = await relsOf(z, part);
    var layoutPart = null, notesPart = null;
    Object.keys(rels).forEach(function (id) {
      var r = rels[id];
      if (r.external) return;
      if (/\/slideLayout$/.test(r.type) || /slideLayouts\//.test(r.target)) layoutPart = layoutPart || r.target;
      if (/\/notesSlide$/.test(r.type) || /notesSlides\//.test(r.target)) notesPart = notesPart || r.target;
    });
    var ctx = { layout: Object.create(null), master: Object.create(null) };
    if (layoutPart) {
      ctx.layout = await placeholderBoxes(z, layoutPart);
      var lrels = await relsOf(z, layoutPart);
      for (var id in lrels) {
        if (!lrels[id].external && /slideMasters\//.test(lrels[id].target)) {
          if (!size.masters[lrels[id].target]) size.masters[lrels[id].target] = await placeholderBoxes(z, lrels[id].target);
          ctx.master = size.masters[lrels[id].target];
          break;
        }
      }
    }
    var items = [];
    var tree = path(doc, "p:cSld", "p:spTree");
    if (tree) await walk(z, tree, rels, ctx, [], items);
    var rows = rowsOf(items, size.cy);
    var titleItem = items.filter(function (it) { return it.role === "title"; })[0];
    var title = titleItem ? plain([titleItem]).replace(/\s+/g, " ") : "";
    var notes = "";
    if (notesPart && z.entries[notesPart]) {
      try {
        var nd = await xmlPart(z, notesPart);
        var bodies = [];
        all(path(nd, "p:cSld", "p:spTree"), "p:sp").forEach(function (sp) {
          var ph = phOf(kid(sp, "p:nvSpPr"));
          if (ph && SKIP_PH[ph.type]) return;
          if (ph && ph.type !== "body" && ph.type !== "") return;
          var t = plain([{ kind: "text", paras: parasOf(kid(sp, "p:txBody"), Object.create(null), false) }]);
          if (t) bodies.push(t);
        });
        notes = bodies.join("\n\n").split("\n").filter(function (l) { return !/^\s*\d+\s*$/.test(l); }).join("\n").trim();
      } catch (e) { if (!e.deck) throw e; }
    }
    return {
      n: n, part: part, title: title, hidden: doc.attrs.show === "0" || doc.attrs.show === "false",
      rows: rows, notes: notes,
    };
  }

  /**
   * The deck: {width, height (EMU), slides: [{n, title, hidden, rows: [[item]], notes}]}. Slides are
   * numbered as the API's search numbers them (services/file_text.pptx_parts): their place in the
   * deck's slide list, so `?at=5` and an Ask answer's "slide 5" are the same slide.
   */
  async function readDeck(bytes) {
    var buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var z = zipIndex(buf);
    if (!z.entries["ppt/presentation.xml"]) throw DeckError("This file isn't a PowerPoint deck.");
    if (z.names.some(function (n) { return /(^|\/)vbaProject\.bin$/i.test(n) || /^ppt\/activeX\//i.test(n); })) {
      throw DeckError("This deck contains macros, so it isn't shown here.");
    }
    var pres = await xmlPart(z, "ppt/presentation.xml");
    var rels = await relsOf(z, "ppt/presentation.xml");
    var sz = kid(pres, "p:sldSz");
    var size = {
      cx: num(sz && sz.attrs.cx, DEFAULT_W) || DEFAULT_W,
      cy: num(sz && sz.attrs.cy, DEFAULT_H) || DEFAULT_H,
      masters: Object.create(null),
    };
    var order = [];
    kids(kid(pres, "p:sldIdLst"), "p:sldId").forEach(function (s) {
      var r = rels[s.attrs["r:id"]];
      if (r && !r.external) order.push(r.target);
    });
    if (!order.length) {
      order = z.names.filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
        .sort(function (a, b) { return num(a.match(/(\d+)\.xml$/)[1], 0) - num(b.match(/(\d+)\.xml$/)[1], 0); });
    }
    var slides = [];
    for (var i = 0; i < order.length && i < SLIDES_MAX; i++) {
      if (!z.entries[order[i]]) { slides.push({ n: i + 1, title: "", hidden: false, rows: [], notes: "", missing: true }); continue; }
      slides.push(await readSlide(z, order[i], i + 1, size));
    }
    return {
      width: size.cx, height: size.cy, slides: slides, more: Math.max(0, order.length - SLIDES_MAX),
      media: function (part) { return zipRead(z, part); },
    };
  }

  /** `?at=` → the slide to open (1-based), clamped to the deck; 1 when absent or nonsense. */
  function startSlide(at, count) {
    var n = Math.floor(Number(at));
    if (!isFinite(n) || n < 1) return 1;
    return Math.min(n, Math.max(1, count));
  }

  return {
    readDeck: readDeck, startSlide: startSlide, parseXml: parseXml, zipIndex: zipIndex, zipRead: zipRead,
    rowsOf: rowsOf, plain: plain, mediaType: mediaType, safeHref: safeHref,
  };
}

/**
 * The page's UI (runs in the browser, given the reader and the page's config). Builds every node with
 * the DOM API: text is always textContent, a link's href is the reader's checked one.
 */
export function pptxUi(lib, cfg) {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var stage = $("stage"), thumbs = $("thumbs"), status = $("status"), live = $("live");
  var prev = $("prev"), next = $("next"), notesBtn = $("notesBtn"), notesBox = $("notes"), notesText = $("notesText");
  var dl = $("dl");
  dl.href = cfg.download;
  var deck = null, cur = 0, showNotes = false, imgCache = Object.create(null);

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function imageUrl(part, type) {
    if (!imgCache[part]) {
      imgCache[part] = deck.media(part).then(function (bytes) {
        if (!bytes) return null;
        return new Promise(function (ok) {
          var fr = new FileReader();
          fr.onload = function () { ok(String(fr.result)); };
          fr.onerror = function () { ok(null); };
          fr.readAsDataURL(new Blob([bytes], { type: type }));
        });
      }).catch(function () { return null; });
    }
    return imgCache[part];
  }

  // Font sizes in slide-width units (cqw), so a slide reads the same at any size; the page sets a
  // floor for the big view (--min) so a phone's slide stays readable, never for thumbnails.
  var PT_PER_EMU = 1 / 12700;
  function fsFor(item, para) {
    var widthPt = deck.width * PT_PER_EMU;
    if (para.sz) return Math.max(1.1, Math.min(9, (para.sz / widthPt) * 100));
    if (item.role === "cell") return 1.8;
    if (item.role === "title") return item.centered ? 5.2 : 3.9;
    if (item.role === "subtitle") return 2.6;
    return para.lvl > 0 ? 2.1 : 2.4;
  }

  function paraEl(item, para, tag) {
    var p = h(tag || "p", "sl-p");
    var fs = fsFor(item, para);
    p.style.setProperty("--fs", fs.toFixed(2));
    if (para.lvl) p.style.setProperty("--lvl", String(para.lvl));
    if (para.align) p.style.textAlign = para.align;
    if (para.bullet) {
      p.classList.add("sl-li");
      p.appendChild(h("span", "sl-bu", para.bullet)).setAttribute("aria-hidden", "true");
    }
    var body = h("span", "sl-tx");
    para.runs.forEach(function (r) {
      if (r.br) { body.appendChild(document.createElement("br")); return; }
      var node;
      if (r.href) {
        node = h("a", null, r.t);
        node.href = r.href;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
      } else node = document.createTextNode(r.t);
      if (r.b || r.i || r.u || r.s) {
        var w = h("span");
        if (r.b) w.style.fontWeight = "700";
        if (r.i) w.style.fontStyle = "italic";
        var deco = [r.u ? "underline" : "", r.s ? "line-through" : ""].filter(Boolean).join(" ");
        if (deco) w.style.textDecoration = deco;
        w.appendChild(node);
        node = w;
      }
      body.appendChild(node);
    });
    p.appendChild(body);
    return p;
  }

  function itemEl(item, thumb) {
    var box = h("div", "sl-item sl-k-" + item.kind + (item.role ? " sl-" + item.role : ""));
    if (item.box && deck.width) box.style.setProperty("--w", Math.max(8, Math.min(100, (item.box.cx / deck.width) * 100)).toFixed(2));
    if (item.kind === "text") {
      var heading = item.role === "title";
      item.paras.forEach(function (para, i) {
        box.appendChild(paraEl(item, para, heading && i === 0 && !thumb ? "h2" : "p"));
      });
    } else if (item.kind === "table") {
      var t = h("table", "sl-table");
      item.rows.forEach(function (row, ri) {
        var tr = t.insertRow();
        row.forEach(function (cell) {
          var td = h(item.header && ri === 0 ? "th" : "td");
          if (cell.colspan > 1) td.colSpan = cell.colspan;
          if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
          cell.paras.forEach(function (para) { td.appendChild(paraEl({ role: "cell" }, para)); });
          tr.appendChild(td);
        });
      });
      box.appendChild(t);
    } else if (item.kind === "image") {
      var img = h("img", "sl-img");
      img.alt = item.alt || "";
      img.decoding = "async";
      if (item.box && item.box.cx && item.box.cy) img.style.aspectRatio = item.box.cx + " / " + item.box.cy;
      box.appendChild(img);
      imageUrl(item.part, item.type).then(function (url) {
        if (url) img.src = url;
        else img.replaceWith(h("span", "sl-missing", "Picture couldn't be read"));
      });
    } else {
      box.appendChild(h("span", "sl-missing" + (item.chart ? " sl-chart" : ""), item.label));
    }
    return box;
  }

  function slideEl(s, thumb) {
    // The paper is the size container; its content box (.sl-in) is measured against it, so padding
    // and type scale with the slide, in the big view and in a thumbnail alike.
    var el = h("div", "sl-paper");
    el.style.setProperty("--ratio", deck.width + " / " + deck.height);
    el.style.setProperty("--r", (deck.width / deck.height).toFixed(4));
    var inner = h("div", "sl-in");
    // A title slide (a centred title): its title and subtitle centred on the slide, as presented.
    if (s.rows.some(function (r) { return r.some(function (it) { return it.centered; }); })) inner.classList.add("sl-center");
    el.appendChild(inner);
    if (s.hidden && !thumb) inner.appendChild(h("span", "sl-flag", "Hidden slide"));
    if (s.missing) {
      inner.appendChild(h("p", "sl-empty", "This slide is missing from the file."));
      return el;
    }
    s.rows.forEach(function (row) {
      var r = h("div", "sl-row" + (row.length > 1 ? " sl-cols" : ""));
      row.forEach(function (item) { r.appendChild(itemEl(item, thumb)); });
      inner.appendChild(r);
    });
    if (!s.rows.length) inner.appendChild(h("p", "sl-empty", "This slide has no text or pictures this viewer can show."));
    return el;
  }

  var thumbButtons = [];
  function buildThumbs() {
    thumbs.replaceChildren();
    thumbs.style.setProperty("--ratio", deck.width + " / " + deck.height);
    thumbButtons = deck.slides.map(function (s, i) {
      var b = h("button", "th");
      b.type = "button";
      b.setAttribute("aria-label", "Slide " + s.n + (s.title ? ": " + s.title : "") + (s.hidden ? " (hidden)" : ""));
      b.appendChild(h("span", "th-n", String(s.n))).setAttribute("aria-hidden", "true");
      var frameEl = h("span", "th-frame");
      frameEl.setAttribute("aria-hidden", "true");
      b.appendChild(frameEl);
      b.onclick = function () { go(i, true); };
      thumbs.appendChild(b);
      return { button: b, frame: frameEl, built: false };
    });
    // Draw a thumbnail when it scrolls near the strip's view.
    var io = "IntersectionObserver" in window ? new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        var k = thumbButtons.findIndex(function (t) { return t.button === e.target; });
        drawThumb(k);
        io.unobserve(e.target);
      });
    }, { root: thumbs, rootMargin: "400px 0px" }) : null;
    thumbButtons.forEach(function (t, k) { if (io) io.observe(t.button); else drawThumb(k); });
  }
  function drawThumb(k) {
    var t = thumbButtons[k];
    if (!t || t.built) return;
    t.built = true;
    t.frame.appendChild(slideEl(deck.slides[k], true));
  }

  function go(i, fromUser) {
    if (!deck) return;
    i = Math.max(0, Math.min(deck.slides.length - 1, i));
    cur = i;
    var s = deck.slides[i];
    stage.replaceChildren(slideEl(s, false));
    stage.scrollTop = 0;
    var label = "Slide " + s.n + " of " + deck.slides.length;
    status.textContent = label;
    prev.disabled = i === 0;
    next.disabled = i === deck.slides.length - 1;
    notesText.textContent = s.notes || "This slide has no speaker notes.";
    notesText.classList.toggle("muted", !s.notes);
    thumbButtons.forEach(function (t, k) {
      if (k === i) t.button.setAttribute("aria-current", "true");
      else t.button.removeAttribute("aria-current");
    });
    var tb = thumbButtons[i];
    if (tb) {
      drawThumb(i);
      if (fromUser !== "init") tb.button.scrollIntoView({ block: "nearest" });
      else thumbs.scrollTop = Math.max(0, tb.button.offsetTop - 12);
    }
    if (fromUser && fromUser !== "init") live.textContent = label + (s.title ? ": " + s.title : "");
    // The frame's host may follow along (the slide in its own address); nothing else is sent.
    try { if (window.parent !== window) window.parent.postMessage({ md: 1, ev: "slide", n: s.n }, "*"); } catch (_) { /* ignore */ }
  }

  prev.onclick = function () { go(cur - 1, true); };
  next.onclick = function () { go(cur + 1, true); };
  notesBtn.onclick = function () {
    showNotes = !showNotes;
    notesBtn.setAttribute("aria-pressed", String(showNotes));
    notesBox.hidden = !showNotes;
  };
  document.addEventListener("keydown", function (e) {
    if (!deck || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    var to = e.key === "ArrowRight" || e.key === "PageDown" ? cur + 1
      : e.key === "ArrowLeft" || e.key === "PageUp" ? cur - 1
      : e.key === "Home" ? 0 : e.key === "End" ? deck.slides.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    go(to, true);
    if (t && t.classList && t.classList.contains("th") && thumbButtons[cur]) thumbButtons[cur].button.focus();
  });
  // A finger: swipe left / right on the slide.
  var sx = null, sy = 0;
  stage.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) { sx = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener("touchend", function (e) {
    if (sx === null || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) go(cur + (dx < 0 ? 1 : -1), true);
  }, { passive: true });

  function fail(msg) {
    status.textContent = "Could not show this deck";
    var box = h("div", "sl-error");
    box.appendChild(h("p", null, msg));
    var a = h("a", "btn", "Download the original");
    a.href = cfg.download;
    box.appendChild(a);
    stage.replaceChildren(box);
    [prev, next, notesBtn].forEach(function (b) { b.disabled = true; });
  }

  fetch(cfg.src).then(function (res) {
    if (res.status === 403 || res.status === 404) { showUnavailable(); return null; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.arrayBuffer();
  }).then(function (buf) {
    if (!buf) return null;
    return lib.readDeck(new Uint8Array(buf));
  }).then(function (d) {
    if (!d) return;
    if (!d.slides.length) { fail("This deck has no slides."); return; }
    deck = d;
    document.body.classList.add("ready");
    notesBtn.disabled = false;
    buildThumbs();
    go(lib.startSlide(cfg.at, d.slides.length) - 1, "init");
    if (d.more) live.textContent = "Showing the first " + d.slides.length + " slides.";
  }).catch(function (e) {
    fail(e && e.deck ? e.message : "This deck couldn't be read. Download it to open it in PowerPoint, Keynote or Google Slides.");
    if (!(e && e.deck)) console.info("pptx:", e);
  });
}
