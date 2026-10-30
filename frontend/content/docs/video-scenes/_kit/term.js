/**
 * A small terminal emulator for replaying recorded CLI sessions (record_cli.py) in a scene.
 *
 * Handles what the markdrop CLI and a shell print: text with auto-wrap, \r \n \b \t, SGR colours
 * (bold, faint, 16 colours), erase-in-line / erase-in-display, cursor moves and hide/show.
 * Rendering is a pure function of the bytes written so far: a scene rebuilds the screen from
 * `stream.at(t)` on every frame.
 */
import { rand, esc } from "./kit.js";

export class Term {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.lines = [[]];
    this.x = 0;
    this.y = 0;
    this.st = { fg: null, b: false, f: false };
    this.showCursor = true;
  }

  line(y) {
    while (this.lines.length <= y) this.lines.push([]);
    return this.lines[y];
  }

  put(ch) {
    if (this.x >= this.cols) { // auto-wrap
      this.x = 0;
      this.y++;
    }
    const l = this.line(this.y);
    while (l.length < this.x) l.push({ c: " ", s: null });
    l[this.x] = { c: ch, s: { ...this.st } };
    this.x++;
  }

  write(s) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\x1b") {
        const m = /^\x1b\[([?]?)([0-9;]*)([A-Za-z])/.exec(s.slice(i, i + 24));
        if (m) {
          this.csi(m[1], m[2], m[3]);
          i += m[0].length - 1;
          continue;
        }
        const o = /^\x1b[()][A-Z0-9]|^\x1b[=>78]/.exec(s.slice(i, i + 4));
        if (o) i += o[0].length - 1;
        continue;
      }
      if (ch === "\r") { this.x = 0; continue; }
      if (ch === "\n") { this.y++; this.line(this.y); continue; }
      if (ch === "\b") { this.x = Math.max(0, this.x - 1); continue; }
      if (ch === "\t") { const n = 8 - (this.x % 8); for (let k = 0; k < n; k++) this.put(" "); continue; }
      if (ch === "\x07") continue;
      this.put(ch);
    }
    return this;
  }

  csi(priv, args, cmd) {
    const nums = args ? args.split(";").map((v) => (v === "" ? 0 : Number(v))) : [];
    const n = nums[0] || 1;
    if (priv === "?") {
      if (args === "25") this.showCursor = cmd === "h";
      return;
    }
    switch (cmd) {
      case "m": {
        if (!nums.length) nums.push(0);
        for (const v of nums) {
          if (v === 0) this.st = { fg: null, b: false, f: false };
          else if (v === 1) this.st.b = true;
          else if (v === 2) this.st.f = true;
          else if (v === 22) { this.st.b = false; this.st.f = false; }
          else if (v >= 30 && v <= 37) this.st.fg = v - 30;
          else if (v >= 90 && v <= 97) this.st.fg = v - 90 + 8;
          else if (v === 39) this.st.fg = null;
        }
        break;
      }
      case "K": {
        const l = this.line(this.y);
        if (!nums[0]) l.length = Math.min(l.length, this.x);
        else if (nums[0] === 2) l.length = 0;
        else for (let k = 0; k < Math.min(this.x, l.length); k++) l[k] = { c: " ", s: null };
        break;
      }
      case "J": {
        if (nums[0] === 2 || nums[0] === 3) { this.lines = [[]]; this.x = 0; this.y = 0; }
        else { this.line(this.y).length = Math.min(this.line(this.y).length, this.x); this.lines.length = this.y + 1; }
        break;
      }
      case "A": this.y = Math.max(0, this.y - n); break;
      case "B": this.y += n; this.line(this.y); break;
      case "C": this.x = Math.min(this.cols - 1, this.x + n); break;
      case "D": this.x = Math.max(0, this.x - n); break;
      case "G": this.x = Math.max(0, n - 1); break;
      case "H": { const top = Math.max(0, this.lines.length - this.rows); this.y = top + (nums[0] || 1) - 1; this.x = (nums[1] || 1) - 1; break; }
      default: break;
    }
  }

  /** The visible screen as HTML (the last `rows` lines; the cursor block when shown). */
  html({ cursor = true } = {}) {
    const top = Math.max(0, Math.max(this.lines.length, this.y + 1) - this.rows);
    const out = [];
    for (let y = top; y < top + this.rows; y++) {
      const l = this.lines[y] || [];
      let row = "";
      let run = "", rs = null;
      const flush = () => {
        if (!run) return;
        row += rs ? `<span class="${cls(rs)}">${run}</span>` : run;
        run = "";
      };
      const n0 = Math.max(l.length, cursor && this.showCursor && y === this.y ? this.x + 1 : 0);
      for (let x = 0; x < n0; x++) {
        const cell = l[x] || { c: " ", s: null };
        if (cursor && this.showCursor && y === this.y && x === this.x) {
          flush();
          row += `<span class="cur">${esc(cell.c === " " ? " " : cell.c)}</span>`;
          rs = null;
          continue;
        }
        if (BLOCK[cell.c]) {
          // A run of block characters becomes one crisp SVG (no seams between cells).
          flush();
          let n = 0, rects = "";
          while (x + n < n0 && BLOCK[(l[x + n] || {}).c] && !(cursor && this.showCursor && y === this.y && x + n === this.x)) {
            const c = l[x + n];
            const fill = c.s && c.s.fg != null ? `var(--a${c.s.fg})` : "currentColor";
            const op = c.s && c.s.f ? ' opacity=".58"' : "";
            rects += BLOCK[c.c](n, fill, op);
            n++;
          }
          row += `<svg class="blkrun" style="width:${n}ch" viewBox="0 0 ${n} 2" preserveAspectRatio="none">${rects}</svg>`;
          x += n - 1;
          rs = null;
          continue;
        }
        const key = cell.s ? cls(cell.s) : "";
        if ((rs ? cls(rs) : "") !== key) { flush(); rs = cell.s && key ? cell.s : null; }
        run += esc(cell.c);
      }
      flush();
      out.push(`<div class="ln">${row || ""}</div>`);
    }
    return out.join("");
  }
}

