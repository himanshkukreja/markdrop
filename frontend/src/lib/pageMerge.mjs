/**
 * Three-way merge of a page's Markdown (front matter included), line by line, like `git merge`:
 * `base` is what the editor last loaded or saved, `mine` what it holds now, `theirs` the server's
 * newer version. Changes to different lines both survive; two edits of the same lines are a
 * conflict. Used when an editor's save meets a newer version (409) or it catches up after a missed
 * live event (components/pages/usePageEditSession.ts), and by the edit lock's take-over.
 *
 * Rules (decided for pages, where losing text is worse than an odd join):
 * - one side changed a stretch, the other left it alone: that side's change;
 * - both sides made the same change: once;
 * - both sides only ADDED lines at the same place (two appends to the end, an AI app's
 *   append_blocks while someone types a new last paragraph): theirs, then mine. Nothing is lost
 *   and no question is asked;
 * - changes to neighbouring lines that share no line of the base (two list items next to each
 *   other) merge; git would call them a conflict, people editing a list would not;
 * - anything else that overlaps is a conflict. `content` then takes theirs there (what other
 *   people already see) and `mineContent` takes mine there; `conflicts` lists each stretch.
 *
 * Plain JS so node --test runs it (pageMerge.test.mjs). No dependencies.
 */

const split = (s) => (s ?? "").split("\n");

/**
 * The edits that turn `a` into `b`: [{ start, end, lines }] — base lines [start, end) replaced by
 * `lines` (start === end: an insertion before line `start`). Sorted, never overlapping, never
 * touching (touching edits are joined). Myers' O(ND) diff on a trimmed middle.
 */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  if (!n && !m) return [];
  if (!n || !m) return [{ start: pre, end: pre + n, lines: B }];
  // Myers: keep each round's furthest-reaching x per diagonal, then walk back.
  const max = n + m;
  // A pathological pair (everything differs): one edit for the whole middle. Bounded work.
  const LIMIT = 4000;
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = -1;
  // …and bounded memory (each round keeps a copy of v).
  const rounds = Math.min(max, LIMIT, Math.floor(20_000_000 / (2 * max + 2)));
  for (let d = 0; d <= rounds; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return [{ start: pre, end: pre + n, lines: B }];
  // Walk back: the matched pairs (x, y) along the path.
  // trace[d] is the state before round d (James Coglan's walk-back).
  const pairs = [];
  let x = n, y = m;
  for (let d = found; d >= 0; d--) {
    const vp = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vp[off + k - 1] < vp[off + k + 1]) ? k + 1 : k - 1;
    const px = vp[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) {
      x--; y--;
      pairs.push([x, y]);
    }
    if (d === 0) break;
    x = px; y = py;
  }
  pairs.reverse();
  // Matched pairs → edits between them.
  const out = [];
  let ai = 0, bi = 0;
  const push = (ae, be) => {
    if (ai === ae && bi === be) return;
    const last = out[out.length - 1];
    if (last && last.end === pre + ai) {
      last.end = pre + ae;
      last.lines = last.lines.concat(B.slice(bi, be));
    } else out.push({ start: pre + ai, end: pre + ae, lines: B.slice(bi, be) });
  };
  for (const [pa, pb] of pairs) {
    push(pa, pb);
    ai = pa + 1; bi = pb + 1;
  }
  push(n, m);
  return out;
}

/** Base lines [start, end) as one side has them, given that side's edits. */
function sideText(base, edits, start, end) {
  const out = [];
  let i = start;
  for (const e of edits) {
    if (e.end < start || e.start > end) continue;
    while (i < e.start) out.push(base[i++]);
    out.push(...e.lines);
    i = Math.max(i, e.end);
  }
  while (i < end) out.push(base[i++]);
  return out;
}

const overlaps = (g, e) => {
  // Shares a base line, or an insertion strictly inside the other's stretch, or two insertions
  // at the same point.
  if (Math.max(g.start, e.start) < Math.min(g.end, e.end)) return true;
  if (e.start === e.end && g.start < e.start && e.start < g.end) return true;
  if (g.start === g.end && e.start < g.start && g.start < e.end) return true;
  return g.start === g.end && e.start === e.end && g.start === e.start;
};

/**
 * @param {string} base what the editor last loaded or saved
 * @param {string} mine what it holds now
 * @param {string} theirs the server's newer version
 * @returns {{ clean: boolean, content: string, mineContent: string, bothContent: string,
 *             conflicts: Array<{ base: string, mine: string, theirs: string }> }}
 */
export function merge3(base, mine, theirs) {
  base ??= ""; mine ??= ""; theirs ??= "";
  const same = (c) => ({ clean: true, content: c, mineContent: c, bothContent: c, conflicts: [] });
  if (mine === theirs || base === mine) return same(theirs);
  if (base === theirs) return same(mine);
  const B = split(base);
  const ours = diffLines(B, split(mine)).map((e) => ({ ...e, side: "mine" }));
  const other = diffLines(B, split(theirs)).map((e) => ({ ...e, side: "theirs" }));
  const all = [...ours, ...other].sort((a, b) => a.start - b.start || a.end - b.end || (a.side === "theirs" ? -1 : 1));
  // Group edits that touch the same base lines.
  const groups = [];
  for (const e of all) {
    const g = groups[groups.length - 1];
    if (g && overlaps(g, e)) {
      g.start = Math.min(g.start, e.start);
      g.end = Math.max(g.end, e.end);
      g.edits.push(e);
    } else groups.push({ start: e.start, end: e.end, edits: [e] });
  }
  const left = [], right = [], both = [], conflicts = [];
  const all3 = (lines) => { left.push(...lines); right.push(...lines); both.push(...lines); };
  let i = 0;
  for (const g of groups) {
    while (i < g.start) all3([B[i++]]);
    const m = g.edits.filter((e) => e.side === "mine");
    const t = g.edits.filter((e) => e.side === "theirs");
    const mt = sideText(B, m, g.start, g.end);
    const tt = sideText(B, t, g.start, g.end);
    // Theirs, then mine; a blank line between two stretches keeps them two blocks.
    const join = () => [...tt, ...(tt.length && mt.length && tt[tt.length - 1] !== "" && mt[0] !== "" ? [""] : []), ...mt];
    if (!m.length) all3(tt);
    else if (!t.length) all3(mt);
    else if (mt.join("\n") === tt.join("\n")) all3(tt);
    else if (g.start === g.end) all3(join()); // both only added here: nothing lost, no question
    else {
      conflicts.push({ base: B.slice(g.start, g.end).join("\n"), mine: mt.join("\n"), theirs: tt.join("\n") });
      left.push(...tt); right.push(...mt); both.push(...join());
    }
    i = Math.max(i, g.end);
  }
  while (i < B.length) all3([B[i++]]);
  return { clean: conflicts.length === 0, content: left.join("\n"), mineContent: right.join("\n"), bothContent: both.join("\n"), conflicts };
}
