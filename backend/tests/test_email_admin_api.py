"""Admin campaign API over HTTP (ASGI, throwaway MongoDB): auth, drafts, render,
audience, typed confirmation, a tick, report, recipients and CSV."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from tests import _email_env as env

import httpx
import jwt

from app.config import get_settings
from app.main import app
from app.routers import admin_email
from app.services.email_campaigns import audience

settings = get_settings()


@unittest.skipUnless(env.MONGO, "MongoDB not reachable")
class AdminApi(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.name = env.new_db_name()
        self.client, self.db = await env.make_db(self.name)
        audience.invalidate()
        app.dependency_overrides[admin_email.get_db] = lambda: self.db
        tok = jwt.encode({"sub": "admin", "exp": datetime.now(timezone.utc) + timedelta(hours=1)}, settings.admin_secret, algorithm="HS256")
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://api.markdrop.in",
                                      headers={"Authorization": f"Bearer {tok}"})
        await self.db["users"].insert_one({"email": "ann@example.com", "name": "Ann Lee", "created_at": datetime.now(timezone.utc)})

    async def asyncTearDown(self):
        app.dependency_overrides.clear()
        audience.invalidate()
        await self.http.aclose()
        await self.client.drop_database(self.name)
        self.client.close()

    async def test_flow(self):
        r = await self.http.get("/api/v1/admin/email/info", headers={"Authorization": "Bearer nope"})
        self.assertEqual(r.status_code, 401)
        t = (await self.http.get("/api/v1/admin/email/templates")).json()
        self.assertEqual({x["id"] for x in t["templates"]}, {"newsletter", "artifacts", "encryption-workspaces", "welcome", "blank-html"})
        tpl = next(x for x in t["templates"] if x["id"] == "newsletter")
        draft = {k: tpl[k] for k in ("subject", "subject_fallback", "preheader", "doc")}
        draft.update(name="API test", template="newsletter",
                     audience={"kind": "custom", "emails": "ann@example.com, x1@example.com x2@example.com, bad"})

        r = await self.http.post("/api/v1/admin/email/render", json={**draft, "as_email": "ann@example.com"})
        body = r.json()
        self.assertEqual(body["subject"], "Ann, what's new in Markdrop")
        self.assertEqual(body["as"]["source"], "account")
        self.assertEqual(body["problems"], [])
        self.assertIn("/api/v1/email/u/preview", body["html"])

        c = (await self.http.post("/api/v1/admin/email/campaigns", json=draft)).json()["campaign"]
        cid = c["id"]
        self.assertEqual((c["status"], c["created_by"]), ("draft", "admin"))
        r = await self.http.patch(f"/api/v1/admin/email/campaigns/{cid}", json={**draft, "subject": "Hello {{first_name|you}}"})
        self.assertEqual(r.json()["campaign"]["subject"], "Hello {{first_name|you}}")

        a = (await self.http.post("/api/v1/admin/email/audience", json={"audience": draft["audience"], "campaign_id": cid})).json()
        self.assertEqual((a["count"]["eligible"], a["count"]["invalid"]), (3, 1))
        self.assertIn("all", a["presets"])

        r = await self.http.post(f"/api/v1/admin/email/campaigns/{cid}/queue", json={"confirm": "send to 2"})
        self.assertEqual((r.status_code, r.json()["expected"]), (400, "send to 3"))
        r = await self.http.post(f"/api/v1/admin/email/campaigns/{cid}/queue", json={"confirm": "send to 3"})
        self.assertEqual(r.json()["campaign"]["status"], "sending")
        r = await self.http.patch(f"/api/v1/admin/email/campaigns/{cid}", json=draft)
        self.assertEqual(r.status_code, 409)

        r = (await self.http.post(f"/api/v1/admin/email/campaigns/{cid}/tick")).json()
        self.assertEqual((r["sent_now"], r["transport"]), (3, "console"))
        self.assertEqual(r["campaign"]["status"], "sent")

        rep = (await self.http.get(f"/api/v1/admin/email/campaigns/{cid}/report")).json()
        self.assertEqual(rep["counts"]["sent"], 3)
        self.assertEqual(rep["timeline"]["unit"], "minute")
        rows = (await self.http.get(f"/api/v1/admin/email/campaigns/{cid}/recipients?filter=unopened&q=x1@")).json()
        self.assertEqual(rows["total"], 1)
        csv = await self.http.get(f"/api/v1/admin/email/campaigns/{cid}/recipients?format=csv")
        self.assertEqual(csv.headers["content-type"], "text/csv; charset=utf-8")
        self.assertEqual(len(csv.text.strip().splitlines()), 4)

        r = await self.http.delete(f"/api/v1/admin/email/campaigns/{cid}")
        self.assertEqual(r.status_code, 409)  # sent campaigns keep their history
        dup = (await self.http.post(f"/api/v1/admin/email/campaigns/{cid}/duplicate")).json()["campaign"]
        self.assertEqual(dup["status"], "draft")
        self.assertEqual((await self.http.delete(f"/api/v1/admin/email/campaigns/{dup['id']}")).status_code, 200)

    async def test_senders_and_suppressions(self):
        r = await self.http.post("/api/v1/admin/email/senders", json={"from_email": "nope"})
        self.assertEqual(r.status_code, 400)
        r = await self.http.post("/api/v1/admin/email/senders", json={"from_email": "News@Markdrop.in", "from_name": 'Mark "x" <y>', "is_default": True})
        s = r.json()["sender"]
        self.assertEqual((s["from_email"], s["from_name"], s["is_default"]), ("news@markdrop.in", "Mark x y", True))
        senders = r.json()["senders"]
        self.assertFalse(next(x for x in senders if x["id"] == "env")["is_default"])
        self.assertEqual((await self.http.delete("/api/v1/admin/email/senders/env")).status_code, 400)
        self.assertEqual((await self.http.delete(f"/api/v1/admin/email/senders/{s['id']}")).status_code, 200)
        r = await self.http.post("/api/v1/admin/email/suppressions", json={"emails": "z@example.com, bad"})
        self.assertEqual(r.json(), {"added": 1, "invalid": 1})
        self.assertEqual((await self.http.delete("/api/v1/admin/email/suppressions/z@example.com")).status_code, 200)
        await self.db["email_suppressions"].insert_one({"_id": "u@example.com", "reason": "unsubscribed"})
        self.assertEqual((await self.http.delete("/api/v1/admin/email/suppressions/u@example.com")).status_code, 409)


if __name__ == "__main__":
    unittest.main()
