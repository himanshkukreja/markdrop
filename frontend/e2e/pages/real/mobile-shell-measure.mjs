/**
 * The app shell audit's measurement (mobile-shell.mjs; also home.mjs), run in the page with
 * page.evaluate(measure, {checkTargets}). Returns [{rule, who, detail}]; the rules are listed in
 * mobile-shell.mjs. Self-contained: it's serialized into the page.
 */
/** Runs in the page: every rule above, as [{rule, who, detail}]. */
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
      if (a.getAttribute("aria-hidden") === "true" && a.closest("[inert], [aria-hidden=true]") && !a.closest("[role=dialog]")) return false;
      if (a.hasAttribute("inert")) return false;
      if (a.hasAttribute("data-audit-skip")) return false;
      const cs = getComputedStyle(a);
      if (cs.clipPath === "inset(50%)" || cs.clip === "rect(0px, 0px, 0px, 0px)") return false;
    }
    return true;
  };
  /** The part of an element's box its clipping ancestors (overflow ≠ visible) leave showing. */
  const clipped = (el) => {
    let r = el.getBoundingClientRect();
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
  // An open menu covers part of the page: while it's open, it is what a finger aims at.
  const openMenu = [...document.querySelectorAll('[role=menu], [role=dialog]:not([aria-modal="true"])')].filter((m) => visible(m) && /fixed|absolute/.test(getComputedStyle(m).position)).pop();
  const targetScope = (openMenu && (!modal || modal.contains(openMenu))) ? openMenu : scope;

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
  for (const el of document.querySelectorAll('[role=menu], [role=dialog], [role=alertdialog], [role=listbox], .md-popover, .md-sheet')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    if (el.getAttribute("role") === "listbox" && el.closest("[role=dialog]")) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) push("popup", el, `${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}×${vh}`);
  }

  // 4. touch targets
  if (checkTargets) {
    for (const el of targetScope.querySelectorAll(INTERACTIVE)) {
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (el.matches("[role=listbox], [role=menu], [role=dialog], [role=grid], [role=tabpanel], [role=region], [role=group], ul, ol, main, section, form, div[tabindex='0'][class*='scroll']")) continue;
      if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) continue; // the label is the target
      let target = el;
      if (!visible(target)) {
        // A hidden native input behind a custom control: its label is the target.
        if (el.matches("input") && el.closest("label") && visible(el.closest("label"))) target = el.closest("label");
        else continue;
      }
      const r = target.getBoundingClientRect();
      // Inline links inside running text are exempt (WCAG 2.5.8's inline exception).
      if (el.tagName === "A" && getComputedStyle(el).display.startsWith("inline")) {
        const block = el.parentElement;
        const t = (block?.innerText || "").trim().length;
        if (t > (el.innerText || "").trim().length + 12) continue;
      }
      if (r.width >= 43.5 && r.height >= 43.5) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Scrolled partly out of view (a board column past the edge): aimed at once it's scrolled in.
      if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
      // Under something else at its own centre: obscured, not a target right now.
      const atCentre = document.elementFromPoint(Math.min(vw - 1, Math.max(0, cx)), Math.min(vh - 1, Math.max(0, cy)));
      // (An ancestor there means the target is clipped away by its own scroller at that point.)
      if (!atCentre || !(target === atCentre || target.contains(atCentre))) continue;
      // The hit area along the centre lines, walked out 1 px at a time (a stretched link's ::after or
      // a larger invisible hit area counts; the screen's edge counts as reach).
      const owns = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === target || target.contains(h)); };
      // The edge of a scroller the target sits in counts as reach too (a board card partly scrolled
      // past its board's edge: it is aimed at once it's scrolled in), like the screen's edge.
      let clip = null;
      for (let a = target.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY) && (a.scrollWidth > a.clientWidth + 1 || a.scrollHeight > a.clientHeight + 1)) {
          const ar = a.getBoundingClientRect();
          clip = clip
            ? { l: Math.max(clip.l, ar.left), t: Math.max(clip.t, ar.top), r: Math.min(clip.r, ar.right), b: Math.min(clip.b, ar.bottom) }
            : { l: ar.left, t: ar.top, r: ar.right, b: ar.bottom };
        }
      }
      const reach = (dx, dy) => {
        for (let s = 1; s <= 22; s++) {
          const x = cx + dx * s, y = cy + dy * s;
          // (elementFromPoint rounds: the last pixel row and column already count as off screen.)
          if (x < 0 || y < 0 || x > vw - 1 || y > vh - 1) return 22;
          if (clip && (x < clip.l || y < clip.t || x > clip.r - 1 || y > clip.b - 1)) return 22;
          if (!owns(x, y)) return s - 1;
        }
        return 22;
      };
      const hw = reach(-1, 0) + reach(1, 0) + 1, hh = reach(0, -1) + reach(0, 1) + 1;
      if (hw < 43 || hh < 43) push("target", el, `${Math.round(r.width)}×${Math.round(r.height)} (hit ${hw}×${hh})`);
    }
  }

  // 5. text fields under 16 px
  for (const el of scope.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, select, [contenteditable="true"]')) {
    if (!visible(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 15.95) push("input", el, `${fs}px`);
  }

  // 6. text under 12 px
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest("script, style, noscript, svg, [data-audit-skip]")) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs >= 11.95) continue;
    if (!visible(el)) continue;
    // An avatar's initials (one or two letters in a small round chip) are a mark, not text to read.
    const br = el.getBoundingClientRect();
    if (n.nodeValue.trim().length <= 2 && br.width <= 28 && br.height <= 28 && /^[A-Z?]+$/i.test(n.nodeValue.trim())) continue;
    push("text", el, `${fs}px`);
  }

  // 7. fixed and sticky bars covering each other
  const bars = [];
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (!visible(el) || cs.pointerEvents === "none") continue;
    if (el.closest('[aria-modal="true"], [role=menu], [role=listbox], [role=tooltip], .md-popover, .md-scrim, .md-drawer-scrim, .md-skiplink, [data-audit-skip]')) continue;
    if (el.matches('[aria-modal="true"], .md-scrim, .md-drawer-scrim')) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= vw * vh * 0.9) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    bars.push([el, r, cs.position]);
  }
  const top = bars.filter(([el]) => !bars.some(([o]) => o !== el && o.contains(el)));
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const [a, ra, pa] = top[i], [b, rb, pb] = top[j];
    if (a.contains(b) || b.contains(a)) continue;
    // A sticky element inside a scroller that the other isn't part of can't cover it in flow.
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 2 && h > 2 && (pa === "fixed" || pb === "fixed" || modal == null)) {
      // Two sticky things only overlap in a bad way when they're both stuck at the same place.
      push("overlap", a, `${describe(a)} (${pa}) and ${describe(b)} (${pb}) overlap ${Math.round(w)}×${Math.round(h)}`);
    }
  }

  // 7b. a top bar's own items running into each other or out of the bar (owner 2026-11-06: the page
  // bar's title, Ask, From meetings, Edit, Share, ⋯ merged on tablets). Each visible leaf item of a
  // bar (a button, a link, the title, the faces) must not cover another, nor pass the bar's edges.
  for (const bar of document.querySelectorAll(".pb-bar, .mt-pagebar, [data-audit-bar]")) {
    if (!visible(bar)) continue;
    const br = bar.getBoundingClientRect();
    const items = [];
    for (const el of bar.querySelectorAll("button, a[href], [role=button], .pb-crumb__text, .pb-bar__presence, .mt-pagebar__people, .mt-pagebar__fact")) {
      if (!visible(el) || el.closest("[role=menu], [role=dialog], .md-popover")) continue;
      if ([...el.querySelectorAll("button, a[href], [role=button], .pb-crumb__text")].some((c) => c !== el && visible(c))) continue;
      const r = el.getBoundingClientRect();
      items.push([el, r]);
      if (r.left < br.left - 1 || r.right > br.right + 1) push("baritems", el, `${describe(el)} passes the bar's edge (${Math.round(r.left)}–${Math.round(r.right)} of ${Math.round(br.left)}–${Math.round(br.right)})`);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const [a, ra] = items[i], [b, rb] = items[j];
      if (a.contains(b) || b.contains(a)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 1 && h > 1) push("baritems", a, `${describe(a)} and ${describe(b)} overlap ${Math.round(w)}×${Math.round(h)}`);
    }
  }

  // 8. hover-only controls (touch screens): opacity 0 / visibility hidden unless hovered
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
    // A transparent native input laid over its own visible face (a colour swatch, a file button) is not hover-only.
    if (hidden && el.matches("input") && Number(cs.opacity) === 0 && el.parentElement && Number(getComputedStyle(el.parentElement).opacity) > 0) hidden = false;
    if (hidden && cs.visibility !== "hidden" && !el.closest("[aria-hidden=true]")) {
      // Opacity 0 but in the layout and clickable: a hover-only affordance.
      if (cs.pointerEvents !== "none") push("hover", el, "opacity 0 until hover/focus");
    }
  }

  // 9. pinch zoom
  const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0*)?\b/i.test(meta)) push("zoom", document.documentElement, meta);

  return out;
}
