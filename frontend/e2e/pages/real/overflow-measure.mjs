/**
 * overflow.mjs's measurement, run in the page with page.evaluate(measureOverflow, opts). Self-contained
 * (it is serialized into the page). Returns [{rule, who, box, text, rect, boxRect, by}]:
 *
 *   hscroll  the page itself scrolls sideways (scrollWidth > innerWidth + 1); `who` is the widest culprit
 *   spill    text (a text node's line boxes) or a box (a chip, a button, a card: anything with a border, a
 *            background or a shadow) runs past the edge of the nearest bordered / backgrounded block around
 *            it by more than 1 px, with nothing in between that scrolls (overflow auto/scroll: scrolling
 *            inside the box is fine) or clips it
 *   cut      text sliced off sideways by an overflow: hidden / clip ancestor with no ellipsis (a long word
 *            in a line-clamped paragraph, half a URL): part of it shows, the rest is gone
 *
 * Not flagged: ellipsis (text-overflow: ellipsis on the clipping block), screen-reader-only text,
 * absolutely / fixed positioned things relative to the box they float over (tooltips, badges, popovers
 * are measured against their own box), anything inside [data-overflow-ok], SVG text, iframes.
 * Each offender is tagged data-ovf="<n>" (and its box data-ovf-box="<n>") so the runner can screenshot it.
 */
