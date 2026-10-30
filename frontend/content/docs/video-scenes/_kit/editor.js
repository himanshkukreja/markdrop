/**
 * Pieces for the neutral code-editor scenes (VS Code extension videos): Markdown highlighting,
 * the code view, a two-pane comparison, the status bar, a command palette, toasts and a modal.
 * Labels and messages come from the real extension (extension/src/extension.ts, package.json);
 * the look is Markdrop's own, not any editor's.
 */
import { esc, h, icon, set, p, E } from "./kit.js";

/** One line of Markdown, highlighted. */
export function md(line) {
  if (/^#{1,6} /.test(line)) return `<span class="tok-h">${esc(line)}</span>`;
  let s = esc(line);
  s = s.replace(/^(\s*)([-*]|\d+\.)( )/, '$1<span class="tok-b">$2</span>$3');
  s = s.replace(/(\*\*[^*]+\*\*)/g, '<span class="tok-c">$1</span>');
  s = s.replace(/(`[^`]+`)/g, '<span class="tok-l">$1</span>');
  return s;
}

/** The code view: lines (strings), with optional per-line class, caret and filler lines. */
export function renderCode(el, lines, { cls = {}, caret = null, start = 1, top = 0 } = {}) {
  const key = JSON.stringify([lines, cls, caret, top]);
  if (el._k === key) return;
  el._k = key;
  el.innerHTML = lines.map((ln, i) => {
    if (ln === null) return `<div class="ef-line ${cls[i] || ""}" style="background-image:repeating-linear-gradient(-45deg, transparent 0 6px, var(--surface-inset) 6px 8px)"><span class="gut"></span><span class="src"></span></div>`;
    let src = md(ln);
    if (caret && caret[0] === i) {
      const before = md(ln.slice(0, caret[1]));
      const after = esc(ln.slice(caret[1]));
      src = `${before}<span class="ef-caret"></span>${after}`;
    }
    return `<div class="ef-line ${cls[i] || ""}"><span class="gut">${start + i}</span><span class="src">${src || " "}</span></div>`;
  }).join("");
  el.style.transform = top ? `translateY(${-top}px)` : "";
}

/** Status bar: left items and the Markdrop item on the right. */
export function statusBar(el, { left = [], md: item = null }) {
  const key = JSON.stringify([left, item]);
  if (el._k === key) return;
  el._k = key;
  const it = item ? `<span class="item ${item.cls || ""}">${item.icon ? icon(item.icon, { size: 14 }) : ""}${item.spin ? '<span class="kit-spin" style="width:12px;height:12px"></span>' : ""}${esc(item.text)}</span>` : "";
  el.innerHTML = `${left.map((x) => `<span class="item">${x.icon ? icon(x.icon, { size: 14 }) : ""}${esc(x.text)}</span>`).join("")}<span class="sp"></span><span class="item">Markdown</span><span class="item">UTF-8</span>${it}`;
}

export function palette(parent) {
  const el = h(`<div class="ef-palette"><div class="in"></div><div class="rows"></div></div>`);
  parent.append(el);
  return {
    el,
    show(text, rows, on = 0) {
      const key = JSON.stringify([text, rows, on]);
      if (el._k === key) return;
      el._k = key;
      el.querySelector(".in").innerHTML = text ? `${esc(text)}<span class="ef-caret" style="height:18px"></span>` : '<span style="color:var(--text-subtle)">Type a command</span><span class="ef-caret" style="height:18px"></span>';
      const q = text.toLowerCase();
      el.querySelector(".rows").innerHTML = rows.map((r, i) => {
        const at = q ? r.toLowerCase().indexOf(q) : -1;
        const label = at >= 0 ? `${esc(r.slice(0, at))}<b>${esc(r.slice(at, at + q.length))}</b>${esc(r.slice(at + q.length))}` : esc(r);
        return `<div class="row${i === on ? " on" : ""}"><span>${label}</span></div>`;
      }).join("");
    },
  };
}

export function toast(parent, { x, y, w = 470 }) {
  const el = h(`<div class="toast"><div class="row"><span class="ti"></span><div class="msg" style="flex:1"></div></div><div class="src">Markdrop Sync</div><div class="acts"></div></div>`);
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px` });
  parent.append(el);
  return {
    el,
    show(kind, msg, acts = [], hot = -1) {
      const key = JSON.stringify([kind, msg, acts, hot]);
      if (el._k === key) return;
      el._k = key;
      const ic = { info: ["sparkle", "var(--accent-text)"], warn: ["warn", "var(--warning)"], err: ["x", "var(--danger)"] }[kind] || ["sparkle", "var(--accent-text)"];
      el.querySelector(".ti").innerHTML = `<span style="color:${ic[1]};font-size:19px">${icon(kind === "info" ? "check" : ic[0])}</span>`;
      el.querySelector(".msg").textContent = msg;
      el.querySelector(".acts").innerHTML = acts.map((a, i) => `<span class="btn sm${i === 0 ? " primary" : ""}"${i === hot ? ' style="outline:2px solid var(--border-focus);outline-offset:2px"' : ""}>${esc(a)}</span>`).join("");
      el.querySelector(".acts").style.display = acts.length ? "" : "none";
    },
  };
}

