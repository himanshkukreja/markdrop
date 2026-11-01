/**
 * Reordering cards (the card grid's drag handle, its Move left / Move right menu and Alt+arrow
 * keys): the transaction moves the card node whole, so the written Markdown is the same cards in
 * the new order, each card's own text untouched, and it reads back as the edited document.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@tiptap/pm/state";
import { parseMarkdown, serializeMarkdown } from "../core/markdown.mjs";
import { cardAt, moveCard, stepCard } from "../core/cards.mjs";
import { schema, sameContent } from "./helpers.mjs";

const ONE = ':::card[One]{href="/a" icon="zap"}\nBody one, with **bold**.\n:::\n';
const TWO = ':::card[Two]{href="/b"}\nBody two.\n\n- a list\n:::\n';
const THREE = ":::card[Three]\nThree.\n:::\n";
const grid = (...cards) => `::::cards{cols="2"}\n${cards.join("")}::::\n`;

function load(md) {
  const state = parseMarkdown(md);
  return { md: state, pm: EditorState.create({ schema, doc: schema.nodeFromJSON(state.doc) }) };
}

/** Positions of every card grid and its cards, in document order. */
function grids(doc) {
  const out = [];
  doc.descendants((n, pos) => {
    if (n.type.name !== "cards") return true;
    const cards = [];
    n.forEach((_c, off) => cards.push(pos + 1 + off));
    out.push({ pos, cards });
    return true;
  });
  return out;
}

/** Applies `edit(tr, doc)` and returns the Markdown the editor would write (and checks it reads back). */
function after(md, edit) {
  const { md: state, pm } = load(md);
  const tr = pm.tr;
  const res = edit(tr, pm.doc);
  const doc = pm.apply(tr).doc;
  doc.check();
  const out = serializeMarkdown({ ...state, doc: doc.toJSON() });
  assert.ok(sameContent(out, serializeMarkdown({ ...state, doc: doc.toJSON() }, { preserve: false })), "reads back as the edited document");
  return { out, res, doc };
}

test("drag the last card first: the cards are written in the new order, each verbatim", () => {
  const src = `# Start\n\n${grid(ONE, TWO, THREE)}\nAfter.\n`;
  const { out, res, doc } = after(src, (tr, d) => {
    const [g] = grids(d);
    return moveCard(tr, g.cards[2], g.pos, 0);
  });
  assert.equal(out, `# Start\n\n${grid(THREE, ONE, TWO)}\nAfter.\n`);
  assert.equal(doc.nodeAt(res).attrs.label, "Three");
});

test("drag a card later: `to` counts the grid before the move", () => {
  const src = grid(ONE, TWO, THREE);
  const move = (from, to) => after(src, (tr, d) => {
    const [g] = grids(d);
    return moveCard(tr, g.cards[from], g.pos, to);
  });
  assert.equal(move(0, 2).out, grid(TWO, ONE, THREE));
  assert.equal(move(0, 3).out, grid(TWO, THREE, ONE));
  assert.equal(move(1, 0).out, grid(TWO, ONE, THREE));
});

test("dropping a card where it already is changes nothing", () => {
  const src = grid(ONE, TWO, THREE);
  for (const to of [1, 2]) {
    const { out, res } = after(src, (tr, d) => {
      const [g] = grids(d);
      return moveCard(tr, g.cards[1], g.pos, to);
    });
    assert.equal(res, null);
    assert.equal(out, src);
  }
});

test("Move left / Move right step one place and stop at the ends", () => {
  const src = grid(ONE, TWO, THREE);
  const step = (i, dir) => after(src, (tr, d) => stepCard(tr, grids(d)[0].cards[i], dir));
  assert.equal(step(1, -1).out, grid(TWO, ONE, THREE));
  assert.equal(step(1, 1).out, grid(ONE, THREE, TWO));
  assert.equal(step(0, -1).res, null);
  assert.equal(step(2, 1).res, null);
  assert.equal(step(2, 1).out, src);
});

test("a card dragged into another grid leaves the first grid with the rest", () => {
  const second = '::::cards\n:::card[Four]{icon="book"}\nFour.\n:::\n::::\n';
  const src = `${grid(ONE, TWO, THREE)}\nBetween.\n\n${second}`;
  const { out } = after(src, (tr, d) => {
    const [a, b] = grids(d);
    return moveCard(tr, a.cards[0], b.pos, 1);
  });
  assert.equal(out, `${grid(TWO, THREE)}\nBetween.\n\n::::cards\n:::card[Four]{icon="book"}\nFour.\n:::\n${ONE}::::\n`);
  // And back up again, before the first card.
  const { out: back } = after(src, (tr, d) => {
    const [a, b] = grids(d);
    return moveCard(tr, b.cards[0], a.pos, 0);
  });
  assert.ok(back.startsWith(`::::cards{cols="2"}\n:::card[Four]{icon="book"}\nFour.\n:::\n${ONE}${TWO}${THREE}::::\n`));
  // The second grid held only that card: it goes (a grid always holds a card).
  assert.ok(!back.includes("Between.\n\n::::cards"), back);
});

test("a card can't be dropped into a grid inside itself", () => {
  const src = "::::::cards\n:::::card[Outer]\nOuter.\n\n::::cards\n:::card[Inner]\nInner.\n:::\n::::\n:::::\n:::::card[Next]\nNext.\n:::::\n::::::\n";
  const { res, out } = after(src, (tr, d) => {
    const [outer, inner] = grids(d);
    return moveCard(tr, outer.cards[0], inner.pos, 0);
  });
  assert.equal(res, null);
  assert.equal(out, src);
  // The inner card out to the outer grid, and the next card into the inner grid, are fine.
  const { out: up } = after(src, (tr, d) => {
    const [outer, inner] = grids(d);
    return moveCard(tr, inner.cards[0], outer.pos, 2);
  });
  assert.ok(up.endsWith(":::::card[Next]\nNext.\n:::::\n:::card[Inner]\nInner.\n:::\n::::::\n"), up);
  assert.ok(!/^::::cards$/m.test(up), up);
  const { out: down } = after(src, (tr, d) => {
    const [outer, inner] = grids(d);
    return moveCard(tr, outer.cards[1], inner.pos, 1);
  });
  assert.ok(down.includes(":::card[Inner]\nInner.\n:::\n"), down);
  assert.ok(/Next\.\n:{3,}\n:{4,}\n:{5,}\n:{6,}\n$/.test(down), down);
});

test("cardAt finds only cards in a grid", () => {
  const { pm } = load(`Text.\n\n${grid(ONE, TWO)}`);
  const [g] = grids(pm.doc);
  assert.equal(cardAt(pm.doc, 0), null);
  assert.equal(cardAt(pm.doc, g.pos), null);
  const c = cardAt(pm.doc, g.cards[1]);
  assert.equal(c.index, 1);
  assert.equal(c.gridPos, g.pos);
  assert.equal(c.card.attrs.label, "Two");
});
