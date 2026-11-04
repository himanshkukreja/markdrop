/**
 * The mobile audit's measurement (mobile-content.mjs), run in the page with page.evaluate(measure,
 * {checkTargets}). Returns [{rule, who, detail}]; the rules are listed in mobile-content.mjs.
 * Self-contained: it's serialized into the page, so it must not use anything from this module.
 */
export function measure({ checkTargets }) {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const out = [];
  const seen = new Set();
  const push = (rule, el, detail) => {
    const who = describe(el);
    const k = `${rule}|${who}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ rule, who, detail });
  };
  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    const bits = [el.tagName.toLowerCase()];
    const role = el.getAttribute("role");
    if (role) bits.push(`[role=${role}]`);
    const name = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (name) bits.push(`"${name.replace(/[0-9a-f]{24}/g, "…").replace(/\d+/g, "#").slice(0, 48)}"`);
    const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "")
      .split(/\s+/).filter((c) => c && !/^(ph-|md-focus)/.test(c) && !/[\[\]:]/.test(c)).slice(0, 2).join(".");
    if (cls) bits.push(`.${cls}`);
    return bits.join("");
  }
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      if (a.hasAttribute("inert") || a.hasAttribute("data-audit-skip")) return false;
      if (a.getAttribute("aria-hidden") === "true" && !a.closest("[role=dialog]")) return false;
      const cs = getComputedStyle(a);
      if (cs.clipPath === "inset(50%)" || cs.clip === "rect(0px, 0px, 0px, 0px)") return false;
    }
    return true;
  };
  const clipped = (el) => {
    const r = el.getBoundingClientRect();
    let { left, right, top, bottom } = r;
    let fixedAncestor = false;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.position === "fixed") fixedAncestor = true;
      if (a === document.body) break;
      const ox = cs.overflowX, oy = cs.overflowY;
      if (ox !== "visible" || oy !== "visible") {
        const ar = a.getBoundingClientRect();
        if (ox !== "visible") { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
        if (oy !== "visible") { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
      }
    }
    if (getComputedStyle(el).position === "fixed") fixedAncestor = true;
    return { left, right, top, bottom, fixed: fixedAncestor, empty: right - left < 1 || bottom - top < 1 };
  };

  // 1. sideways scroll
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1 || document.body.scrollWidth > de.clientWidth + 1) {
    const culprits = [];
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0 && visible(el)) {
        const c = clipped(el);
        if (!c.empty && c.right > vw + 1 && !(el.parentElement && el.parentElement.getBoundingClientRect().right > vw + 1)) culprits.push(el);
      }
    }
    push("hscroll", culprits[0] || de, `scrollWidth ${Math.max(de.scrollWidth, document.body.scrollWidth)} > ${de.clientWidth}${culprits.length ? ` (first: ${culprits.slice(0, 3).map(describe).join(", ")})` : ""}`);
  }

  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio], [role=combobox], [tabindex]:not([tabindex="-1"])';
  const modal = [...document.querySelectorAll('[aria-modal="true"]')].filter(visible).pop();
  const scope = modal || document.body;

  // 2. off-screen controls and text
  for (const el of scope.querySelectorAll(`${INTERACTIVE}, h1, h2, h3, p, label, li, td, th`)) {
    if (!visible(el)) continue;
    const c = clipped(el);
    if (c.empty) continue;
    const offX = c.left < -1 || c.right > vw + 1;
    const offY = c.fixed && (c.top < -1 || c.bottom > vh + 1);
    if (offX || offY) push("offscreen", el, `visible box ${Math.round(c.left)},${Math.round(c.top)} → ${Math.round(c.right)},${Math.round(c.bottom)} in ${vw}×${vh}`);
  }

  // 3. popups fit the viewport
  for (const el of document.querySelectorAll('[role=menu], [role=dialog], [role=alertdialog], [role=listbox], .md-popover, .md-sheet, .pb-sheet__panel, .dxe-slash, .dxe-people, .pb-coverpick, .pb-emojipick, .dxe-tb, .dxe-tablebar')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    if (el.getAttribute("role") === "listbox" && el.closest("[role=dialog], .dxe-slash, .dxe-people")) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) push("popup", el, `${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}×${vh}`);
  }

  // 4. touch targets
  if (checkTargets) {
    for (const el of scope.querySelectorAll(INTERACTIVE)) {
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (el.matches("[role=listbox], [role=menu], [role=dialog], [role=grid], [role=tabpanel], [role=region], [role=group], [role=textbox], ul, ol, main, section, form, [contenteditable], .ProseMirror, div[tabindex='0'][class*='scroll']")) continue;
      if (el.closest(".ProseMirror") && !el.closest("[contenteditable=false]")) continue; // text in the editor
      if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) continue;
      let target = el;
      if (!visible(target)) {
        if (el.matches("input") && el.closest("label") && visible(el.closest("label"))) target = el.closest("label");
        else continue;
      }
      const r = target.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue; // off the screen vertically: measured when scrolled to
      if (el.tagName === "A" && getComputedStyle(el).display === "inline") {
        const block = el.parentElement;
        const t = (block?.innerText || "").trim().length;
        if (t > (el.innerText || "").trim().length + 12) continue;
      }
      if (el.matches(".pb-mention, .dxe-mention, [data-pb=mention], [data-pb=mention] *")) continue; // an inline chip in running text
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      // A text field as wide as a line of text (a callout's title, a code block's caption): the whole
      // line is the target, so 24 px tall is enough (WCAG 2.5.8); a short one still needs 44.
      if (el.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea") && r.width >= 120 && r.height >= 19.5) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const atCentre = document.elementFromPoint(Math.min(vw - 1, Math.max(0, cx)), Math.min(vh - 1, Math.max(0, cy)));
      if (!atCentre || !(target === atCentre || target.contains(atCentre) || atCentre.contains(target))) continue;
      const probes = [[cx - 21.5, cy], [cx + 21.5, cy], [cx, cy - 21.5], [cx, cy + 21.5]];
      let good = true;
      for (const [x, y] of probes) {
        if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === target || target.contains(hit))) { good = false; break; }
      }
      if (!good) push("target", el, `${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }

  // 5. text fields under 16 px
  for (const el of scope.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [contenteditable="true"]')) {
    if (!visible(el)) continue;
    const f = parseFloat(getComputedStyle(el).fontSize);
    if (f < 15.95) push("input", el, `${f}px`);
  }

  // 6. text under 12 px
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    // .textLayer: pdf.js's invisible copy of a PDF page's text (it's drawn on the canvas below it).
    if (!el || el.closest("script, style, noscript, svg, .katex, .textLayer, [data-audit-skip]")) continue;
    const f = parseFloat(getComputedStyle(el).fontSize);
    if (f >= 11.95) continue;
    if (!visible(el)) continue;
    push("text", el, `${f}px`);
  }

  // 7. fixed and sticky bars covering each other
  const bars = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (!visible(el) || cs.pointerEvents === "none") continue;
    if (el.closest('[aria-modal="true"], [role=menu], [role=listbox], [role=tooltip], .md-popover, .md-scrim, .md-drawer-scrim, .md-skiplink, .pb-railscrim, .dxe-pop, .dxe-slash, .dxe-people, [data-audit-skip]')) continue;
    if (el.matches('[aria-modal="true"], .md-scrim, .md-drawer-scrim, .pb-railscrim')) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= vw * vh * 0.9) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    bars.push([el, r, cs.position]);
  }
  const top = bars.filter(([el]) => !bars.some(([o]) => o !== el && o.contains(el)));
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const [a, ra, pa] = top[i], [b, rb, pb] = top[j];
    if (a.contains(b) || b.contains(a)) continue;
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 2 && h > 2 && (pa === "fixed" || pb === "fixed" || modal == null)) push("overlap", a, `${describe(a)} (${pa}) and ${describe(b)} (${pb}) overlap ${Math.round(w)}×${Math.round(h)}`);
  }

  // 8. hover-only controls
  for (const el of scope.querySelectorAll(INTERACTIVE)) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (el.closest("[data-audit-skip], .md-visually-hidden, .md-skiplink")) continue;
    let hidden = false;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (Number(s.opacity) === 0 && s.display !== "none") { hidden = true; break; }
    }
    if (hidden && cs.visibility !== "hidden" && !el.closest("[aria-hidden=true]") && cs.pointerEvents !== "none") push("hover", el, "opacity 0 until hover/focus");
  }

  // 9. images: overflowing, stretched; the page cover: full width of the paper, sensible height, filled
  for (const img of document.querySelectorAll("img, video, canvas, iframe")) {
    if (!visible(img)) continue;
    const r = img.getBoundingClientRect();
    const c = clipped(img);
    if (c.right > vw + 1 && !c.empty) push("image", img, `right edge ${Math.round(c.right)} > ${vw}`);
    if (img.tagName === "IMG" && img.complete && img.naturalWidth > 8 && img.naturalHeight > 8) {
      const fit = getComputedStyle(img).objectFit;
      if (fit === "fill" || fit === "") {
        const nat = img.naturalWidth / img.naturalHeight, box = r.width / r.height;
        if (Math.abs(nat - box) / nat > 0.04 && r.width > 24 && r.height > 24) push("image", img, `stretched: natural ${nat.toFixed(2)} vs box ${box.toFixed(2)}`);
      }
    }
  }
  const cover = document.querySelector(".pb-cover-img:not(.pb-cover-img--pending)");
  if (cover && visible(cover)) {
    const r = cover.getBoundingClientRect();
    const paper = cover.closest(".pb-paper") || document.querySelector(".pb-paper");
    const pr = paper ? paper.getBoundingClientRect() : { left: 0, right: vw };
    if (Math.abs(r.left - pr.left) > 1 || Math.abs(r.right - pr.right) > 1) push("image", cover, `cover ${Math.round(r.left)}→${Math.round(r.right)} vs paper ${Math.round(pr.left)}→${Math.round(pr.right)}`);
    if (r.height > vh * 0.42) push("image", cover, `cover ${Math.round(r.height)} px tall in a ${vh} px screen`);
    if (r.height < 110) push("image", cover, `cover only ${Math.round(r.height)} px tall`);
    const ratio = r.width / r.height;
    if (ratio < 1.6) push("image", cover, `cover ${Math.round(r.width)}×${Math.round(r.height)} is too tall for its width (${ratio.toFixed(2)}:1)`);
    const im = cover.querySelector("img");
    if (im && visible(im)) {
      const ir = im.getBoundingClientRect();
      if (Math.abs(ir.width - r.width) > 1 || Math.abs(ir.height - r.height) > 1) push("image", im, `cover image ${Math.round(ir.width)}×${Math.round(ir.height)} in ${Math.round(r.width)}×${Math.round(r.height)}`);
      if (getComputedStyle(im).objectFit !== "cover") push("image", im, "cover image not object-fit: cover");
    }
  }

  // 10. grids: cards squeezed or overflowing
  for (const g of document.querySelectorAll(".pb-templates, .pb-yt__grid, .pb-coverpick__grid, .pb-covergal__grid, [data-audit-grid]")) {
    if (!visible(g)) continue;
    const gr = g.getBoundingClientRect();
    for (const card of g.children) {
      if (!visible(card)) continue;
      const r = card.getBoundingClientRect();
      if (r.right > gr.right + 1 || r.left < gr.left - 1) { push("grid", card, `card ${Math.round(r.left)}→${Math.round(r.right)} outside grid ${Math.round(gr.left)}→${Math.round(gr.right)}`); break; }
      if (g.matches(".pb-templates, .pb-yt__grid") && r.width < 140) { push("grid", card, `card only ${Math.round(r.width)} px wide`); break; }
      if (card.scrollWidth > card.clientWidth + 2 && getComputedStyle(card).overflowX === "visible") { push("grid", card, `content ${card.scrollWidth} wider than card ${card.clientWidth}`); break; }
    }
  }

  // 11. pinch zoom
  const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0*)?\b/i.test(meta)) push("zoom", document.documentElement, meta);

  return out;
}