export function measureOverflow({ tol = 1.5, max = 60 } = {}) {
  const out = [];
  const seen = new Set();
  const de = document.documentElement;
  for (const el of document.querySelectorAll("[data-ovf],[data-ovf-box]")) { el.removeAttribute("data-ovf"); el.removeAttribute("data-ovf-box"); }
  const cache = new Map();
  const cs = (el) => {
    let s = cache.get(el);
    if (!s) { s = getComputedStyle(el); cache.set(el, s); }
    return s;
  };
  const transparent = (c) => !c || c === "transparent" || /rgba?\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const isBlock = (el) => !/^(inline|contents)$/.test(cs(el).display) && cs(el).display !== "inline";
  const isBox = (el) => {
    if (el === document.body || el === de) return true;
    const s = cs(el);
    const side = (w, st, c) => parseFloat(w) > 0 && st !== "none" && st !== "hidden" && !transparent(c);
    if (side(s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor) || side(s.borderRightWidth, s.borderRightStyle, s.borderRightColor)) return true;
    if (!transparent(s.backgroundColor) || (s.backgroundImage && s.backgroundImage !== "none")) return true;
    if (s.boxShadow && s.boxShadow !== "none" && !/inset/.test(s.boxShadow)) return true;
    return false;
  };
  const positioned = (el) => /^(absolute|fixed)$/.test(cs(el).position);
  const srOnly = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const s = cs(a);
      if (s.clip === "rect(0px, 0px, 0px, 0px)" || s.clipPath === "inset(50%)") return true;
      if (s.position === "absolute" && parseFloat(s.width) <= 1 && parseFloat(s.height) <= 1) return true;
    }
    return false;
  };
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    if (el.closest("[data-overflow-ok], [aria-hidden=true][inert], svg, iframe, [hidden]")) return false;
    return true;
  };
  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    const one = (e) => {
      let s = e.tagName.toLowerCase();
      const tid = e.getAttribute("data-testid");
      if (tid) return `${s}[data-testid="${tid}"]`;
      const cls = String(typeof e.className === "string" ? e.className : e.className?.baseVal || "")
        .split(/\s+/).filter((c) => c && !/^(ph-|md-focus|js$|dark$)/.test(c) && !/[\[\]:/]/.test(c)).slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      else if (e.id && !/^(radix|:r)/.test(e.id)) s += `#${e.id}`;
      return s;
    };
    const parts = [one(el)];
    let a = el.parentElement;
    for (let i = 0; i < 2 && a && a !== document.body; i++, a = a.parentElement) parts.unshift(one(a));
    return parts.join(" > ");
  }
  const sample = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  let n = 0;
  const push = (rule, el, box, rect, boxRect, by, text) => {
    const who = describe(el);
    const k = `${rule}|${who}`;
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    n++;
    el.setAttribute("data-ovf", String(n));
    if (box && box.nodeType === 1 && box !== document.body && box !== de) box.setAttribute("data-ovf-box", String(n));
    out.push({ n, rule, who, box: box ? describe(box) : null, text: (text ?? sample(el)).slice(0, 80), by: Math.round(by),
      rect: rect && [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)],
      boxRect: boxRect && [Math.round(boxRect.left), Math.round(boxRect.top), Math.round(boxRect.right), Math.round(boxRect.bottom)] });
  };
  /** The block box around `start` (exclusive when `self` is false), and how the way there treats overflow. */
  function container(start, includeSelf) {
    let clipper = null;
    for (let a = includeSelf ? start : start.parentElement; a; a = a.parentElement) {
      const s = cs(a);
      const ox = s.overflowX;
      if (a !== start && (ox === "auto" || ox === "scroll")) return { skip: "scroll" };
      if (a !== start && (ox === "hidden" || ox === "clip") && !clipper) clipper = a;
      if (a === start && includeSelf && (ox === "auto" || ox === "scroll")) return { skip: "scroll" };
      if (a === start && includeSelf && (ox === "hidden" || ox === "clip") && !clipper) clipper = a;
      if (a === de || a === document.body) return { box: a, clipper };
      if (isBlock(a) && isBox(a) && (a !== start || includeSelf)) return { box: a, clipper };
      // Floating things (a tooltip, a badge, a popover's inner part) sit where they're put, on purpose.
      if (positioned(a)) return { skip: "positioned" };
    }
    return { box: de, clipper };
  }
  const inner = (el) => {
    if (el === de || el === document.body) return { left: 0, right: Math.max(window.innerWidth, de.clientWidth), top: 0, bottom: 0 };
    const r = el.getBoundingClientRect();
    const s = cs(el);
    return { left: r.left + parseFloat(s.borderLeftWidth), right: r.right - parseFloat(s.borderRightWidth), top: r.top, bottom: r.bottom };
  };
  const ellipsisOn = (el, stop) => {
    for (let a = el; a; a = a.parentElement) {
      if (cs(a).textOverflow === "ellipsis") return true;
      if (a === stop) break;
    }
    return false;
  };

  // 1. The page scrolls sideways.
  const sw = Math.max(de.scrollWidth, document.body.scrollWidth);
  if (sw > window.innerWidth + 1) {
    const vw = de.clientWidth;
    let worst = null;
    for (const el of document.body.querySelectorAll("*")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.right <= vw + 1) continue;
      // The deepest element that sticks out whose parent doesn't (the root cause), widest first.
      const pr = el.parentElement?.getBoundingClientRect();
      if (pr && pr.right > vw + 1 && el.parentElement !== document.body) continue;
      if (!worst || r.right > worst.r.right) worst = { el, r };
    }
    push("hscroll", worst ? worst.el : de, null, worst?.r, null, sw - window.innerWidth, `scrollWidth ${sw} > ${window.innerWidth}${worst ? ` · ${sample(worst.el)}` : ""}`);
  }

  // 2. Text past its box, or cut.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.nodeValue || !t.nodeValue.trim()) continue;
    const el = t.parentElement;
    if (!el || el.closest("script, style, noscript, template, svg, [data-overflow-ok]")) continue;
    if (!visible(el) || srOnly(el)) continue;
    const c = container(el, true);
    if (c.skip) continue;
    range.selectNodeContents(t);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
    const tr = { left, right, top, bottom };
    if (c.clipper && !ellipsisOn(el, c.clipper)) {
      const k = inner(c.clipper);
      const cutR = right - k.right, cutL = k.left - left;
      // Part of it shows and part is gone (not a slide parked entirely out of view).
      if ((cutR > tol && left < k.right - 4) || (cutL > tol && right > k.left + 4)) {
        push("cut", el, c.clipper, tr, k, Math.max(cutR, cutL), t.nodeValue.trim().replace(/\s+/g, " "));
        continue;
      }
    }
    if (c.clipper) continue; // clipped (with an ellipsis, or inside the box): nothing spills
    const b = inner(c.box);
    const by = Math.max(right - b.right, b.left - left);
    if (by > tol) push("spill", el, c.box, tr, b, by, t.nodeValue.trim().replace(/\s+/g, " "));
  }

  // 3. Boxes (chips, buttons, cards) past their box.
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("svg, [data-overflow-ok]") || el.tagName === "IFRAME") continue;
    if (!isBox(el) || positioned(el) || !visible(el) || srOnly(el)) continue;
    const s = cs(el);
    if (s.position === "sticky") continue;
    const c = container(el, false);
    if (c.skip || c.clipper) continue;
    const rects = [...el.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
    const b = inner(c.box);
    // Bleeding into the box's border (a full-width divider) is fine; past its outer edge is not.
    const bs = c.box === de || c.box === document.body ? { l: 0, r: 0 } : { l: parseFloat(cs(c.box).borderLeftWidth), r: parseFloat(cs(c.box).borderRightWidth) };
    const by = Math.max(right - (b.right + bs.r), b.left - bs.l - left);
    if (by > tol) push("spill", el, c.box, { left, right, top: rects[0].top, bottom: rects[rects.length - 1].bottom }, b, by);
  }
  range.detach?.();
  return out;
}