/** A modal question, centred on `parent`. */
export function modal(parent, { title, detail, buttons, bottom = 0 }) {
  const el = h(`<div style="position:absolute;inset:0;z-index:30;display:grid;justify-items:center;align-items:${bottom ? "end" : "center"};padding-bottom:${bottom}px">
    <div class="scrim" style="position:absolute;inset:0;background:var(--overlay)"></div>
    <div class="dlg" style="position:relative;width:580px;background:var(--surface-raised);border:1px solid var(--border-strong);border-radius:16px;box-shadow:var(--shadow-xl);padding:24px 24px 20px">
      <div style="display:flex;gap:14px;align-items:flex-start">
        <span style="width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--warning-soft);color:var(--warning);font-size:21px;flex:none">${icon("warn")}</span>
        <div><div style="font:750 18px/1.35 var(--font-sans);color:var(--text)">${esc(title)}</div>
        <div style="font:520 15px/1.45 var(--font-sans);color:var(--text-secondary);margin-top:6px">${esc(detail)}</div>
        <div style="font:600 12.5px/1 var(--font-sans);color:var(--text-muted);margin-top:10px">Markdrop Sync</div></div>
      </div>
      <div class="bts" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:18px"></div>
    </div></div>`);
  parent.append(el);
  const bts = el.querySelector(".bts");
  bts.innerHTML = buttons.map((b) => `<span class="btn" style="justify-content:center;height:42px">${esc(b)}</span>`).join("");
  return {
    el,
    buttons: [...bts.children],
    at(k, hot = -1, press = 0) {
      set(el.querySelector(".scrim"), { o: k * 0.5 });
      set(el.querySelector(".dlg"), { o: k, s: 0.96 + 0.04 * k, y: (1 - k) * 8 });
      el.style.display = k > 0.001 ? "grid" : "none";
      [...bts.children].forEach((b, i) => {
        b.style.background = i === hot ? "var(--accent-soft)" : "";
        b.style.borderColor = i === hot ? "var(--accent)" : "";
        b.style.transform = i === hot && press ? `scale(${1 - 0.03 * press})` : "";
      });
    },
  };
}

/** Two panes side by side in the editor's main area (a comparison). */
export function diffView(main, { leftTitle, rightTitle }) {
  const el = h(`<div style="position:absolute;inset:42px 0 0 0;display:grid;grid-template-columns:1fr 1fr;background:var(--surface)">
    <div style="position:relative;border-right:1px solid var(--border);overflow:hidden"><div class="dh" style="height:34px;display:flex;align-items:center;gap:8px;padding:0 16px;font:650 13px/1 var(--font-sans);color:var(--text-muted);border-bottom:1px solid var(--border);background:var(--surface-raised)"></div><div class="ef-code l" style="height:calc(100% - 34px)"></div></div>
    <div style="position:relative;overflow:hidden"><div class="dh" style="height:34px;display:flex;align-items:center;gap:8px;padding:0 16px;font:650 13px/1 var(--font-sans);color:var(--text-muted);border-bottom:1px solid var(--border);background:var(--surface-raised)"></div><div class="ef-code r" style="height:calc(100% - 34px)"></div></div>
  </div>`);
  const [lh, rh] = el.querySelectorAll(".dh");
  lh.innerHTML = `${icon("globe", { size: 14 })} ${esc(leftTitle)}`;
  rh.innerHTML = `${icon("md", { size: 15 })} ${esc(rightTitle)}`;
  main.append(el);
  return { el, left: el.querySelector(".l"), right: el.querySelector(".r") };
}

export const fadeIn = (t, a, d = 0.3) => p(t, a, a + d, E.out);
