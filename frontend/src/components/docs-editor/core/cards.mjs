/**
 * Moving a card inside a card grid, or into another grid, as one ProseMirror transaction step
 * list. The card node moves whole (its `md` source bookkeeping too), so the Markdown keeps the
 * card's own text byte for byte and only the order of the `:::card` blocks changes.
 *
 * No React and no TipTap imports: the card view (views/containers.tsx) and the tests
 * (test/cards.test.mjs) call the same functions on a Transaction.
 */

/** Each card's `md.gap` (the whitespace written before it), by position in a grid. */
const gapsOf = (grid) => {
  const out = [];
  grid.forEach((c) => out.push(c.attrs.md?.gap ?? null));
  return out;
};

/**
 * The cards with the grid's whitespace kept by position: the card now k-th is written after the
 * gap the k-th card had (a grid written tight stays tight, whichever card moved where).
 */
function regap(kids, gaps, fallback) {
  const known = gaps.filter((g) => typeof g === "string");
  return kids.map((c, k) => {
    const md = c.attrs.md;
    if (!md) return c;
    const gap = k === 0 ? null : gaps[k] ?? known[known.length - 1] ?? fallback ?? md.gap ?? null;
    return gap === (md.gap ?? null) ? c : c.type.create({ ...c.attrs, md: { ...md, gap } }, c.content, c.marks);
  });
}

/** `regap` on the grid at `gridPos` in place (attribute steps only, so other positions keep mapping). */
function keepGaps(tr, gridPos, gaps, fallback) {
  const grid = tr.doc.nodeAt(gridPos);
  const kids = [];
  grid.forEach((c) => kids.push(c));
  const next = regap(kids, gaps, fallback);
  let pos = gridPos + 1;
  kids.forEach((c, k) => {
    if (next[k] !== c) tr.setNodeMarkup(pos, undefined, next[k].attrs);
    pos += c.nodeSize;
  });
}

/** The card at `pos` and its grid, or null when `pos` isn't a card in a `cards` grid. */
export function cardAt(doc, pos) {
  const card = doc.nodeAt(pos);
  if (!card || card.type.name !== "card") return null;
  const $pos = doc.resolve(pos);
  if ($pos.parent.type.name !== "cards") return null;
  return { card, grid: $pos.parent, gridPos: $pos.before(), index: $pos.index() };
}

/**
 * Moves the card at `from` so it sits before the card now at index `to` of the grid at `gridPos`
 * (`to` = the grid's card count puts it last). Indexes count the grid as it is before the move.
 * Moving the only card out of a grid removes that grid (a grid holds at least one card).
 * Returns the card's new position, or null when nothing moves (same place, not a card, or a
 * target inside the card itself).
 */
export function moveCard(tr, from, gridPos, to) {
  const doc = tr.doc;
  const src = cardAt(doc, from);
  const grid = doc.nodeAt(gridPos);
  if (!src || !grid || grid.type.name !== "cards") return null;
  const { card } = src;
  const at = Math.max(0, Math.min(grid.childCount, Math.floor(to)));

  if (src.gridPos === gridPos) {
    const i = src.index;
    const j = at > i ? at - 1 : at;
    if (j === i) return null;
    const kids = [];
    grid.forEach((c) => kids.push(c));
    kids.splice(i, 1);
    kids.splice(j, 0, card);
    const next = regap(kids, gapsOf(grid));
    tr.replaceWith(gridPos + 1, gridPos + grid.nodeSize - 1, next);
    let pos = gridPos + 1;
    for (let k = 0; k < j; k++) pos += next[k].nodeSize;
    return pos;
  }

  // Into another grid: never into a grid inside the card being moved.
  if (gridPos > from && gridPos < from + card.nodeSize) return null;
  // A card coming into a one-card grid is written with the gap its old grid used.
  const fallback = card.attrs.md?.gap ?? gapsOf(src.grid).filter((g) => typeof g === "string").pop();
  // The grid it leaves: the other cards close up, or the grid goes with its only card.
  if (src.grid.childCount === 1) tr.delete(src.gridPos, src.gridPos + src.grid.nodeSize);
  else {
    tr.delete(from, from + card.nodeSize);
    keepGaps(tr, tr.mapping.map(src.gridPos), gapsOf(src.grid));
  }
  const tpos = tr.mapping.map(gridPos);
  const target = tr.doc.nodeAt(tpos);
  const gaps = gapsOf(target);
  let insert = tpos + 1;
  for (let k = 0; k < at; k++) insert += target.child(k).nodeSize;
  tr.insert(insert, card);
  keepGaps(tr, tpos, gaps, fallback);
  return insert;
}

/** Moves the card at `pos` one place earlier (-1) or later (1) in its grid. Returns the new position or null. */
export function stepCard(tr, pos, dir) {
  const src = cardAt(tr.doc, pos);
  if (!src) return null;
  const j = src.index + dir;
  if (j < 0 || j >= src.grid.childCount) return null;
  return moveCard(tr, pos, src.gridPos, dir > 0 ? j + 1 : j);
}
