/**
 * Block-level comparison of two pages' Markdown, for "Show changes" in version history.
 *
 * A page is split into top-level blocks (a paragraph, a heading, a list run, a whole fenced code
 * block, a whole `:::` container, a table with its options line) without parsing it, then the two
 * block lists are matched (longest common subsequence). The result is a list of segments, each a
 * run of blocks that are in both (`same`), only in the version shown (`add`) or only in the page
 * as it is now (`del`), ready to render one run at a time.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CONTAINER_OPEN = /^ {0,3}(:{3,})[A-Za-z]/;
const CONTAINER_CLOSE = /^ {0,3}(:{3,})\s*$/;
const MATH = /^ {0,3}\$\$\s*$/;
const OPTIONS_LINE = /^\{[^}\n]*\}\s*$/;
const LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;

/** Drops a leading front-matter block (the page's properties: icon, cover…). */
export function stripFront(markdown) {
  const src = String(markdown ?? "");
  const m = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  return m ? src.slice(m[0].length) : src;
}

/** The page body's top-level blocks, each as its own Markdown (trimmed of blank lines). */
export function splitBlocks(markdown) {
  const lines = stripFront(markdown).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let cur = [];
  let fence = null; // the fence string that opened a code block
  let math = false;
  const stack = []; // colon counts of open containers
  const flush = () => {
    while (cur.length && cur[cur.length - 1].trim() === "") cur.pop();
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
  };
  for (const line of lines) {
    if (fence) {
      cur.push(line);
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    if (math) {
      cur.push(line);
      if (MATH.test(line)) math = false;
      continue;
    }
    const fm = FENCE.exec(line);
    if (fm) {
      if (!stack.length && cur.length && !isContinuation(line)) flush();
      fence = fm[1];
      cur.push(line);
      continue;
    }
    if (MATH.test(line)) {
      if (!stack.length && cur.length) flush();
      math = true;
      cur.push(line);
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    if (open) {
      if (!stack.length && cur.length) flush();
      stack.push(open[1].length);
      cur.push(line);
      continue;
    }
    const close = CONTAINER_CLOSE.exec(line);
    if (close && stack.length) {
      // A closing fence (at least as many colons) closes the innermost container.
      if (stack[stack.length - 1] <= close[1].length) stack.pop();
      cur.push(line);
      if (!stack.length) flush();
      continue;
    }
    if (stack.length) {
      cur.push(line);
      continue;
    }
    if (line.trim() === "") {
      if (cur.length) cur.push(line);
      continue;
    }
    // After a blank line: a new block, unless it continues the last one (indented, an options
    // line belonging to the block above it).
    const afterBlank = cur.length > 0 && cur[cur.length - 1].trim() === "";
    if (afterBlank) {
      if (isContinuation(line) || OPTIONS_LINE.test(line.trim())) {
        cur.push(line);
        continue;
      }
      flush();
    } else if (cur.length && /^ {0,3}#{1,6}(\s|$)/.test(cur[cur.length - 1])) {
      // A heading is a block of its own even with no blank line after it.
      flush();
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

function isContinuation(line) {
  return /^(?: {2,}|\t)\S/.test(line);
}

const norm = (b) => b.replace(/[ \t]+$/gm, "").trim();

/**
 * Segments that turn `before` (the page now) into `after` (the version shown):
 * `[{ kind: "same" | "add" | "del", blocks: string[] }]`. A changed block shows as its old form
 * (del) directly followed by its new one (add).
 */
export function diffBlocks(before, after) {
  const a = splitBlocks(before);
  const b = splitBlocks(after);
  const na = a.map(norm);
  const nb = b.map(norm);
  // Common head and tail first: most versions differ in a few places.
  let head = 0;
  while (head < na.length && head < nb.length && na[head] === nb[head]) head++;
  let tail = 0;
  while (tail < na.length - head && tail < nb.length - head && na[na.length - 1 - tail] === nb[nb.length - 1 - tail]) tail++;
  const ops = [];
  for (let i = 0; i < head; i++) ops.push(["same", b[i]]);
  const ma = na.slice(head, na.length - tail);
  const mb = nb.slice(head, nb.length - tail);
  const ra = a.slice(head, a.length - tail);
  const rb = b.slice(head, b.length - tail);
  if (ma.length * mb.length > 4_000_000) {
    // Too big to match block by block: everything in between changed.
    for (const x of ra) ops.push(["del", x]);
    for (const x of rb) ops.push(["add", x]);
  } else {
    const m = ma.length;
    const n = mb.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = ma[i] === mb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && ma[i] === mb[j]) {
        ops.push(["same", rb[j]]);
        i++;
        j++;
      } else if (j < n && (i >= m || dp[i][j + 1] > dp[i + 1][j])) {
        ops.push(["add", rb[j]]);
        j++;
      } else {
        ops.push(["del", ra[i]]);
        i++;
      }
    }
  }
  for (let k = b.length - tail; k < b.length; k++) ops.push(["same", b[k]]);
  // Within a changed run, the removed blocks first, then the added ones.
  const runs = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k][0] === "same") {
      const blocks = [];
      while (k < ops.length && ops[k][0] === "same") blocks.push(ops[k++][1]);
      runs.push({ kind: "same", blocks });
      continue;
    }
    const del = [];
    const add = [];
    while (k < ops.length && ops[k][0] !== "same") (ops[k][0] === "del" ? del : add).push(ops[k++][1]);
    if (del.length) runs.push({ kind: "del", blocks: del });
    if (add.length) runs.push({ kind: "add", blocks: add });
  }
  return runs;
}

/** `{ added, removed }` block counts, for the summary line. */
export function diffStats(segments) {
  let added = 0;
  let removed = 0;
  for (const s of segments) {
    if (s.kind === "add") added += s.blocks.length;
    if (s.kind === "del") removed += s.blocks.length;
  }
  return { added, removed };
}
