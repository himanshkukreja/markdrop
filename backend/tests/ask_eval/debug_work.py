"""Scratch: recent_work on the eval world. Not a test module for CI."""
import logging
import unittest

from tests.ask_eval.run import EvalWorld
from app.services import access, ask_me


class Debug(EvalWorld):
    mode = "fake"
    noise = True

    async def test_work(self):
        logging.basicConfig(level=logging.WARNING)
        actor = access.Actor.of(type("U", (), {"id": self.uid["hk"], "email": self.email["hk"], "name": "Himanshu Kukreja"})())
        ctx = access.Ctx(self.db)
        you = await ask_me.you_of(self.db, actor, ctx)
        work = await ask_me.recent_work(self.db, actor, ctx, you)
        for raw, what in work:
            print("WORK", raw.get("title"), "|", what)
        p = await ask_me.personal(self.db, actor, ctx, you, "What did I sign off recently?")
        print("PERSONAL", len(p.meetings), [r.get("title") for r, _ in p.work])


if __name__ == "__main__":
    unittest.main()
