"""Quality fixes from the surfaces 3-5 eval (.work/ai-eval, page AI / comments AI / analytics AI), as pure checks:
no model, no database.

- Page AI: a translation may move a currency symbol ("$12 … $99" isn't inline math), but can't empty a directive's
  label; block anchor ids a suggestion made up are dropped, ids the page has stay.
- Comments AI: @AI on a long page gets the parts that matter to the question (not just the first 8,000 characters);
  a thread is described with the sentence its quote sits in.
- Analytics AI: a story headline past 12 words is cut at its first clause break.
"""

from __future__ import annotations

import unittest

from app.services import analytics_ai_home as aah
from app.services import pages_ai
from app.services.comments import ai as comments_ai


class TranslationStructure(unittest.TestCase):
    def test_prices_are_not_math(self):
        src = "**Pricing:** $12 per seat per month, $99 minimum."
        self.assertIsNone(pages_ai.structure_diff(src, "**Precio:** 12 $ por usuario al mes, mínimo de 99 $."))

    def test_math_is_still_kept(self):
        self.assertIsNotNone(pages_ai.structure_diff("Area $x^2$ here", "Área $x^3$ aquí"))
        self.assertIsNone(pages_ai.structure_diff("Area $x^2$ here", "Área $x^2$ aquí"))
        self.assertIsNotNone(pages_ai.structure_diff("$$a+b$$", "$$a-b$$"))

    def test_a_label_can_be_translated_but_not_emptied(self):
        src = ':span[Important]{color="red"} text'
        self.assertIsNone(pages_ai.structure_diff(src, ':span[Wichtig]{color="red"} Text'))
        self.assertIsNotNone(pages_ai.structure_diff(src, ':span[]{color="red"} Text'))
        # A stored mention has no label (it's filled at render time): it stays empty.
        self.assertIsNone(pages_ai.structure_diff(':markdrop[]{src="a"} x', ':markdrop[]{src="a"} y'))


class MadeUpIds(unittest.TestCase):
    def test_made_up_ids_dropped_real_ones_kept(self):
        page = "Intro. {#b-p1aaaa}\n\nMore. {#b-p2bbbb}"
        out = pages_ai.drop_new_ids("## Beta support\n\nText.\n\n{#b-k3x9a1}", page)
        self.assertEqual(out, "## Beta support\n\nText.")
        out = pages_ai.drop_new_ids('A. {#b-k3x9a1 color="green"}\nB. {#b-p1aaaa}', page)
        self.assertEqual(out, 'A. {color="green"}\nB. {#b-p1aaaa}')
        self.assertEqual(pages_ai.drop_new_ids("No ids here {x}", page), "No ids here {x}")

    def test_syntax_notes_have_no_concrete_id_to_copy(self):
        self.assertNotIn("b-k3x9a1", pages_ai.PAGE_SYNTAX)


class CommentsContext(unittest.TestCase):
    def test_long_page_sends_the_relevant_parts(self):
        filler = "\n\n".join(f"Background note {i}: research and finance details." for i in range(400))
        text = f"Atlas pricing proposal\n\n{filler}\n\nAnnual plans get two months free, and the enterprise floor is $25,000 ARR."
        out = comments_ai.relevant_parts(text, "What's the enterprise floor? Do annual plans get a discount?", "", 3000)
        self.assertIn("$25,000 ARR", out)
        self.assertIn("Atlas pricing proposal", out)
        self.assertIn(comments_ai.GAP, out)
        self.assertLessEqual(len(out), 3200)

    def test_thread_is_about_its_sentence(self):
        t = {"anchor": {"quote": {"exact": "for 12 months"},
                        "block_text": "Customers on the legacy plan migrate at their current price for 12 months."}}
        about = comments_ai._about(t)
        self.assertIn('"for 12 months"', about)
        self.assertIn("legacy plan", about)
        self.assertEqual(comments_ai._about({"anchor": {}}), "")


class StoryHeadline(unittest.TestCase):
    def test_long_headline_cut_at_a_clause(self):
        self.assertEqual(aah.short_headline("Views rose 50% to 224, driven by a Hacker News spike on the Atlas setup guide"),
                         "Views rose 50% to 224")
        self.assertEqual(aah.short_headline("Views doubled this week"), "Views doubled this week")


if __name__ == "__main__":
    unittest.main()
