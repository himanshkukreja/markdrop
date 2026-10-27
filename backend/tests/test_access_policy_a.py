"""Access policy test catalogue §6.3–§6.7 (cases 1–85). Method names carry the
catalogue number (test_cNNN_…); [S] cases need a running stack and are
skipped here with their ids, to be run live."""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from bson import ObjectId

from tests._access_env import ES_SECRET, PASSWORD, AccessWorld, settings

from app.services import access, file_versions, live, publicity


def iso(dt: datetime) -> str:
    return dt.isoformat()


class PasswordGate(AccessWorld):
    async def test_c001_lp_anonymous_password_gate(self):
        d = await self.mkdoc("LP")
        r = await self.get(d["slug"])
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "password"))
        self.assertNotIn(d["title"], r.text)
        self.assertNotIn(d["content"], r.text)

    async def test_c002_lp_grantee_viewer_no_password(self):
        d = await self.mkdoc("LP", ws=None)
        self.assertEqual((await self.get(d["slug"], self.session("gv"))).status_code, 200)

    async def test_c003_lp_member_no_password(self):
        d = await self.mkdoc("LP")
        self.assertEqual((await self.get(d["slug"], self.session("wm"))).status_code, 200)

    async def test_c004_lp_edit_secret_no_password(self):
        d = await self.mkdoc("LP")
        self.assertEqual((await self.get(d["slug"], {"X-Edit-Secret": ES_SECRET})).status_code, 200)

    async def test_c005_rlp_password_never_helps_anonymous(self):
        d = await self.mkdoc("RLP")
        r = await self.get(d["slug"], {"X-Read-Password": PASSWORD})
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "signin"))

    async def test_c006_inert_password_survives_private_to_link(self):
        d = await self.mkdoc("P", ws=None, read_password_hash=bcrypt.hashpw(b"x", bcrypt.gensalt(4)).decode())
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "link"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204, r.text)
        r = await self.get(d["slug"])
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "password"))

    async def test_c007_password_change_epoch_and_old_password(self):
        d = await self.mkdoc("LP", ws=None)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"),
                                json={"title": d["title"], "content": d["content"], "read_password": "new-pw"})
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.get(d["slug"], {"X-Read-Password": PASSWORD})
        self.assertEqual(r.status_code, 403)
        self.assertGreater((await self.doc(d["slug"]))["access_epoch"], 0)

    async def test_c008_wrong_password_attempt_limit(self):
        d = await self.mkdoc("LP", ws=None)
        for _ in range(10):
            self.assertEqual((await self.get(d["slug"], {"X-Read-Password": "nope"})).status_code, 403)
        self.assertEqual((await self.get(d["slug"], {"X-Read-Password": "nope"})).status_code, 429)
        self.assertEqual((await self.get(d["slug"], {"X-Read-Password": PASSWORD})).status_code, 429)

    async def test_c009_grantee_with_wrong_password_header_reads(self):
        d = await self.mkdoc("LP", ws=None)
        r = await self.get(d["slug"], {**self.session("gv"), "X-Read-Password": "wrong"})
        self.assertEqual(r.status_code, 200)

    async def test_c010_mcp_password_gated_no_signed_url(self):
        d = await self.mkdoc("LP", ws=None, owner="owner", kind="artifact")
        token = await self.mcp_token("stranger", write=False)
        _s, res = await self.mcp_call(token, "get_document", {"document": d["slug"]})
        self.assertTrue(res["isError"])
        self.assertIn("password-protected", res["content"][0]["text"])
        self.assertNotIn("?t=", str(res))
        _s, res = await self.mcp_call(token, "get_file_info", {"document": d["slug"]})
        self.assertTrue(res["isError"])
        self.assertNotIn("?t=", str(res))


