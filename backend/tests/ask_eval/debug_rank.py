"""Scratch: print the retrieval ranking for a few questions on the eval world (fake model). Not a test."""
import os
import unittest

from tests.ask_eval.run import EvalWorld
from app.services import access, search, search_ai


class Debug(EvalWorld):
    mode = "fake"
    noise = True

    async def test_rank(self):
        actor = access.Actor.of(type("U", (), {"id": self.uid["hk"], "email": self.email["hk"], "name": "Himanshu Kukreja"})())
        for text in [t for t in os.environ.get("DQ", "Q4 Roadmap|What's still open in the Q4 Roadmap?|Kabir|promise Kabir").split("|")]:
            ctx = access.Ctx(self.db)
            q = search.Query(q=text, scope=None, snippets=True)
            cands, w = await search.doc_and_guide_cands(self.db, actor, ctx, q)
            ranked = await search.rank_text(self.db, cands, text, q, ctx.now)
            print(f"\n== {text!r}: {len(cands)} cands, {len(ranked)} ranked")
            for c in ranked[:8]:
                print(f"   {c.score:6.1f} {c.kind:5} {c.title}")
            out, _ = await search_ai.retrieve(self.db, actor, ctx, q, [text])
            print("   retrieve:", [c.title for c in out[:6]])


if __name__ == "__main__":
    unittest.main()
