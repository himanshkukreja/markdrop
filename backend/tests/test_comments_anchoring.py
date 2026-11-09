"""Comment anchors (services/comments/anchoring.py): plain text, making anchors, and re-anchoring
after edits — including property tests over random edits (seeded, deterministic).

Pure functions: no database.
"""

from __future__ import annotations

import random
import string
import unittest

from app.services.comments import anchoring as a

PAGE = """---
icon: 🚀
---
# Launch plan {#b-h1aaaa}

We will ship **the new editor** on [Monday](https://example.com) with :person[Ada Lovelace]{id="u1"} leading. {#b-p1aaaa}

- first item {#b-li1aaa}
- [ ] second task here {#b-li2aaa}

| Owner | Due |
|---|---|
| Ada | Friday |

:::callout{#b-cal1aa icon=bulb}
Inside the callout text.

Second paragraph in it.
:::

:::toggle[Read more]{#b-tog1aa}
Hidden text inside. {#b-hid1aa}
:::

```js
const answer = 42;
```

Closing words of the page.
"""


def _joined(md: str) -> str:
    return " ".join(b.text for b in a.blocks(md))


class PlainText(unittest.TestCase):
    def test_blocks_and_text(self):
        bl = a.blocks(PAGE)
        texts = [b.text for b in bl]
        self.assertEqual(texts[0], "Launch plan")
        self.assertEqual(texts[1], "We will ship the new editor on Monday with Ada Lovelace leading.")
        self.assertIn("first item", texts)
        self.assertIn("second task here", texts)
        self.assertIn("Ada Friday", texts)
        self.assertIn("Read more", texts)
        self.assertIn("const answer = 42;", texts)
        self.assertNotIn("icon", " ".join(texts))  # front matter
        self.assertFalse(any("{#" in t or ":::" in t for t in texts))
        bids = {b.text: b.bid for b in bl}
        self.assertEqual(bids["Launch plan"], "b-h1aaaa")
        self.assertEqual(bids["second task here"], "b-li2aaa")
        # Text inside a container without its own id belongs to the container's block.
        self.assertEqual(bids["Inside the callout text."], "b-cal1aa")
        self.assertEqual(bids["Hidden text inside."], "b-hid1aa")
        self.assertEqual(bids["Read more"], "b-tog1aa")
        # Offsets line up with plain_text.
        full = a.plain_text(PAGE)
        for b in bl:
            self.assertEqual(full[b.start:b.end], b.text)

    def test_normalise(self):
        self.assertEqual(a.normalise("  a\n\tb  c  "), "a b c")
        self.assertEqual(a.normalise("é"), "é")
        self.assertEqual(a.normalise(None), "")

    def test_empty(self):
        self.assertEqual(a.blocks(""), [])
        self.assertEqual(a.blocks(None), [])
        self.assertEqual(a.plain_text("---\nx: 1\n---\n"), "")


class Making(unittest.TestCase):
    def test_text_anchor_with_context(self):
        anc = a.make_anchor(PAGE, {"type": "text", "quote": {"exact": "the new editor", "prefix": "We will ship ",
                                                              "suffix": " on Monday"}}, 3)
        self.assertEqual(anc["type"], "text")
        self.assertEqual(anc["block_id"], "b-p1aaaa")
        self.assertEqual(anc["quote"]["exact"], "the new editor")
        self.assertTrue(anc["quote"]["prefix"].endswith("We will ship "))
        self.assertTrue(anc["quote"]["suffix"].startswith(" on Monday"))
        self.assertEqual(anc["rev"], 3)
        full = _joined(PAGE)
        self.assertEqual(full[anc["start"]:anc["start"] + len("the new editor")], "the new editor")

    def test_repeats_use_context_and_block(self):
        md = "Alpha beta gamma. {#b-aaaa11}\n\nAlpha beta delta. {#b-bbbb22}\n"
        second = a.make_anchor(md, {"type": "text", "quote": {"exact": "Alpha beta", "suffix": " delta"}}, 1)
        self.assertEqual(second["block_id"], "b-bbbb22")
        by_block = a.make_anchor(md, {"type": "text", "block_id": "b-bbbb22", "quote": {"exact": "beta"}}, 1)
        self.assertEqual(by_block["block_id"], "b-bbbb22")

    def test_selection_across_blocks(self):
        anc = a.make_anchor(PAGE, {"type": "text", "quote": {"exact": "leading.\nfirst item"}}, 1)
        self.assertEqual(anc["quote"]["exact"], "leading. first item")

    def test_block_and_page_anchors(self):
        b = a.make_anchor(PAGE, {"type": "block", "block_id": "b-li2aaa"}, 1)
        self.assertEqual((b["type"], b["block_text"]), ("block", "second task here"))
        b2 = a.make_anchor(PAGE, {"type": "block", "block_text": "Closing words of the page."}, 1)
        self.assertEqual(b2["block_text"], "Closing words of the page.")
        self.assertEqual(a.make_anchor(PAGE, {"type": "page"}, 7)["type"], "page")

    def test_not_found(self):
        with self.assertRaises(a.AnchorError):
            a.make_anchor(PAGE, {"type": "text", "quote": {"exact": "nowhere on this page at all"}}, 1)
        with self.assertRaises(a.AnchorError):
            a.make_anchor(PAGE, {"type": "block", "block_id": "b-zzzzzz"}, 1)
        with self.assertRaises(a.AnchorError):
            a.make_anchor(PAGE, {"type": "text", "quote": {"exact": "   "}}, 1)

    def test_rendered_text_the_server_cant_see_stays_on_its_block(self):
        # Math renders differently from its source: the quote is kept, tied to its block.
        md = "Energy is $E = mc^2$ here. {#b-math11}\n"
        anc = a.make_anchor(md, {"type": "text", "block_id": "b-math11", "quote": {"exact": "E=mc2"}}, 1)
        self.assertTrue(anc.get("loose"))
        new, status = a.resolve(md + "\nMore.\n", anc, 2)
        self.assertEqual(status, "attached")
        new, status = a.resolve("Something else entirely.\n", anc, 3)
        self.assertEqual(status, "changed")

    def test_from_quote_markdown_or_text(self):
        anc = a.anchor_from_quote(PAGE, "**the new editor**", 2)
        self.assertEqual(anc["quote"]["exact"], "the new editor")
        anc2 = a.anchor_from_quote("x y x y x\n", "x", 1, occurrence=3)
        self.assertEqual(anc2["start"], 8)
        with self.assertRaises(a.AnchorError):
            a.anchor_from_quote("x y\n", "x", 1, occurrence=2)