class RequireAuth(AccessWorld):
    async def test_c011_rl_stranger_404(self):
        d = await self.mkdoc("RL")
        self.assertEqual((await self.get(d["slug"], self.session("stranger"))).status_code, 404)

    async def test_c012_rl_viewer_reads(self):
        d = await self.mkdoc("RL")
        self.assertEqual((await self.get(d["slug"], self.session("wv"))).status_code, 200)

    async def test_c013_rl_grantee_reads(self):
        d = await self.mkdoc("RL")
        self.assertEqual((await self.get(d["slug"], self.session("gv"))).status_code, 200)

    async def test_c014_rl_former_member_404(self):
        d = await self.mkdoc("RL")
        self.assertEqual((await self.get(d["slug"], self.session("former"))).status_code, 404)

    async def test_c015_rl_invitee_404(self):
        d = await self.mkdoc("RL")
        self.assertEqual((await self.get(d["slug"], self.session("invitee"))).status_code, 404)

    async def test_c016_rl_artifact_urls_signed_and_not_public(self):
        d = await self.mkdoc("RL", kind="artifact")
        r = await self.get(d["slug"], self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("?t=", body["artifact_url"])
        self.assertIn("?t=", body["download_url"])
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])

    async def test_c017_require_auth_on_guards_everything(self):
        docs = [await self.mkdoc("L", kind="artifact"), await self.mkdoc("LP", kind="artifact"),
                await self.mkdoc("W")]
        self.assertTrue(self.r2.objects[docs[0]["blob_key"]]["public"])
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}", headers=self.session("wa"),
                                json={"settings": {"require_auth_to_view": True}})
        self.assertEqual(r.status_code, 200, r.text)
        for d in docs[:2]:
            self.assertFalse(self.r2.objects[d["blob_key"]]["public"])
            self.assertGreater((await self.doc(d["slug"]))["access_epoch"], 0)
        jobs = await self.jobs()
        for d in docs:
            self.assertIn(f"doc:{d['slug']}", jobs)
        self.assertIn(f"tag:wsl:{self.ws['W1']}", jobs)

    async def test_c018_require_auth_off_reopens_link_only(self):
        l_doc = await self.mkdoc("RL", kind="artifact")
        lp_doc = await self.mkdoc("RLP", kind="artifact")
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['WR']}", headers=self.session("wa"),
                                json={"settings": {"require_auth_to_view": False}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.r2.objects[l_doc["blob_key"]]["public"])
        self.assertFalse(self.r2.objects[lp_doc["blob_key"]]["public"])

    async def test_c019_stack_isr_render_gated_after_toggle(self):
        self.skipTest("[S] #19: needs frontend ISR + tenant host (run live)")

    async def test_c020_rl_og_card_content_free(self):
        from unittest import mock

        from app.services import og_render

        cards = []
        d = await self.mkdoc("RL")
        with mock.patch.object(og_render, "render_og_png", lambda card: cards.append(card) or b"png"):
            for host in (None, "docs-r.acme.test"):
                params = {"host": host} if host else {}
                r = await self.http.get(f"/api/v1/og/{d['slug']}.png", params=params)
                self.assertEqual(r.status_code, 200)
        for card in cards:
            self.assertNotEqual(card.kind, "document")
            self.assertNotIn(d["title"], repr(card))

    async def test_c021_rp_member_404(self):
        d = await self.mkdoc("RP")
        self.assertEqual((await self.get(d["slug"], self.session("wm"))).status_code, 404)

    async def test_c022_rl_edit_secret_reads(self):
        d = await self.mkdoc("RL")
        self.assertEqual((await self.get(d["slug"], {"X-Edit-Secret": ES_SECRET})).status_code, 200)


