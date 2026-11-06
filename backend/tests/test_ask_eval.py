"""The Ask Markdrop eval harness, offline (tests/ask_eval; the real-model run is manual, see run.py).

Seeds the eval world (no noise), asks the access, profile and personal questions through POST /api/v1/ask
with the fake model, and checks what never depends on the model: no restricted text reaches any prompt for
someone outside it, every prompt names the right asker, nothing errors, and the grader's own rules.
"""

from __future__ import annotations

import unittest

from tests.ask_eval import grade as G
from tests.ask_eval import questions as QS
from tests.ask_eval.run import EvalWorld, selected
from tests.ask_eval.world import PEOPLE


class Grader(unittest.TestCase):
    def test_rules(self):
        item = {"id": "x", "cat": "c", "q": "q", "expect": [["300"], ["429", "export"]], "forbid": ["50 per minute"]}
        self.assertTrue(G.grade(item, {"answer": "Export is 300/min now [1]."})["pass"])
        self.assertFalse(G.grade(item, {"answer": "It is 300, was 50 per minute."})["pass"])
        nf = {"id": "y", "cat": "c", "q": "q", "notfound": True}
        self.assertTrue(G.grade(nf, {"answer": "Nothing you can open matches that."})["pass"])
        self.assertTrue(G.grade(nf, {"answer": "I found no 1:1 between them."})["pass"])
        self.assertFalse(G.grade(nf, {"answer": "They discussed the roadmap [1]."})["pass"])
        # A label the prompt never offered is a hallucinated citation; a list counts as a list.
        r = {"answer": "x", "raws": [('<untrusted_document n="1">\n[1-s2] - A: hi', "<ranking>1</ranking>\n\nHi [1-s2] [1-s3] [1, 2]")]}
        g = G.grade({"id": "z", "cat": "c", "q": "q"}, r)
        self.assertEqual(g["halluc"], 2)
        self.assertEqual(g["lists"], 1)
        self.assertTrue(G.english("The limit is 300 per minute."))
        self.assertFalse(G.english("Export ke liye limit 300 hai, kal se."))

    def test_questions_are_well_formed(self):
        ids = [q["id"] for q in QS.Q]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertGreaterEqual(len(ids), 80)
        for q in QS.Q:
            self.assertIn(q.get("who") or "hk", PEOPLE, q["id"])
            self.assertTrue(q.get("expect") or q.get("notfound") or q.get("forbid"), q["id"])


class Offline(EvalWorld):
    mode = "fake"
    noise = False

    async def test_access_profile_and_personal_slice(self):
        items = selected("access,profile,personal-meetings,my-work")
        results = await self.run_all(items, 4)
        self.assertEqual(len(results), len(items))
        for r in results:
            self.assertIsNone(r["error"], r)
            self.assertFalse(r["grade"]["leak"], (r["id"], r["grade"]["fails"]))
            who = PEOPLE[r["who"]][0]
            for p in r["prompts"]:
                if "Return only JSON" in p:
                    continue
                self.assertIn(f"Name: {who}", p, r["id"])
        # The owner's report: his last sync-up comes with "attended but didn't speak", his lines marked.
        me = next(r for r in results if r["id"] == "me-01")
        p = "\n".join(me["prompts"])
        self.assertIn("they attended but didn't speak", p)
        self.assertIn("(you): I'm pairing with Rohan on the 429s", p)


if __name__ == "__main__":
    unittest.main()