class Resolving(unittest.TestCase):
    def setUp(self):
        self.anc = a.make_anchor(PAGE, {"type": "text", "quote": {"exact": "the new editor"}}, 1)

    def test_text_moves_with_edits_around_it(self):
        md = PAGE.replace("We will ship", "Next week we will finally ship").replace("# Launch plan", "# The plan")
        new, status = a.resolve(md, self.anc, 2)
        self.assertEqual(status, "attached")
        self.assertEqual(new["quote"]["exact"], "the new editor")
        self.assertEqual(new["rev"], 2)

    def test_small_change_inside_the_quote_follows_fuzzily(self):
        new, status = a.resolve(PAGE.replace("the new editor", "the new editr"), self.anc, 2)
        self.assertEqual(status, "attached")
        self.assertEqual(new["quote"]["exact"], "the new editr")

    def test_removed_text_is_changed_and_can_come_back(self):
        gone = PAGE.replace("We will ship **the new editor** on", "Nothing about it")
        new, status = a.resolve(gone, self.anc, 2)
        self.assertEqual(status, "changed")
        self.assertEqual(new["quote"]["exact"], "the new editor")  # last good quote kept
        back, status = a.resolve(PAGE, new, 3)
        self.assertEqual(status, "attached")

    def test_block_moved_keeps_its_anchor(self):
        b = a.make_anchor(PAGE, {"type": "block", "block_id": "b-li2aaa"}, 1)
        moved = PAGE.replace("- [ ] second task here {#b-li2aaa}\n", "") + "\n- [ ] second task here {#b-li2aaa}\n"
        new, status = a.resolve(moved, b, 2)
        self.assertEqual(status, "attached")
        self.assertEqual(new["block_text"], "second task here")
        edited = PAGE.replace("second task here", "second task, reworded")
        self.assertEqual(a.resolve(edited, b, 3)[1], "attached")  # same id
        self.assertEqual(a.resolve(PAGE.replace("- [ ] second task here {#b-li2aaa}\n", ""), b, 4)[1], "changed")

    def test_page_anchor_always_attached(self):
        p = a.make_anchor(PAGE, {"type": "page"}, 1)
        self.assertEqual(a.resolve("", p, 2)[1], "attached")

    def test_classic_markdown_without_ids(self):
        md = "# Notes\n\nFirst paragraph here.\n\nSecond paragraph, the important one.\n"
        b = a.make_anchor(md, {"type": "block", "block_text": "Second paragraph, the important one."}, 1)
        new, status = a.resolve("# Notes\n\nA new first.\n\nFirst paragraph here.\n\nSecond paragraph, the important one.\n", b, 2)
        self.assertEqual(status, "attached")
        self.assertEqual(new["block_index"], 3)


# ── Property tests: random edits ──────────────────────────────────────────────

WORDS = ("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau "
         "upsilon phi chi psi omega ship plan editor launch review budget draft owner team page").split()


def _para(rng: random.Random, n: int) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(n)).capitalize() + "."


