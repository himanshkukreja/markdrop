"""Comments × Jira in pages, together (release integration): a suggested edit accepted on a page with Jira chips,
cards and lists keeps every directive; a thread made through the comments API becomes a Jira issue and both stay
linked through resolve; an export with comments shows the chips as "KEY · title" links and the threads.

The access-policy world (tests/_access_env.py) with the fake Atlassian (tests/_jira_fake.py) — never backend/.env.

Run: cd backend && MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 .venv/bin/python -m unittest tests.test_comments_jira_cross -v
"""

from __future__ import annotations

import io
import zipfile

from tests.test_jira_pages import HOST, PagesWorld, now  # noqa: F401  (pins settings first)

from app.services import jira, notifications, page_history
from app.services.comments import model


def body(k1: str, k2: str) -> str:
    return (f"# Launch {{#b-h1aaaa}}\n\nWe ship the billing webhooks with :jira[{k1}] on Monday. {{#b-p1aaaa}}\n\n"
            f"::jira{{key={k2} site={HOST}}}\n\n"
            '::jira-list{project=PAY title="Payments"}\n\n'
            "Closing words. {#b-endaaa}\n")


class CommentsJira(PagesWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await model.ensure_indexes(self.db)
        await notifications.ensure_indexes(self.db)
        await page_history.ensure_indexes(self.db)
        await self.connect("wa")
        await self.connect("wm")
        await self.save("wa", "launch", body(self.k1, self.k2))

    def curl(self, tail: str = "") -> str:
        return f"/api/v1/documents/launch/comments{tail}"

    async def comment(self, who: str, exact: str, prefix: str, suffix: str, **extra) -> dict:
        r = await self.http.post(self.curl(), json={
            "anchor": {"type": "text", "block_id": "b-p1aaaa", "quote": {"exact": exact, "prefix": prefix, "suffix": suffix}},
            "body": "Reword this?", **extra}, headers=self.session(who))
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    async def content(self) -> str:
        return (await self.doc("launch"))["content"]

    def directives(self, md: str) -> list[str]:
        return [ln for ln in md.splitlines() if ln.startswith("::jira")] + \
               [w for w in md.split() if w.startswith(":jira[")]

    async def test_accepting_a_suggestion_keeps_jira_chips_cards_and_lists(self):
        before = await self.content()
        t = await self.comment("wm", "billing webhooks", "ship the ", " with", suggestion="v2 billing webhooks")
        r = await self.http.post(self.curl(f"/{t['id']}/suggestion/accept"), headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["applied"])
        after = await self.content()
        self.assertIn(f"We ship the v2 billing webhooks with :jira[{self.k1}] on Monday.", after)
        self.assertEqual(self.directives(after), self.directives(before))
        self.assertEqual(after.replace("v2 billing webhooks", "billing webhooks"), before)
        # Right after the chip too.
        t = await self.comment("wm", "on Monday", f"{self.k1} ", ".", suggestion="on Tuesday")
        r = await self.http.post(self.curl(f"/{t['id']}/suggestion/accept"), headers=self.session("wa"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(f":jira[{self.k1}] on Tuesday.", await self.content())
        self.assertEqual(self.directives(await self.content()), self.directives(before))
        # Across the chip: it can't be replaced as plain text, and says so (not "the text changed").
        current = await self.content()
        t = await self.comment("wm", f"with {self.k1} on", "webhooks ", " Tuesday", suggestion="for")
        r = await self.http.get(self.curl(f"/{t['id']}/suggestion"), headers=self.session("wa"))
        self.assertEqual((r.json()["applies"], r.json()["reason"]), (False, "unappliable"))
        r = await self.http.post(self.curl(f"/{t['id']}/suggestion/accept"), headers=self.session("wa"))
        self.assertEqual((r.status_code, r.json()["code"]), (409, "suggestion_unappliable"))
        self.assertEqual(await self.content(), current)
        # The page's Jira snapshots still answer for the chip after the edit.
        await jira.drain()
        items = (await self.http.get("/api/v1/jira/pages/launch/items", headers=self.session("wo"))).json()
        self.assertIn(self.k1, str(items))

    async def test_a_comment_thread_becomes_an_issue_and_both_stay_linked(self):
        t = await self.comment("wm", "billing webhooks", "ship the ", " with")
        r = await self.http.post(self.curl(f"/{t['id']}/replies"), json={"body": "Yes, next sprint.", "mentions": []},
                                 headers=self.session("wa"))
        self.assertEqual(r.status_code, 201, r.text)
        base = f"/api/v1/jira/pages/launch/threads/{t['id']}"
        r = await self.http.post(f"{base}/draft", json={}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("Reword this?", r.json()["source"]["text"])
        r = await self.http.post(f"{base}/issue", json={"fields": {"project": "PAY", "summary": "Reword the webhooks line"}},
                                 headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        key = r.json()["key"]
        self.assertIn(f"/launch#c-{t['id']}", str(self.fj.issues[key]["fields"]["description"]))
        # The comments API still reads, lists and resolves the thread with the issue on it.
        r = await self.http.get(self.curl(f"/{t['id']}"), headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.get(self.curl(), headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(t["id"], [x["id"] for x in r.json()["threads"]])
        r = await self.http.post(self.curl(f"/{t['id']}/resolve"), headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "resolved")
        row = (await self.http.get("/api/v1/jira/pages/launch/threads", headers=self.session("wm"))).json()["threads"][t["id"]]
        self.assertEqual((row["key"], row["title"]), (key, "Reword the webhooks line"))
        r = await self.http.post(self.curl(f"/{t['id']}/reopen"), headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "open")

    async def test_export_with_comments_and_jira(self):
        await self.comment("wm", "billing webhooks", "ship the ", " with")
        r = await self.http.get("/api/v1/documents/launch/export", params={"format": "md", "comments": "footnotes"},
                                headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        md = r.text
        self.assertIn(f"[{self.k1} · Billing webhooks v2](https://{HOST}/browse/{self.k1})", md)
        self.assertIn(f"[{self.k2} · Runbook for the launch](https://{HOST}/browse/{self.k2})", md)
        self.assertIn("[Payments](https://acme.atlassian.net/issues/?jql=project%20%3D%20PAY)", md)
        self.assertNotIn("::jira", md)
        self.assertNotIn(":jira[", md)
        page, _, appendix = md.partition("## Comments")
        self.assertIn("“billing webhooks”", appendix)
        self.assertIn("Reword this?", appendix)
        self.assertNotIn("In Progress", md)                              # snapshots only, never live details
        r = await self.http.get("/api/v1/documents/launch/export", params={"format": "docx", "comments": "margin"},
                                headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            names = z.namelist()
            doc = z.read("word/document.xml").decode()
            rels = z.read("word/_rels/document.xml.rels").decode()
        self.assertIn("word/comments.xml", names)
        self.assertIn(f"{self.k1} · Billing webhooks v2", doc)
        self.assertIn(f"https://{HOST}/browse/{self.k1}", rels)
        self.assertNotIn("::jira", doc)