class Grants(AccessWorld):
    async def _share(self, who, slug, email, role="viewer"):
        return await self.http.post(f"/api/v1/documents/{slug}/access/people", headers=self.session(who),
                                    json={"email": email, "role": role, "notify": False})

    async def test_c023_grant_before_account_normalised(self):
        d = await self.mkdoc("P", ws=None, grants=False)
        r = await self._share("owner", d["slug"], "Alice@Example.COM ")
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["email"], "alice@example.com")
        self.uid["alice"], self.email["alice"] = await self.make_user("alice@example.com"), "alice@example.com"
        self.assertEqual((await self.get(d["slug"], self.session("alice"))).status_code, 200)

    async def test_c024_no_plus_folding(self):
        d = await self.mkdoc("P", ws=None, grants=False)
        await self._share("owner", d["slug"], "alice@example.com")
        self.uid["ax"], self.email["ax"] = await self.make_user("alice+x@example.com"), "alice+x@example.com"
        self.assertEqual((await self.get(d["slug"], self.session("ax"))).status_code, 404)

    async def test_c025_no_dot_folding(self):
        d = await self.mkdoc("P", ws=None, grants=False)
        await self._share("owner", d["slug"], "a.lice@gmail.com")
        self.uid["al"], self.email["al"] = await self.make_user("alice@gmail.com"), "alice@gmail.com"
        self.assertEqual((await self.get(d["slug"], self.session("al"))).status_code, 404)

    async def test_c026_idna_normalised(self):
        d = await self.mkdoc("P", ws=None, grants=False)
        r = await self._share("owner", d["slug"], "user@bücher.example")
        self.assertIn(r.status_code, (201, 422), r.text)
        if r.status_code == 422:  # EmailStr may refuse the raw form; store via the service
            raw = await self.doc(d["slug"])
            await access.add_grant(self.db, raw, "user@bücher.example", "viewer",
                                   access.Actor.of(await self._user("owner")), access.Ctx(self.db))
        row = await self.db["document_grants"].find_one({"document_id": str(d["_id"])})
        self.assertEqual(row["email"], "user@xn--bcher-kva.example")
        self.uid["ub"] = await self.make_user("user@xn--bcher-kva.example")
        self.email["ub"] = "user@xn--bcher-kva.example"
        self.assertEqual((await self.get(d["slug"], self.session("ub"))).status_code, 200)

    async def _user(self, who):
        from app.services import user as user_service

        return await user_service.get_user_by_id(self.db, self.uid[who])

    async def test_c027_identity_from_db_not_token_claim(self):
        from app.utils.auth import create_tenant_token

        d = await self.mkdoc("P", grants=False)
        await self._share("owner", d["slug"], "claimed@example.com")
        token, _ = create_tenant_token(self.uid["stranger"], "claimed@example.com", self.ws["W1"], "docs.acme.test")
        r = await self.get(d["slug"], {"Authorization": f"Bearer {token}", "Origin": "https://docs.acme.test"})
        self.assertEqual(r.status_code, 404)

    async def test_c028_no_self_grant_and_granted_via(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        r = await self._share("wm", d["slug"], self.email["wm"])
        self.assertEqual(r.status_code, 403)
        self.assertIn("yourself", r.json()["detail"])
        r = await self._share("wm", d["slug"], "x@example.com", "editor")
        self.assertEqual(r.status_code, 201, r.text)
        row = await self.db["document_grants"].find_one({"email": "x@example.com"})
        self.assertEqual((row["granted_via"], row["granted_by_user_id"]), (self.ws["W1"], self.uid["wm"]))

    async def test_c029_member_removed_grants_die(self):
        d = await self.mkdoc("P", grants=False)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"access_level": "workspace",
                                                                            "allow_resharing": True}})
        self.uid["x"], self.email["x"] = await self.make_user("x@example.com"), "x@example.com"
        self.assertEqual((await self._share("wm", d["slug"], "x@example.com")).status_code, 201)
        self.assertEqual((await self.get(d["slug"], self.session("x"))).status_code, 200)
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                   headers=self.session("wa"))
        self.assertEqual(r.status_code, 204, r.text)
        self.assertIsNone(await self.db["document_grants"].find_one({"email": "x@example.com"}))
        self.assertEqual((await self.get(d["slug"], self.session("x"))).status_code, 404)

    async def test_c030_demoted_member_grants_shrink(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        self.assertEqual((await self._share("wm", d["slug"], "x@example.com", "editor")).status_code, 201)
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                json={"role": "viewer"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual((await self.db["document_grants"].find_one({"email": "x@example.com"}))["role"], "viewer")

    async def test_c031_owner_grant_survives_owner_leaving(self):
        d = await self.mkdoc("P", grants=False)
        self.assertEqual((await self._share("owner", d["slug"], "x@example.com")).status_code, 201)
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['owner']}",
                                   headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        row = await self.db["document_grants"].find_one({"email": "x@example.com"})
        self.assertIsNotNone(row)
        self.assertIsNone(row["granted_via"])

    async def test_c032_viewer_cannot_grant_editor(self):
        d = await self.mkdoc("P", ws=None)
        r = await self._share("gv", d["slug"], "y@example.com", "editor")
        self.assertEqual(r.status_code, 403)
        self.assertIn("more access than you have", r.json()["detail"])

    async def test_c033_no_resharing_editor_cannot_grant(self):
        d = await self.mkdoc("P", ws=None, allow_resharing=False)
        self.assertEqual((await self._share("ge", d["slug"], "y@example.com")).status_code, 403)

    async def test_c034_filing_sets_resharing_false(self):
        d = await self.mkdoc("L", ws=None, allow_resharing=True)
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/add", json={"slugs": [d["slug"]]},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse((await self.doc(d["slug"]))["allow_resharing"])

    async def test_c035_workspace_level_sets_resharing_false(self):
        d = await self.mkdoc("L", allow_resharing=True)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "workspace"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204, r.text)
        self.assertFalse((await self.doc(d["slug"]))["allow_resharing"])

    async def test_c036_owner_email_409(self):
        d = await self.mkdoc("P", ws=None)
        self.assertEqual((await self._share("owner", d["slug"], self.email["owner"])).status_code, 409)

    async def test_c037_grantee_removes_own_grant(self):
        d = await self.mkdoc("P", ws=None)
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/{self.email['gv']}",
                                   headers=self.session("gv"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual((await self.get(d["slug"], self.session("gv"))).status_code, 404)

    async def test_c038_viewer_cannot_remove_others(self):
        d = await self.mkdoc("P", ws=None)
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/{self.email['ge']}",
                                   headers=self.session("gv"))
        self.assertEqual(r.status_code, 403)

    async def test_c039_grant_cap(self):
        d = await self.mkdoc("P", ws=None, grants=False)
        await self.db["document_grants"].insert_many([
            {"document_id": str(d["_id"]), "email": f"p{i}@example.com", "role": "viewer",
             "created_at": datetime.now(timezone.utc)} for i in range(200)])
        r = await self._share("owner", d["slug"], "p201@example.com")
        self.assertEqual(r.status_code, 429)
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 200)

    async def test_c040_stranger_access_endpoint_404(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)

    async def test_c041_viewer_sees_own_role_only(self):
        d = await self.mkdoc("P", ws=None)
        body = (await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session("gv"))).json()
        self.assertEqual(body["your_role"], "viewer")
        self.assertEqual(body["owner_name"], "OWNER")
        self.assertEqual(body["grants"], [])
        self.assertIsNone(body["owner_email"])

    async def test_c042_editor_sees_grants(self):
        d = await self.mkdoc("P", ws=None)
        body = (await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session("ge"))).json()
        self.assertEqual({g["email"] for g in body["grants"]}, {self.email["gv"], self.email["ge"]})
        self.assertTrue(body["can"]["edit"])
        self.assertFalse(body["can"]["settings"])

    async def test_c043_grant_removal_sends_access_event(self):
        d = await self.mkdoc("P", ws=None)
        q = live.subscribe(d["slug"])
        try:
            r = await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/{self.email['gv']}",
                                       headers=self.session("owner"))
            self.assertEqual(r.status_code, 204)
            self.assertEqual(q.get_nowait(), {"type": "access"})
        finally:
            live.unsubscribe(d["slug"], q)

    async def test_c044_delete_removes_grants(self):
        d = await self.mkdoc("P", ws=None)
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 0)


