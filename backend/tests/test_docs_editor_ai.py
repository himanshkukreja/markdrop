"""AI help in the Guides editor (routers/docs_site_editor.py, services/docs_editor_ai.py).

The Anthropic client is a fake (``docs_agent.get_client`` is patched): nothing
reaches the network. Covers each action, the prompt's shape, roles, input checks,
the daily, spend and monthly limits, the kill switch, refusals, cut-off and failed
calls, fence unwrapping, and that the ledger and the logs never hold the passage.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from types import SimpleNamespace
from unittest import mock

from bson import ObjectId

from tests._docs_sites_env import DocsSitesCase, now, settings

from app.limiter import limiter
from app.services import ai_usage, docs_agent, docs_editor_ai

SECRET = "Our launcher ships with a teh green canister and a secret-phrase-7731."
_SAVED = ("anthropic_api_key", "docs_ai_enabled", "docs_ai_model", "docs_editor_ai_enabled",
          "docs_editor_ai_per_user_day", "docs_editor_ai_per_site_day", "docs_editor_ai_daily_usd",
          "docs_editor_ai_monthly_usd", "docs_editor_ai_max_concurrent", "docs_editor_ai_max_chars",
          "docs_ai_answers_per_month", "docs_editor_ai_max_tokens")


def usage(i=900, o=120):
    return SimpleNamespace(input_tokens=i, output_tokens=o, cache_read_input_tokens=0,
                           cache_creation_input_tokens=0, cache_creation=None)


class FakeMessages:
    def __init__(self, owner):
        self.owner = owner

    async def create(self, **params):
        self.owner.calls.append(params)
        if self.owner.raise_exc is not None:
            raise self.owner.raise_exc
        return SimpleNamespace(
            content=[SimpleNamespace(type="thinking", thinking=""),
                     SimpleNamespace(type="text", text=self.owner.reply)],
            stop_reason=self.owner.stop, stop_details=None, usage=usage(), model="claude-haiku-5-5")


class FakeClient:
    def __init__(self):
        self.calls: list[dict] = []
        self.reply = "A better passage."
        self.stop = "end_turn"
        self.raise_exc = None
        self.messages = FakeMessages(self)


class EditorAI(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.saved = {k: getattr(settings, k) for k in _SAVED}
        settings.anthropic_api_key = "sk-test-not-a-real-key"
        settings.docs_ai_enabled = True
        settings.docs_ai_model = "claude-haiku-5-5"
        settings.docs_editor_ai_enabled = True
        settings.docs_editor_ai_per_user_day = 60
        settings.docs_editor_ai_per_site_day = 300
        settings.docs_editor_ai_daily_usd = 2.0
        settings.docs_editor_ai_monthly_usd = 20.0
        settings.docs_editor_ai_max_concurrent = 6
        settings.docs_editor_ai_max_chars = 6000
        settings.docs_editor_ai_max_tokens = 4000
        settings.docs_ai_answers_per_month = 1000
        await ai_usage.ensure_indexes(self.db)
        ai_usage._reserved.clear()
        docs_editor_ai._inflight = 0
        docs_editor_ai._inflight_by_user.clear()
        docs_editor_ai._inflight_by_site.clear()
        self.fake = FakeClient()
        p = mock.patch.object(docs_agent, "get_client", lambda: self.fake)
        p.start()
        self.addCleanup(p.stop)
        self.site = await self.create("acme")
        self.sid = self.site["id"]

    async def asyncTearDown(self):
        for k, v in self.saved.items():
            setattr(settings, k, v)
        await super().asyncTearDown()

    async def edit(self, who="editor", expect=200, **body) -> dict:
        body.setdefault("action", "improve")
        body.setdefault("text", SECRET)
        return await self.call("POST", f"/{self.sid}/ai/edit", who, expect, json=body)

    async def rows(self) -> list[dict]:
        return await self.db[ai_usage.REQUESTS].find({"feature": "docs_editor"}).sort(
            [("ts", 1), ("_id", 1)]).to_list(length=1000)

    async def seed(self, n: int, **fields) -> None:
        base = {"feature": "docs_editor", "ts": now() - timedelta(minutes=5), "outcome": "ok",
                "visitor": f"u:{self.uid['editor']}", "user_id": self.uid["editor"], "site": self.sid}
        await self.db[ai_usage.REQUESTS].insert_many(
            [{**base, **fields, "request_id": ObjectId().__str__()} for _ in range(n)])

    # ── happy paths ──

    async def test_each_action(self):
        for action in ("improve", "shorten", "fix"):
            self.fake.reply = f"Rewritten for {action}."
            r = await self.edit(action=action)
            self.assertEqual(r["markdown"], f"Rewritten for {action}.")
            self.assertEqual(len(r["request_id"]), 32)
            self.assertEqual(r["limit_today"], 60)
        self.fake.reply = "Notre lanceur..."
        r = await self.edit(action="translate", language="french")
        self.assertEqual((r["markdown"], r["used_today"]), ("Notre lanceur...", 4))

        params = self.fake.calls[-1]
        self.assertEqual(params["model"], "claude-haiku-5-5")
        self.assertEqual(params["max_tokens"], 4000)
        self.assertEqual(params["output_config"], {"effort": "low"})
        self.assertEqual(params["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertIn("Return only the rewritten passage", params["system"][0]["text"])
        self.assertNotIn(SECRET, params["system"][0]["text"])
        turn = params["messages"][0]["content"][0]["text"]
        self.assertIn(f"<passage>\n{SECRET}\n</passage>", turn)
        self.assertIn("into French", turn)
        self.assertIn("Shorten", self.fake.calls[1]["messages"][0]["content"][0]["text"])
        self.assertIn("only spelling, grammar and punctuation", self.fake.calls[2]["messages"][0]["content"][0]["text"])

        rows = await self.rows()
        self.assertEqual(len(rows), 4)
        self.assertEqual({r["outcome"] for r in rows}, {"ok"})
        last = next(r for r in rows if r["action"] == "translate")
        self.assertEqual((last["kind"], last["language"], last["chars_in"], last["chars_out"], last["site"],
                          last["user_id"], last["visitor"]),
                         ("editor", "French", len(SECRET), len("Notre lanceur..."), self.sid, self.uid["editor"],
                          f"u:{self.uid['editor']}"))
        self.assertGreater(last["cost_usd"], 0)
        # No content anywhere in the stored rows.
        for row in rows:
            self.assertNotIn("secret-phrase-7731", repr(row))
            self.assertNotIn("Rewritten", repr(row))
            for k in ("question", "answer", "text", "markdown", "output"):
                self.assertNotIn(k, row)
        # Spend counters were bumped for the feature and the site.
        self.assertGreater(await ai_usage.spend_today(self.db, "docs_editor"), 0)

    async def test_output_cleanup(self):
        self.fake.reply = "```markdown\nClean **text**.\n```"
        self.assertEqual((await self.edit())["markdown"], "Clean **text**.")
        self.fake.reply = "  <passage>\nTagged.\n</passage>  "
        self.assertEqual((await self.edit())["markdown"], "Tagged.")
        self.fake.reply = "```\nplain fence\n```"
        self.assertEqual((await self.edit())["markdown"], "plain fence")
        # Two code blocks aren't one wrapping fence.
        two = "```\na\n```\n\nThen:\n\n```\nb\n```"
        self.fake.reply = two
        self.assertEqual((await self.edit())["markdown"], two)
        # A code block the writer selected stays a code block.
        block = "```bash\nacme install\n```"
        self.fake.reply = "```\nacme install --yes\n```"
        self.assertEqual((await self.edit(text="```\nacme install\n```"))["markdown"], "```\nacme install --yes\n```")
        self.fake.reply = block
        self.assertEqual((await self.edit(text=block))["markdown"], block)
        # Nothing left: a 502.
        self.fake.reply = "```\n\n```"
        r = await self.edit(expect=502)
        self.assertEqual(r["code"], "upstream")
        self.assertEqual((await self.rows())[-1]["error_code"], "empty_output")

    # ── access and input ──

    async def test_roles(self):
        await self.edit("viewer", 403)
        await self.edit("stranger", 404)
        await self.get(f"/{self.sid}/ai/edit/status", "viewer", 403)
        await self.get(f"/{self.sid}/ai/edit/status", "stranger", 404)
        await self.edit("admin")
        await self.edit("owner")
        self.assertEqual(len(self.fake.calls), 2)

    async def test_input_checks(self):
        cases = [({"text": "   \n "}, "empty"), ({"text": "x" * 6001}, "too_long"),
                 ({"action": "summarise"}, "bad_action"), ({"action": "translate"}, "bad_language"),
                 ({"action": "translate", "language": "Klingon"}, "bad_language")]
        for body, code in cases:
            r = await self.edit(expect=400, **body)
            self.assertEqual(r["code"], code, body)
            self.assertIsInstance(r["detail"], str)
        self.assertEqual((await self.edit(text="  " + "x" * 6000 + "  "))["markdown"], "A better passage.")
        self.assertEqual(len(self.fake.calls), 1)
        self.assertEqual(await self.db[ai_usage.REQUESTS].count_documents({}), 1)

    # ── limits ──

    async def test_user_daily_limit(self):
        await self.seed(59)
        await self.seed(5, outcome="limit")  # refused requests don't count
        await self.seed(10, ts=now() - timedelta(days=1, hours=1))  # yesterday doesn't count
        await self.seed(10, visitor=f"u:{self.uid['admin']}", user_id=self.uid["admin"])  # someone else
        r = await self.edit()
        self.assertEqual((r["used_today"], r["limit_today"]), (60, 60))
        r = await self.edit(expect=429)
        self.assertEqual(r["code"], "user_daily")
        self.assertEqual(r["detail"], "You've used AI help 60 times today. It resets at midnight UTC.")
        limit = await self.db[ai_usage.REQUESTS].find_one({"feature": "docs_editor", "limit_reason": "user_daily"})
        self.assertEqual((limit["outcome"], limit["kind"]), ("limit", "editor"))
        self.assertNotIn("secret-phrase", repr(limit))
        await self.edit("admin")  # others still can
        st = await self.get(f"/{self.sid}/ai/edit/status", "editor")
        self.assertEqual((st["available"], st["reason"], st["used_today"]), (False, "user_daily", 60))

    async def test_site_daily_limit(self):
        settings.docs_editor_ai_per_site_day = 3
        await self.seed(3, visitor="u:someone", user_id="someone")
        await self.seed(4, site=str(ObjectId()))  # another guide
        r = await self.edit(expect=429)
        self.assertEqual(r["code"], "site_daily")
        self.assertIn("This guide has used AI help 3 times today", r["detail"])
        self.assertEqual(self.fake.calls, [])

    async def test_budget(self):
        await ai_usage._bump(self.db, "docs_editor", now(), 2.0)
        r = await self.edit(expect=503)
        self.assertEqual(r["code"], "budget")
        row = await self.db[ai_usage.REQUESTS].find_one({"limit_reason": "budget_daily"})
        self.assertIsNotNone(row)
        st = await self.get(f"/{self.sid}/ai/edit/status")
        self.assertEqual((st["available"], st["reason"]), (False, "budget"))
        # Ask AI's own spend doesn't use the editor's caps.
        await self.db[ai_usage.SPEND].delete_many({})
        await ai_usage._bump(self.db, "docs_ask", now(), 9.0)
        await self.edit()

    async def test_guide_monthly_allowance(self):
        settings.docs_ai_answers_per_month = 5
        # Readers' Ask AI answers and editor uses share the allowance.
        await self.db[ai_usage.REQUESTS].insert_many([
            {"feature": "docs_ask", "site": self.sid, "ts": now(), "outcome": "answered", "request_id": f"a{i}"}
            for i in range(3)])
        await self.edit()
        await self.edit()
        from app.services import docs_site_store

        self.assertEqual((await docs_site_store.ai_answers(self.db, [self.sid]))[self.sid], 5)
        r = await self.edit(expect=503)
        self.assertEqual(r["code"], "budget")
        self.assertIn("5 AI uses for this month", r["detail"])
        # Errors and limits don't use it up.
        rows = await self.db[ai_usage.REQUESTS].find({"feature": "docs_editor", "outcome": "limit"}).to_list(10)
        self.assertEqual(rows[0]["limit_reason"], "site_answers_monthly")

    async def test_busy(self):
        settings.docs_editor_ai_max_concurrent = 1
        docs_editor_ai._inflight = 1
        r = await self.edit(expect=503)
        self.assertEqual(r["code"], "busy")

    async def test_switched_off(self):
        settings.docs_editor_ai_enabled = False
        self.assertEqual((await self.edit(expect=503))["code"], "disabled")
        st = await self.get(f"/{self.sid}/ai/edit/status")
        self.assertEqual((st["available"], st["reason"]), (False, "disabled"))
        settings.docs_editor_ai_enabled = True
        settings.docs_ai_enabled = False
        self.assertEqual((await self.edit(expect=503))["code"], "disabled")
        settings.docs_ai_enabled = True
        settings.anthropic_api_key = " "
        self.assertEqual((await self.edit(expect=503))["code"], "not_configured")
        self.assertEqual(self.fake.calls, [])

    # ── model outcomes ──

    async def test_refusal_and_cut_off(self):
        self.fake.stop = "refusal"
        r = await self.edit(expect=422)
        self.assertEqual(r["code"], "refused")
        self.fake.stop = "max_tokens"
        r = await self.edit(expect=422)
        self.assertEqual(r["code"], "too_long_output")
        rows = await self.rows()
        self.assertEqual([(x["outcome"], x.get("error_code")) for x in rows],
                         [("refused", None), ("error", "too_long_output")])
        self.assertEqual(ai_usage._reserved, {})
        self.assertEqual((docs_editor_ai._inflight, docs_editor_ai._inflight_by_user,
                          docs_editor_ai._inflight_by_site), (0, {}, {}))

    async def test_upstream_failure_is_502_and_logged_without_text(self):
        import anthropic
        import httpx

        self.fake.raise_exc = anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com"))
        with self.assertLogs("markdrop.docs_editor_ai", level="DEBUG") as logs:
            logging.getLogger("markdrop.docs_editor_ai").debug("start")
            r = await self.edit(expect=502)
        self.assertEqual(r["code"], "upstream")
        self.assertIn("couldn't reach", r["detail"])
        joined = "\n".join(logs.output)
        self.assertIn("APIConnectionError", joined)
        self.assertNotIn("secret-phrase", joined)
        row = (await self.rows())[-1]
        self.assertEqual((row["outcome"], row["error_code"]), ("error", "upstream_unreachable"))
        self.assertNotIn("secret-phrase", repr(row))

        self.fake.raise_exc = RuntimeError(SECRET)
        with self.assertLogs("markdrop.docs_editor_ai", level="DEBUG") as logs:
            r = await self.edit(expect=502)
        self.assertNotIn("secret-phrase", "\n".join(logs.output))
        self.assertEqual((await self.rows())[-1]["error_code"], "internal")
        self.assertEqual(ai_usage._reserved, {})

    async def test_no_text_in_any_log(self):
        with self.assertLogs(level="DEBUG") as logs:
            logging.getLogger("markdrop").debug("start")
            await self.edit()
            await self.edit(action="translate", language="German")
            self.fake.stop = "refusal"
            await self.edit(expect=422)
        self.assertNotIn("secret-phrase", "\n".join(logs.output))

    # ── status ──

    async def test_status(self):
        await self.seed(2)
        await self.seed(3, visitor="u:other", user_id="other")
        st = await self.get(f"/{self.sid}/ai/edit/status", "editor")
        self.assertEqual({k: st[k] for k in ("available", "reason", "used_today", "limit_today", "site_used_today",
                                              "site_limit_today", "max_chars")},
                         {"available": True, "reason": None, "used_today": 2, "limit_today": 60,
                          "site_used_today": 5, "site_limit_today": 300, "max_chars": 6000})
        self.assertEqual(st["actions"], ["improve", "shorten", "fix", "translate"])
        self.assertIn("Chinese (Simplified)", st["languages"])
        self.assertEqual(len(st["languages"]), 31)
        self.assertEqual(st["languages"], list(docs_editor_ai.LANGUAGES))

    async def test_rate_limited_route(self):
        limiter.reset()
        for _ in range(30):
            await self.edit(text="", expect=400)
        r = await self.http.post(f"/api/v1/docs-sites/{self.sid}/ai/edit", headers=self.h["editor"],
                                 json={"action": "improve", "text": "x"})
        self.assertEqual(r.status_code, 429)
