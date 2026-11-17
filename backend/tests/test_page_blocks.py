"""services/page_blocks.py: a page's Markdown as blocks (line ranges, anchors), headings by the
text a reader sees, sections, outline, tables and putting an anchor back. Pure: no database."""

from __future__ import annotations

import unittest

from app.services import page_blocks as pb

PAGE = """---
icon: x
---

Intro para {#b-intro1}

| Field | Value |
| --- | --- |
| Status {bg="blue"} | Draft |

{#b-tabl01 widths="120,240"}

## :span[Roll]{color=red}out **plan** {#b-roll01 bg=yellow}

```mermaid
graph TD
```
{#b-code01}

:::note{#b-note01}
Inside {#b-in0001}

```
## not a heading
```
:::

### Sub

## After
"""


class PageBlocks(unittest.TestCase):
    def test_split_ranges_and_anchors(self):
        lines, blocks = pb.parse(PAGE)
        got = [(b.kind, b.bid) for b in pb.all_blocks(blocks)]
        self.assertEqual(got, [("paragraph", "b-intro1"), ("table", "b-tabl01"), ("heading", "b-roll01"),
                               ("code", "b-code01"), ("container", "b-note01"), ("paragraph", "b-in0001"),
                               ("code", None), ("heading", None), ("heading", None)])
        table = blocks[1]
        self.assertEqual(lines[table.end - 1], '{#b-tabl01 widths="120,240"}')
        self.assertEqual(pb.find_block(blocks, "b-in0001")[0].kind, "paragraph")

    def test_headings_by_visible_text_or_anchor(self):
        lines, blocks = pb.parse(PAGE)
        for ref in ("rollout plan", "## Rollout Plan {bg=blue}", "b-roll01", "#b-roll01"):
            self.assertEqual(pb.find_heading(lines, blocks, ref).bid, "b-roll01", ref)
        self.assertIsNone(pb.find_heading(lines, blocks, "not a heading"))
        start, end, h = pb.section_range(lines, blocks, "Rollout plan")
        self.assertEqual(lines[end], "## After")  # the ### Sub inside it, the next ## ends it
        start, end, h = pb.section_range(lines, blocks, None)
        self.assertEqual((lines[start], h), ("", None))
        self.assertTrue(lines[end].startswith("## :span"))

    def test_outline_and_sections(self):
        o = pb.outline(PAGE)
        self.assertEqual([(h["level"], h["text"]) for h in o["headings"]], [(2, "Rollout plan"), (3, "Sub"), (2, "After")])
        self.assertEqual(o["tables"][0]["columns"], ["Field", "Value"])
        self.assertEqual({b["id"] for b in o["blocks"]}, {"b-intro1", "b-tabl01", "b-code01", "b-note01", "b-in0001"})
        md, missing = pb.sections_markdown(PAGE, ["After", "Nope"])
        self.assertEqual((md, missing), ("## After\n", ["Nope"]))

    def test_attach_id(self):
        self.assertEqual(pb.attach_id("Para", "b-zzzz99"), "Para {#b-zzzz99}")
        self.assertEqual(pb.attach_id("## H {bg=red}", "b-zzzz99"), "## H {#b-zzzz99 bg=red}")
        self.assertEqual(pb.attach_id("| a |\n|---|\n| 1 |", "b-zzzz99"), "| a |\n|---|\n| 1 |\n\n{#b-zzzz99}")
        self.assertEqual(pb.attach_id("```js\nx\n```", "b-zzzz99"), "```js\nx\n```\n{#b-zzzz99}")
        self.assertEqual(pb.attach_id(":::details[T]{open}\nx\n:::", "b-zzzz99"), ":::details[T]{#b-zzzz99 open}\nx\n:::")
        self.assertIsNone(pb.attach_id("Two\n\nblocks", "b-zzzz99"))
        self.assertIsNone(pb.attach_id("Has {#b-aaaa11}", "b-zzzz99"))

    def test_tables(self):
        lines, blocks = pb.parse(PAGE)
        t, tables = pb.find_table(lines, blocks, None)
        self.assertIs(t, tables[0])
        self.assertEqual(pb.cells(lines[pb.table_rows(lines, t)[0]]), ['Status {bg="blue"}', "Draft"])
        self.assertEqual(pb.cell_attrs('Status {bg="blue"}'), '{bg="blue"}')
        self.assertEqual(pb.cell_source("a | b\nc"), "a \\| b c")
        self.assertIs(pb.find_table(lines, blocks, "b-tabl01")[0], t)
        self.assertIsNone(pb.find_table(lines, blocks, "After")[0])


if __name__ == "__main__":
    unittest.main()