def _doc(rng: random.Random) -> list[str]:
    paras = []
    for i in range(rng.randint(4, 10)):
        bid = "b-" + "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        kind = rng.random()
        text = _para(rng, rng.randint(6, 18))
        if kind < 0.2:
            paras.append(f"## {text[:-1]} {{#{bid}}}")
        elif kind < 0.4:
            paras.append(f"- {text} {{#{bid}}}")
        else:
            paras.append(f"{text} {{#{bid}}}")
    return paras


def _md(paras: list[str]) -> str:
    return "\n\n".join(paras) + "\n"


def _untouched_edit(rng: random.Random, paras: list[str], keep: int) -> list[str]:
    """An edit that leaves paragraph ``keep`` alone: insert, delete or rewrite another paragraph."""
    out = list(paras)
    op = rng.choice(("insert", "delete", "rewrite", "move"))
    others = [i for i in range(len(out)) if i != keep]
    if op == "insert" or not others:
        out.insert(rng.randint(0, len(out)), _para(rng, rng.randint(3, 12)))
    elif op == "delete":
        out.pop(rng.choice(others))
    elif op == "rewrite":
        i = rng.choice(others)
        out[i] = _para(rng, rng.randint(3, 12))
    else:
        i = keep
        item = out.pop(i)
        out.insert(rng.randint(0, len(out)), item)
    return out


class RandomEdits(unittest.TestCase):
    def _quote(self, rng, paras):
        k = rng.randrange(len(paras))
        text = [b for b in a.blocks(paras[k])][0].text
        words = text.split(" ")
        i = rng.randrange(len(words))
        j = min(len(words), i + rng.randint(2, 5))
        return k, " ".join(words[i:j])

    def test_edits_elsewhere_keep_the_anchor(self):
        for seed in range(300):
            rng = random.Random(seed)
            paras = _doc(rng)
            k, quote = self._quote(rng, paras)
            md = _md(paras)
            bid = a.blocks(paras[k])[0].bid
            try:
                # The browser sends the block the selection is in (its data-bid).
                anc = a.make_anchor(md, {"type": "text", "block_id": bid, "quote": {"exact": quote}}, 1)
            except a.AnchorError:
                self.fail(f"seed {seed}: quote not found at creation")
            target = paras[k]
            for step in range(5):
                paras = _untouched_edit(rng, paras, paras.index(target))
                md = _md(paras)
                anc, status = a.resolve(md, anc, step + 2)
                self.assertEqual(status, "attached", f"seed {seed} step {step}")
                self.assertEqual(anc["quote"]["exact"], a.normalise(quote), f"seed {seed} step {step}")
                full = _joined(md)
                self.assertEqual(full[anc["start"]:anc["start"] + len(anc["quote"]["exact"])], anc["quote"]["exact"])
                # The text it lands on is in the paragraph it was on.
                self.assertEqual(anc["block_text"], a.blocks(target)[0].text[:280], f"seed {seed}")

    def test_any_edit_attached_means_the_text_is_there(self):
        """Whatever the edit, an ``attached`` anchor's quote is exactly the text at its position; a removed
        quote is ``changed`` unless similar text remains."""
        for seed in range(300):
            rng = random.Random(10_000 + seed)
            paras = _doc(rng)
            k, quote = self._quote(rng, paras)
            anc = a.make_anchor(_md(paras), {"type": "text", "quote": {"exact": quote}}, 1)
            for step in range(6):
                op = rng.random()
                if op < 0.3:
                    paras[k] = paras[k].replace(quote, "")  # the quote goes
                elif op < 0.5 and len(quote) > 6:
                    pos = rng.randrange(1, len(quote) - 1)
                    paras[k] = paras[k].replace(quote, quote[:pos] + rng.choice("xyz") + quote[pos + 1:])
                else:
                    paras = _untouched_edit(rng, paras, k)
                    k = min(k, len(paras) - 1)
                md = _md(paras)
                anc, status = a.resolve(md, anc, step + 2)
                full = _joined(md)
                if status == "attached" and not anc.get("loose"):
                    ex = anc["quote"]["exact"]
                    self.assertEqual(full[anc["start"]:anc["start"] + len(ex)], ex, f"seed {seed}")
                if status == "changed":
                    self.assertTrue(anc["quote"]["exact"])  # the last good quote is kept
                quote = anc["quote"]["exact"]

    def test_quote_removed_everywhere_is_changed(self):
        for seed in range(100):
            rng = random.Random(50_000 + seed)
            paras = _doc(rng)
            # A distinctive quote only in one place.
            k = rng.randrange(len(paras))
            paras.insert(k, "Some zzunique marker words here.")
            anc = a.make_anchor(_md(paras), {"type": "text", "quote": {"exact": "zzunique marker words"}}, 1)
            paras.pop(k)
            _new, status = a.resolve(_md(paras), anc, 2)
            self.assertEqual(status, "changed", f"seed {seed}")


if __name__ == "__main__":
    unittest.main()
