"""Meetings "Check for new meetings" (services/meetings_inbox.py ``check_now``): the Google Meet script's
web app, called by Markdrop with the connection's key, instead of waiting for the next 15-minute run.

Turning it on (the Web app URL: validated, never shown to anyone), who may check (members; viewers and
strangers can't), once a minute per workspace, the fake script (httpx.MockTransport: Google's 302 to
script.googleusercontent.com, then the script's JSON; it delivers to the real inbox meanwhile), every
way the call can go wrong explained, and the key/URL surviving "Get the new script". The script side
(doPost) runs under node in test_meetings_auto.Script.
"""

from __future__ import annotations

import json
from datetime import timedelta

import httpx

from tests.test_meetings_auto import AutoWorld

from app.services import meetings_inbox

EXEC = "https://script.google.com/macros/s/AKfycbx" + "Q" * 60 + "/exec"
ECHO = "https://script.googleusercontent.com/macros/echo?user_content_key=abc&lib=x"


class CheckNow(AutoWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.calls: list[httpx.Request] = []
        self.addCleanup(setattr, meetings_inbox, "CHECK_TRANSPORT", None)

    def script(self, answer, *, deliver: str | None = None, key: str | None = None):
        """A fake web app: Google's 302 to the echo URL, then ``answer`` (a dict → JSON, a str → HTML, an
        httpx.Response as is, an exception → raised). ``deliver``: the script sends a Doc to the inbox first."""
        async def handler(req: httpx.Request) -> httpx.Response:
            self.calls.append(req)
            if req.method == "POST":
                if key is not None:
                    self.assertEqual(json.loads(req.content), {"key": key})
                if deliver:
                    r = await self.deliver(deliver)
                    self.assertEqual(r.status_code, 200, r.text)
                return httpx.Response(302, headers={"location": ECHO})
            if isinstance(answer, Exception):
                raise answer
            if isinstance(answer, httpx.Response):
                return answer
            if isinstance(answer, str):
                return httpx.Response(200, text=answer, headers={"content-type": "text/html"})
            return httpx.Response(200, json=answer)
        meetings_inbox.CHECK_TRANSPORT = httpx.MockTransport(handler)

    async def turn_on(self, who="owner", url=EXEC):
        return await self.http.put("/api/v1/meetings/connection/check-now", headers=self.session(who), json={"url": url})

    async def key(self, token: str) -> str:
        r = await self.http.post("/api/v1/meetings/inbox/status", headers={"Authorization": f"Bearer {token}"},
                                 json={"phase": "start", "version": 4})
        return r.json()["check_key"]

    async def check(self, who="wm"):
        return await self.http.post("/api/v1/meetings/check-now", headers=self.session(who), json={"workspace": self.W})

    async def unthrottle(self):
        await self.db[meetings_inbox.CHECK_COLL].update_many({}, {"$set": {"at": meetings_inbox.now_utc() - timedelta(minutes=2)}})

    async def test_turning_it_on(self):
        r = await self.turn_on()
        self.assertEqual(r.status_code, 404)              # not connected
        await self.connect()
        for bad in ("https://script.google.com/macros/s/x/dev", "https://evil.test/macros/s/" + "a" * 30 + "/exec",
                    "http://script.google.com/macros/s/" + "a" * 30 + "/exec", EXEC + "?x=1", "javascript:alert(1)"):
            r = await self.turn_on(url=bad)
            self.assertEqual(r.status_code, 422, bad)
        ws_url = "https://script.google.com/a/macros/acme.test/s/AKfycbx" + "Z" * 40 + "/exec"
        for good in (ws_url, EXEC):
            r = await self.turn_on(url=good)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["connection"]["check_now"], {"ready": True, "last_at": None, "last": None})
        # The address is the person's own: never shown, to them or anyone else.
        for who in ("owner", "wm"):
            r = await self.http.get(f"/api/v1/meetings/connection?workspace={self.W}", headers=self.session(who))
            self.assertNotIn("AKfycbx", r.text)
        others = (await self.http.get(f"/api/v1/meetings/connection?workspace={self.W}", headers=self.session("wm"))).json()["others"]
        self.assertTrue(others[0]["check_now"]["ready"])
        r = await self.http.put("/api/v1/meetings/connection/check-now", headers=self.session("owner"), json={"url": None})
        self.assertFalse(r.json()["connection"]["check_now"]["ready"])

    async def test_check_runs_the_script_and_the_meeting_arrives(self):
        tok = (await self.connect())["token"]
        key = await self.key(tok)
        await self.turn_on()
        self.script({"ok": True, "version": 4, "found": 1, "sent": 1, "results": {"imported": 1, "attached": 0},
                     "skipped": {"writing": 0}, "remaining": 0, "errors": 0}, deliver=tok, key=key)
        r = await self.check("wm")   # any member, not just whoever connected it
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual((out["ok"], out["imported"], out["checked"], out["failed"], out["message"]),
                         (True, 1, 1, 0, "Found 1 new meeting."))
        self.assertEqual(out["connections"][0]["connected_by"]["name"], "Ada Lovelace")
        self.assertFalse(out["connections"][0]["mine"])
        self.assertEqual([(c.method, str(c.url)) for c in self.calls], [("POST", EXEC), ("GET", ECHO)])
        self.assertEqual(len(await self.rows()), 1)
        self.assertNotIn(key, r.text)
        c = (await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))).json()["connection"]
        self.assertTrue(c["check_now"]["last_at"])
        self.assertEqual(c["check_now"]["last"], {"ok": True, "imported": 1, "attached": 0, "updated": 0, "writing": 0})
        # Once a minute per workspace (whoever asks).
        r = await self.check("owner")
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["detail"]["error"], "too_soon")
        self.assertGreater(r.json()["detail"]["retry_after"], 50)
        self.assertEqual(len(self.calls), 2)
        # A minute later: nothing new; a Doc Google is still writing is mentioned.
        await self.unthrottle()
        self.script({"ok": True, "found": 1, "sent": 0, "results": {}, "skipped": {"writing": 1}, "remaining": 0})
        out = (await self.check("owner")).json()
        self.assertEqual(out["message"], "No new meetings. 1 Doc Google is still writing: check again in a couple of minutes.")
        self.assertTrue(out["connections"][0]["mine"])

    async def test_who_can_check(self):
        r = await self.check("wm")
        self.assertEqual((r.status_code, r.json()["detail"]["error"]), (409, "not_connected"))
        await self.connect()
        r = await self.check("wm")
        self.assertEqual((r.status_code, r.json()["detail"]["error"]), (409, "not_set_up"))
        await self.turn_on()
        self.script({"ok": True, "found": 0, "sent": 0})
        self.assertEqual((await self.check("wv")).status_code, 403)         # a viewer
        self.assertEqual((await self.check("stranger")).status_code, 404)   # not a member
        r = await self.http.post("/api/v1/meetings/check-now", json={"workspace": self.W})
        self.assertEqual(r.status_code, 401)
        r = await self.http.post("/api/v1/meetings/check-now", headers=self.session("wm"), json={"workspace": "nope"})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.calls, [])
        r = await self.check("wm")
        self.assertEqual((r.status_code, r.json()["message"]), (200, "No new meetings."))

    async def test_what_goes_wrong_is_explained(self):
        tok = (await self.connect())["token"]
        await self.key(tok)
        await self.turn_on()
        cases = [
            ({"ok": False, "error": "bad_key", "version": 4}, "bad_key", "Version: New version"),
            ({"ok": False, "error": "too_soon", "retry_in": 40}, "too_soon", "less than a minute"),
            ({"ok": False, "error": "busy"}, "busy", "already checking"),
            ({"ok": False, "error": "disconnected"}, "disconnected", "Run setup"),
            ({"ok": False, "error": "<script>"}, "failed", "Executions"),
            ("<html>Script function not found: doPost</html>", "not_script", "Web app URL"),
            ({"hello": 1}, "not_script", "Web app URL"),
            (httpx.Response(404, text="Not found"), "unreachable", "Couldn't reach"),
            (httpx.ReadTimeout("slow"), "timeout", "still working"),
            (httpx.ConnectError("down"), "unreachable", "Couldn't reach"),
        ]
        for answer, error, words in cases:
            await self.unthrottle()
            self.script(answer)
            r = await self.check("owner")
            self.assertEqual(r.status_code, 200, r.text)
            out = r.json()
            self.assertEqual((out["ok"], out["connections"][0]["error"]), (False, error), answer)
            self.assertIn(words, out["message"])
        # Google wants a sign-in (access isn't "Anyone"), and a redirect anywhere else isn't followed.
        for location, error in (("https://accounts.google.com/ServiceLogin?continue=x", "sign_in"),
                                ("https://evil.test/steal", "not_script")):
            await self.unthrottle()
            self.calls.clear()

            async def handler(req: httpx.Request, location=location) -> httpx.Response:
                self.calls.append(req)
                return httpx.Response(302, headers={"location": location})
            meetings_inbox.CHECK_TRANSPORT = httpx.MockTransport(handler)
            out = (await self.check("owner")).json()
            self.assertEqual(out["connections"][0]["error"], error)
            self.assertEqual([c.url.host for c in self.calls], ["script.google.com"])

    async def test_two_scripts_one_not_set_up(self):
        tok = (await self.connect())["token"]
        await self.key(tok)
        await self.turn_on()
        await self.connect("wa")                       # Priya connected too, without Check now
        self.script({"ok": True, "found": 2, "sent": 2, "results": {"imported": 1, "attached": 1}, "remaining": 3})
        out = (await self.check("wm")).json()
        self.assertEqual((out["checked"], out["not_set_up"], out["imported"], out["attached"]), (1, 1, 1, 1))
        self.assertEqual(out["message"], "Found 1 new meeting. 3 more arrive with the next run.")

    async def test_new_script_keeps_check_now_and_its_key(self):
        tok = (await self.connect())["token"]
        key = await self.key(tok)
        await self.turn_on()
        tok2 = (await self.connect())["token"]          # Get the new script (same Apps Script project)
        self.assertNotEqual(tok, tok2)
        c = (await self.http.get("/api/v1/meetings/connection", headers=self.session("owner"))).json()["connection"]
        self.assertEqual(c["check_now"], {"ready": True, "last_at": None, "last": None})
        self.assertEqual(await self.key(tok2), key)
        # 'done' hands the key out too; a connection made before Check now gets one.
        await self.db["api_tokens"].update_one({"scope": "meetings:import"}, {"$unset": {"check_key": 1}})
        r = await self.http.post("/api/v1/meetings/inbox/status", headers={"Authorization": f"Bearer {tok2}"},
                                 json={"phase": "done", "version": 3})
        new = r.json()["check_key"]
        self.assertTrue(new and new != key)
        self.assertEqual(await self.key(tok2), new)

    async def test_mcp_tool(self):
        tok = await self.mcp_token("wm")
        code, res = await self.mcp_call(tok, "check_meetings_now", {"workspace": self.W})
        self.assertTrue(res.get("isError"), res)
        self.assertIn("isn't connected", json.dumps(res))
        raw = (await self.connect())["token"]
        await self.key(raw)
        await self.turn_on()
        self.script({"ok": True, "found": 1, "sent": 1, "results": {"imported": 1}}, deliver=raw)
        code, res = await self.mcp_call(tok, "check_meetings_now", {"workspace": self.W})
        self.assertFalse(res.get("isError"), res)
        self.assertIn("Found 1 new meeting.", res["content"][0]["text"])
        self.assertEqual((res["structuredContent"]["imported"], res["structuredContent"]["checked"]), (1, 1))
        self.assertNotIn("AKfycbx", json.dumps(res))
        code, res = await self.mcp_call(tok, "check_meetings_now", {"workspace": self.W})
        self.assertTrue(res.get("isError"))
        self.assertIn("less than a minute", json.dumps(res))
        code, res = await self.mcp_call(await self.mcp_token("wv"), "check_meetings_now", {"workspace": self.W})
        self.assertTrue(res.get("isError"))
