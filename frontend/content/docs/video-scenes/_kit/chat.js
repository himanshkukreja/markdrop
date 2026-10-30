/**
 * A conversation in the neutral AI-app frame (kit.chatFrame): messages appear at given times,
 * grow in smoothly, and the feed keeps the newest one in view. Tool calls show the real Markdrop
 * MCP tool names, arguments, progress messages and results (recorded by record_cli.py or built
 * from backend/app/mcp/tools.py).
 */
import { esc, h, icon, p, E, set, clamp } from "./kit.js";

export function conversation(chat) {
  const items = [];
  const add = (t, el) => {
    const wrap = h(`<div style="overflow:hidden;flex:none;display:flex;flex-direction:column"></div>`);
    wrap.append(el);
    chat.scroll.append(wrap);
    const it = { t, wrap, el };
    items.push(it);
    return it;
  };
  return {
    user(t, text) { return add(t, h(`<div class="cf-msg user">${esc(text)}</div>`)); },
    userPaste(t, text, pasted) {
      return add(t, h(`<div class="cf-msg user">${esc(text)}<div style="margin-top:10px;display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:10px;background:var(--surface-raised);border:1px solid var(--border);font:600 14px/1.3 var(--font-sans);color:var(--text-secondary)">${icon("doc", { size: 18 })}<span>${esc(pasted)}</span></div></div>`));
    },
    ai(t, html) { return add(t, h(`<div class="cf-msg ai"><div class="cf-av">AI</div><div style="padding-top:4px">${html}</div></div>`)); },
    /** A tool call card; returns {el, at(t)} to drive its state. */
    tool(t, { server, name, args, result, progress = [], ran }) {
      const el = h(`<div class="cf-msg ai"><div class="cf-av" style="background:transparent"></div><div class="cf-tool" style="flex:1">
        <div class="hd">${icon("tool", { size: 16 })}<span><span class="srv">${esc(server)}</span> · ${esc(name)}</span><span class="sp"></span><span class="st"></span></div>
        <div class="bd args">${esc(args)}</div>
        <div class="bd pg" style="display:none"><div class="pm" style="font-family:var(--font-sans);font-weight:600;font-size:14px;color:var(--text-secondary)"></div><div class="prog"><i style="width:0"></i></div></div>
        <div class="bd res" style="display:none"></div></div></div>`);
      const it = add(t, el);
      const st = el.querySelector(".st"), pm = el.querySelector(".pm"), bar = el.querySelector(".prog i");
      const pr = el.querySelector(".bd.pg"), res = el.querySelector(".bd.res");
      res.textContent = result;
      it.at = (tt) => {
        const done = tt >= ran;
        // Progress: the last notification at or before tt.
        let cur = null;
        for (const q of progress) if (q.t <= tt) cur = q;
        pr.style.display = !done && cur ? "" : "none";
        if (cur) {
          pm.textContent = cur.message;
          bar.style.width = `${clamp(cur.total ? cur.progress / cur.total : 0) * 100}%`;
        }
        res.style.display = done ? "" : "none";
        const key = done ? "done" : "run";
        if (st.dataset.k !== key) {
          st.dataset.k = key;
          st.innerHTML = done ? `<span class="pill ok" style="height:26px;font-size:13px;padding:0 10px">${icon("check")} Done</span>` : `<span class="kit-spin" style="width:16px;height:16px"></span>`;
        }
        const sp = st.querySelector(".kit-spin");
        if (sp) sp.style.transform = `rotate(${(tt * 400) % 360}deg)`;
      };
      return it;
    },
    /** Lay out at time t: show what has appeared, growing in, newest in view. */
    at(t) {
      for (const it of items) {
        const k = p(t, it.t, it.t + 0.35, E.out);
        if (t < it.t) { it.wrap.style.display = "none"; continue; }
        it.wrap.style.display = "flex";
        if (it.at) it.at(t);
        it.wrap.style.height = "";
        const full = it.wrap.scrollHeight;
        it.wrap.style.height = `${(full * k).toFixed(2)}px`;
        set(it.el, { o: k, y: (1 - k) * 10 });
      }
      const ch = chat.scroll.scrollHeight, fh = chat.feed.clientHeight;
      chat.scroll.style.transform = `translateY(${Math.min(0, fh - ch).toFixed(2)}px)`;
    },
  };
}