class Writes(AccessWorld):
    async def _put(self, who_headers, d, **body):
        payload = {"title": d["title"], "content": d["content"], **body}
        return await self.http.put(f"/api/v1/documents/{d['slug']}", json=payload, headers=who_headers)

    async def test_c045_member_content_edit(self):
        d = await self.mkdoc("W")
        q = live.subscribe(d["slug"])
        try:
            r = await self._put(self.session("wm"), d, content="edited", read_password=None, expires_in=None)
            self.assertEqual(r.status_code, 200, r.text)
            after = await self.doc(d["slug"])
            self.assertEqual((after["content"], after["rev"]), ("edited", 2))
            self.assertEqual(q.get_nowait()["type"], "changed")
            self.assertIn(f"doc:{d['slug']}", await self.jobs())
            self.assertTrue(r.json()["can"]["edit"])
        finally:
            live.unsubscribe(d["slug"], q)

    async def test_c046_member_cannot_remove_password(self):
        d = await self.mkdoc("W", read_password_hash="h")
        r = await self._put(self.session("wm"), d, read_password="")
        self.assertEqual(r.status_code, 403)
        self.assertEqual((await self.doc(d["slug"]))["read_password_hash"], "h")

    async def test_c047_member_cannot_set_expiry(self):
        d = await self.mkdoc("W")
        self.assertEqual((await self._put(self.session("wm"), d, expires_in="1d")).status_code, 403)

    async def test_c048_past_expiry_422(self):
        d = await self.mkdoc("L", ws=None)
        r = await self._put(self.session("owner"), d, expires_in="custom",
                            custom_expires_at=iso(datetime.now(timezone.utc) - timedelta(days=1)))
        self.assertEqual(r.status_code, 422)
        self.assertIsNotNone(await self.doc(d["slug"]))

    async def test_c049_custom_without_date_422(self):
        d = await self.mkdoc("L", ws=None, expires_at=datetime.now(timezone.utc) + timedelta(days=3))
        r = await self._put(self.session("owner"), d, expires_in="custom")
        self.assertEqual(r.status_code, 422)
        self.assertIsNotNone((await self.doc(d["slug"]))["expires_at"])

    async def test_c050_viewer_cannot_edit(self):
        d = await self.mkdoc("W")
        self.assertEqual((await self._put(self.session("wv"), d, content="x")).status_code, 403)

    async def test_c051_member_private_filed_404(self):
        d = await self.mkdoc("P")
        self.assertEqual((await self._put(self.session("wm"), d, content="x")).status_code, 404)

    async def test_c052_editor_grantee_content_not_password(self):
        d = await self.mkdoc("P", ws=None)
        self.assertEqual((await self._put(self.session("ge"), d, content="x")).status_code, 200)
        self.assertEqual((await self._put(self.session("ge"), d, read_password="p")).status_code, 403)

    async def test_c053_edit_secret_password_but_not_level(self):
        d = await self.mkdoc("L", ws=None)
        es = {"X-Edit-Secret": ES_SECRET}
        self.assertEqual((await self._put(es, d, read_password="p")).status_code, 200)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"}, headers=es)
        self.assertIn(r.status_code, (401, 403))

    async def test_c054_admin_cannot_delete(self):
        d = await self.mkdoc("W")
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}", headers=self.session("wa"))
        self.assertEqual(r.status_code, 403)
        self.assertIsNotNone(await self.doc(d["slug"]))

    async def test_c055_admin_cannot_rename(self):
        d = await self.mkdoc("W")
        r = await self.http.patch(f"/api/v1/documents/{d['slug']}/slug", json={"new_slug": "new-name"},
                                  headers=self.session("wa"))
        self.assertEqual(r.status_code, 403)

    async def test_c056_owner_delete_cleans_everything(self):
        d = await self.mkdoc("W", kind="artifact", poster_key=None)
        poster = f"art/{self.uid['owner']}/p.poster.jpg"
        self.r2.put_bytes(poster, b"j", "image/jpeg")
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"poster_key": poster}})
        old = f"art/{self.uid['owner']}/old.html"
        self.r2.put_bytes(old, b"o", "text/html")
        await self.db["file_versions"].insert_one({"doc_id": str(d["_id"]), "version": 0, "blob_key": old,
                                                   "user_id": self.uid["owner"], "size_bytes": 1})
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        for k in (d["blob_key"], poster, old):
            self.assertNotIn(k, self.r2.objects)
        self.assertEqual(await self.db["file_versions"].count_documents({"doc_id": str(d["_id"])}), 0)
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 0)
        tomb = await self.db["slug_tombstones"].find_one({"slug": d["slug"]})
        self.assertEqual(tomb["owner_id"], self.uid["owner"])

    async def test_c057_tombstoned_slug_owner_only(self):
        d = await self.mkdoc("L", ws=None, slug="keep-mine")
        await self.http.delete(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"))
        r = await self.http.post("/api/v1/documents", json={"content": "x", "custom_slug": "keep-mine"},
                                 headers=self.session("stranger"))
        self.assertEqual(r.status_code, 409)
        r = await self.http.post("/api/v1/documents", json={"content": "x", "custom_slug": "keep-mine"},
                                 headers=self.session("owner"))
        self.assertEqual(r.status_code, 201, r.text)

    async def test_c058_rename_old_slug_redirects_for_readers(self):
        d = await self.mkdoc("L", ws=None, slug="name-a")
        q = live.subscribe("name-a")
        try:
            r = await self.http.patch("/api/v1/documents/name-a/slug", json={"new_slug": "name-b"},
                                      headers=self.session("owner"))
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(q.get_nowait(), {"type": "gone"})
        finally:
            live.unsubscribe("name-a", q)
        r = await self.get("name-a")
        # Q4 (owner decision): readers of the document are redirected.
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["moved"], r.json()["slug"]), (True, "name-b"))
        self.assertEqual(r.headers["X-Markdrop-Moved"], "name-b")
        self.assertEqual((await self.get("name-b")).status_code, 200)
        jobs = await self.jobs()
        self.assertIn("doc:name-a", jobs)
        self.assertIn("doc:name-b", jobs)

    async def test_c058b_old_slug_never_reveals_new_to_non_readers(self):
        d = await self.mkdoc("P", ws=None, slug="secret-a")
        await self.http.patch("/api/v1/documents/secret-a/slug", json={"new_slug": "secret-b"},
                              headers=self.session("owner"))
        r = await self.get("secret-a", self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("secret-b", r.text)
        r = await self.get("secret-a")
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "signin"))
        self.assertNotIn("secret-b", r.text)
        # Reserved for that document: nobody else can claim it.
        r = await self.http.post("/api/v1/documents", json={"content": "x", "custom_slug": "secret-a"},
                                 headers=self.session("stranger"))
        self.assertEqual(r.status_code, 409)

    async def test_c059_owx_cannot_set_workspace_level(self):
        d = await self.mkdoc("L", owner="ownx")
        h = self.session("ownx")
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "workspace"}, headers=h)
        self.assertEqual(r.status_code, 403)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"}, headers=h)
        self.assertEqual(r.status_code, 204)

    async def test_c060_unfiled_workspace_level_422(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "workspace"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 422)

    async def test_c061_close_first_failure_keeps_db_open(self):
        d = await self.mkdoc("L", ws=None, kind="artifact")
        self.r2.fail_set_public = True
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 502)
        after = await self.doc(d["slug"])
        self.assertEqual(after["access_level"], "link")
        self.assertTrue(after["access_dirty"])

    async def test_c062_widen_failure_still_succeeds_reconciler_opens(self):
        from app.services import lifecycle

        d = await self.mkdoc("P", ws=None, kind="artifact")
        self.r2.fail_set_public = True
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "link"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual((await self.doc(d["slug"]))["access_level"], "link")
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])
        self.r2.fail_set_public = False
        await lifecycle.reconcile_once(self.db)
        self.assertTrue(self.r2.objects[d["blob_key"]]["public"])
        self.assertFalse((await self.doc(d["slug"]))["access_dirty"])

    async def test_c063_narrowing_enqueues_before_response(self):
        d = await self.mkdoc("L")
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        jobs = await self.jobs()
        self.assertIn(f"doc:{d['slug']}", jobs)
        self.assertIn(f"tag:wsl:{self.ws['W1']}", jobs)

    async def test_c064_ownerless_secret_delete_but_not_level(self):
        d = await self.mkdoc("L", ws=None, owner=None)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                                headers={"X-Edit-Secret": ES_SECRET})
        self.assertEqual(r.status_code, 401)
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}", headers={"X-Edit-Secret": ES_SECRET})
        self.assertEqual(r.status_code, 204)

    async def test_c065_artifact_title_patch_by_role(self):
        for who, status in (("ge", 200), ("wm", 200), ("wv", 403)):
            d = await self.mkdoc("W", kind="artifact")
            r = await self.http.patch(f"/api/v1/artifacts/{d['slug']}", json={"title": "New"},
                                      headers=self.session(who))
            self.assertEqual(r.status_code, status, (who, r.text))

    async def test_c066_editor_cannot_patch_artifact_password(self):
        d = await self.mkdoc("W", kind="artifact")
        r = await self.http.patch(f"/api/v1/artifacts/{d['slug']}", json={"read_password": "x"},
                                  headers=self.session("ge"))
        self.assertEqual(r.status_code, 403)

    def _admin(self):
        from app.routers.admin import _make_token

        return {"Authorization": f"Bearer {_make_token()[0]}"}

    async def test_c067_admin_cannot_edit_encrypted(self):
        d = await self.mkdoc("L", ws=None, encrypted=True)
        r = await self.http.put(f"/api/v1/admin/documents/{d['slug']}", json={"title": "x", "content": "y"},
                                headers=self._admin())
        self.assertEqual(r.status_code, 422)

    async def test_c068_admin_edit_side_effects(self):
        d = await self.mkdoc("L", ws=None)
        q = live.subscribe(d["slug"])
        try:
            r = await self.http.put(f"/api/v1/admin/documents/{d['slug']}", json={"title": "x", "content": "y"},
                                    headers=self._admin())
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual((await self.doc(d["slug"]))["rev"], 2)
            self.assertEqual(q.get_nowait()["type"], "changed")
            self.assertIn(f"doc:{d['slug']}", await self.jobs())
        finally:
            live.unsubscribe(d["slug"], q)

    async def test_c069_admin_delete_artifact_cleans_up(self):
        d = await self.mkdoc("L", ws=None, kind="artifact")
        r = await self.http.delete(f"/api/v1/admin/documents/{d['slug']}", headers=self._admin())
        self.assertEqual(r.status_code, 204)
        self.assertNotIn(d["blob_key"], self.r2.objects)
        self.assertEqual(await self.db["document_grants"].count_documents({"document_id": str(d["_id"])}), 0)

    async def test_c070_rotate_edit_secret(self):
        d = await self.mkdoc("L", ws=None)
        r = await self.http.post(f"/api/v1/documents/{d['slug']}/edit-secret/rotate", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        new = r.json()["edit_secret"]
        put = {"title": "t", "content": "c"}
        self.assertEqual((await self.http.put(f"/api/v1/documents/{d['slug']}", json=put,
                                              headers={"X-Edit-Secret": ES_SECRET})).status_code, 401)
        self.assertEqual((await self.http.put(f"/api/v1/documents/{d['slug']}", json=put,
                                              headers={"X-Edit-Secret": new})).status_code, 200)


class Files(AccessWorld):
    async def _replace(self, who, slug, data=b"<h1>v2</h1>"):
        key = f"art/{self.uid[who]}/{secrets.token_hex(5)}.html"
        self.r2.put_bytes(key, data, "text/html", False)
        return await self.http.put(f"/api/v1/artifacts/{slug}/file", json={"blob_key": key, "filename": "v2.html"},
                                   headers=self.session(who)), key

    async def test_c071_member_replace_charges_owner(self):
        d = await self.mkdoc("W", kind="artifact")
        r, key = await self._replace("wm", d["slug"])
        self.assertEqual(r.status_code, 200, r.text)
        after = await self.doc(d["slug"])
        self.assertEqual((after["blob_key"], after["file_version"]), (key, 2))
        rows = await self.db["file_versions"].find({"doc_id": str(d["_id"])}).to_list(10)
        self.assertTrue(rows)
        self.assertTrue(all(r["user_id"] == self.uid["owner"] for r in rows))

    async def _fill_quota(self, d):
        from unittest import mock

        old = f"art/{self.uid['owner']}/old.html"
        self.r2.put_bytes(old, b"o" * 10, "text/html")
        await self.db["file_versions"].insert_one({"doc_id": str(d["_id"]), "version": 0, "blob_key": old,
                                                   "user_id": self.uid["owner"], "size_bytes": 1000})
        p = mock.patch.object(settings, "artifact_user_quota_bytes", 1020)
        p.start()
        self.addCleanup(p.stop)
        return old

    async def test_c072_non_owner_quota_shortfall_507(self):
        d = await self.mkdoc("P", ws=None, kind="artifact")
        old = await self._fill_quota(d)
        r, _ = await self._replace("ge", d["slug"], b"x" * 20)
        self.assertEqual(r.status_code, 507)
        self.assertTrue(await self.db["file_versions"].find_one({"blob_key": old}))

    async def test_c073_owner_quota_drops_old_versions(self):
        d = await self.mkdoc("P", ws=None, kind="artifact")
        old = await self._fill_quota(d)
        r, _ = await self._replace("owner", d["slug"], b"x" * 20)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(await self.db["file_versions"].find_one({"blob_key": old}))

    async def test_c074_member_cannot_replace_bundle(self):
        d = await self.mkdoc("W", kind="artifact", bundle=True)
        r, _ = await self._replace("wm", d["slug"])
        self.assertEqual(r.status_code, 403)

    async def test_c075_versions_by_role(self):
        d = await self.mkdoc("W", kind="artifact")
        self.assertEqual((await self.http.get(f"/api/v1/files/{d['slug']}/versions",
                                              headers=self.session("wv"))).status_code, 403)
        self.assertEqual((await self.http.get(f"/api/v1/files/{d['slug']}/versions",
                                              headers=self.session("ge"))).status_code, 200)

    async def _start(self, who, data, **extra):
        body = {"file_name": "v.html", "size_bytes": len(data), "content_type": "text/html",
                "sha256": hashlib.sha256(data).hexdigest(), **extra}
        return await self.http.post("/api/v1/files/uploads", json=body, headers=self.session(who))

    async def _finish(self, who, upload_id, data):
        sess = await self.db["file_uploads"].find_one({"_id": upload_id})
        etag = self.r2.put_part(sess["r2_upload_id"], 1, data)
        return await self.http.post(f"/api/v1/files/uploads/{upload_id}/complete",
                                    json={"parts": [{"part_number": 1, "etag": etag}]}, headers=self.session(who))

    async def test_c076_grant_revoked_before_complete(self):
        d = await self.mkdoc("P", ws=None, kind="artifact")
        data = b"<h1>new</h1>"
        r = await self._start("ge", data, target_slug=d["slug"])
        self.assertEqual(r.status_code, 200, r.text)
        await self.db["document_grants"].delete_many({"email": self.email["ge"]})
        r = await self._finish("ge", r.json()["upload_id"], data)
        self.assertIn(r.status_code, (403, 404))
        self.assertEqual((await self.doc(d["slug"]))["blob_key"], d["blob_key"])

    async def test_c077_rl_replace_stays_private(self):
        d = await self.mkdoc("RL", kind="artifact")
        r, key = await self._replace("owner", d["slug"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self.r2.objects[key]["public"])
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])

    async def test_c078_poster_follows_level(self):
        d = await self.mkdoc("L", ws=None, kind="artifact")
        poster = f"art/{self.uid['owner']}/p.poster.jpg"
        self.r2.put_bytes(poster, b"j", "image/jpeg", True)
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"poster_key": poster}})
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                                headers=self.session("owner"))
        self.assertEqual(r.status_code, 204)
        self.assertFalse(self.r2.objects[poster]["public"])

    async def test_c079_restore_publicity(self):
        d = await self.mkdoc("L", ws=None, kind="artifact")
        r, key = await self._replace("owner", d["slug"])
        self.assertTrue(self.r2.objects[key]["public"])
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])
        r = await self.http.post(f"/api/v1/files/{d['slug']}/versions/1/restore", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.r2.objects[d["blob_key"]]["public"])
        self.assertFalse(self.r2.objects[key]["public"])

    async def test_c080_viewer_upload_into_workspace_refused_before_urls(self):
        r = await self._start("wv", b"x", workspace=self.ws["W1"])
        self.assertIn(r.status_code, (403, 404))
        self.assertEqual(self.r2.uploads, {})

    async def test_c081_membership_removed_before_commit(self):
        data = b"<h1>w</h1>"
        r = await self._start("wm", data, workspace=self.ws["W1"])
        self.assertEqual(r.status_code, 200, r.text)
        await self.remove_member("W1", "wm")
        r = await self._finish("wm", r.json()["upload_id"], data)
        self.assertEqual(r.status_code, 200, r.text)
        res = r.json()
        self.assertTrue(res["workspace_error"])
        raw = await self.doc(res["slug"])
        self.assertEqual(raw["access_level"], "private")
        self.assertIsNone(raw.get("workspace_id"))

    async def test_c081b_upload_with_folder_and_canonical_url(self):
        await self.db["folders"].insert_one({"workspace_id": self.ws["W1"], "name": "Videos", "slug": "videos",
                                             "parent_id": None, "created_at": datetime.now(timezone.utc),
                                             "updated_at": datetime.now(timezone.utc)})
        data = b"<h1>v</h1>"
        r = await self._start("wm", data, workspace=self.ws["W1"], folder="videos", access="link")
        self.assertEqual(r.status_code, 200, r.text)
        res = (await self._finish("wm", r.json()["upload_id"], data)).json()
        self.assertEqual(res["url"], f"https://docs.acme.test/videos/{res['slug']}")
        self.assertEqual(res["markdrop_url"], f"https://markdrop.in/{res['slug']}")
        raw = await self.doc(res["slug"])
        self.assertEqual((raw["access_level"], raw["folder_path"]), ("link", ["videos"]))
        self.assertTrue(self.r2.objects[raw["blob_key"]]["public"])
        r = await self._start("wm", data, workspace=self.ws["W1"], folder="nope")
        self.assertEqual(r.status_code, 404)
        self.assertIn("videos", r.json()["detail"])

    async def test_c082_files_info_gates(self):
        p = await self.mkdoc("P", ws=None, kind="artifact")
        lp = await self.mkdoc("LP", ws=None, kind="artifact")
        self.assertEqual((await self.http.get(f"/api/v1/files/{p['slug']}", headers=self.session("stranger"))).status_code, 404)
        r = await self.http.get(f"/api/v1/files/{lp['slug']}", headers=self.session("stranger"))
        self.assertEqual((r.status_code, r.headers.get("X-Markdrop-Gate")), (401, "password"))
        self.assertNotIn("?t=", r.text)

    async def test_c083_files_info_signed_with_epoch(self):
        import jwt

        d = await self.mkdoc("W", kind="artifact", access_epoch=3)
        r = await self.http.get(f"/api/v1/files/{d['slug']}", headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        token = r.json()["download_url"].split("?t=")[1]
        self.assertEqual(jwt.decode(token, "k", algorithms=["HS256"])["e"], 3)

    async def test_c084_stack_old_signed_url_403_after_epoch(self):
        self.skipTest("[S] #84: needs the Worker (epoch check is in worker/src/index.js)")

    async def test_c085_stack_public_object_private_after_cache(self):
        self.skipTest("[S] #85: needs the Worker and browser cache")