function cls(s) {
  const c = [];
  if (s.b) c.push("b");
  if (s.f) c.push("f");
  if (s.fg != null) c.push(`c${s.fg}`);
  return c.join(" ");
}

// Block elements as SVG rects in a run's viewBox (one unit per cell, two per line).
const BLOCK = {
  "█": (x, f, op) => `<rect x="${x - 0.06}" y="-0.07" width="1.12" height="2.14" fill="${f}"${op}/>`,
  "▀": (x, f, op) => `<rect x="${x - 0.06}" y="-0.07" width="1.12" height="1.08" fill="${f}"${op}/>`,
  "▄": (x, f, op) => `<rect x="${x - 0.06}" y="0.99" width="1.12" height="1.08" fill="${f}"${op}/>`,
  "░": (x, f) => `<rect x="${x}" y="0.3" width="1" height="1.4" fill="${f}" opacity=".24"/>`,
};

// Colour classes for the 16 ANSI colours.
(() => {
  const st = document.createElement("style");
  st.textContent = Array.from({ length: 16 }, (_, i) => `.tf-screen .c${i}{color:var(--a${i})}`).join("");
  document.head.appendChild(st);
})();

/* ── Replay ────────────────────────────────────────────────────────────── */

/**
 * A timeline of writes to one terminal: `type()` a command at human pace after a prompt, `play()`
 * recorded output chunks, `write()` raw text at a time. `at(t)` is everything written by t.
 */
export class Stream {
  constructor() {
    this.ev = []; // [t, text]
  }
  write(t, s) { this.ev.push([t, s]); return t; }
  prompt(t, cwd) {
    return this.write(t, `\x1b[94;1m${cwd}\x1b[0m \x1b[92;1m❯\x1b[0m `);
  }
  /** Type `cmd` from time t; returns the time Enter is pressed. */
  type(t, cmd, { cps = 17, seed = 3, enterDelay = 0.38 } = {}) {
    const r = rand(seed);
    let tt = t;
    for (let i = 0; i < cmd.length; i++) {
      let d = (1 / cps) * (0.5 + r() * 0.95);
      if (cmd[i] === " ") d *= 1.45;
      tt += d;
      this.write(tt, cmd[i]);
    }
    tt += enterDelay;
    this.write(tt, "\r\n");
    return tt;
  }
  /**
   * Recorded chunks [[dt, text | {input}]] from time t. `map(dt)` turns recorded seconds into
   * scene seconds (to compress long waits); returns the time of the last chunk.
   */
  play(t, chunks, { map = (d) => d } = {}) {
    let last = t;
    for (const [dt, c] of chunks) {
      if (typeof c !== "string") continue; // typed input: the PTY's echo is in the next chunk
      last = t + map(dt);
      this.write(last, c);
    }
    return last;
  }
  at(t) {
    let s = "";
    for (const [tt, c] of this.ev) if (tt <= t) s += c;
    return s;
  }
}

/** Piecewise time map for recorded output: speed up or cap the gaps between chunks. */
export function gapMap(chunks, { scale = 1, maxGap = 1.5, minGap = 0 } = {}) {
  const times = chunks.map((c) => c[0]);
  const mapped = [];
  let prev = 0, acc = 0;
  for (const tt of times) {
    const g = Math.max(minGap, Math.min(maxGap, (tt - prev) * scale));
    acc += g;
    mapped.push([tt, acc]);
    prev = tt;
  }
  return (d) => {
    const hit = mapped.find((m) => m[0] === d);
    return hit ? hit[1] : d * scale;
  };
}

/** Render a Stream into a terminal frame's screen at time t (cursor blinks at 1 Hz when idle). */
export function renderTerm(screen, stream, t, cols, rows, { cursor = true } = {}) {
  const text = stream.at(t);
  const key = `${text.length}|${cursor}|${Math.floor(t * 2) % 2}`;
  if (screen._k === key) return;
  screen._k = key;
  const term = new Term(cols, rows).write(text);
  let lastT = 0;
  for (const [tt] of stream.ev) if (tt <= t) lastT = Math.max(lastT, tt);
  const blinkOff = t - lastT > 0.6 && Math.floor((t - lastT) * 1.6) % 2 === 1;
  screen.innerHTML = term.html({ cursor: cursor && !blinkOff });
}
