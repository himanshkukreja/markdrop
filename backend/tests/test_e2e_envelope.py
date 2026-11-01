"""End-to-end encrypted documents, server side: the envelope's shape on every
write path, ``base_rev`` (no silent overwrite of a newer version — a stale tab
can't undo a key rotation), the keyless settings path, and the copy refusal.

The server never sees a key and never checks more than shape.

Run: MARKDROP_TEST_MONGODB_URI=mongodb://127.0.0.1:27019 python -m unittest tests.test_e2e_envelope
"""

from __future__ import annotations

from tests._access_env import ES_SECRET, AccessWorld

from app.services import document as doc_service

V1 = "mdx1.ZGVmZ2hpamtsbW5v.MzmqREPLHvtSDjDK9kcJ33jgJSrYCZAAwqXwJqfNxyfwkGAD5TDm9favtFAPeOY7HA3reizUqA"
V2 = ("mdx2.AgAAAAAAAAEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaG3w04LEXbaqowCmQDpCI0C_rULf0sakUkJBRklonqhVA."
      "Jw5DHJfnC5WS7jTME5MlaQIg4XEXWMyEzECOo9YLvFBBysSMLeeUwQ3fqkdvvqKNMusjzwbMFdaa3oCdIbqcrZGerqZ9nxvo")
V2_NEXT = V2[:-4] + "AAAA"


class Shape(AccessWorld):
    async def create(self, headers: dict | None = None, **body) -> object:
        return await self.http.post("/api/v1/documents", headers=headers or {}, json=body)

    async def test_create_accepts_v1_and_v2_envelopes(self):
        for env in (V1, V2):
            r = await self.create(content=env, encrypted=True)
            self.assertEqual(r.status_code, 201, r.text)
            raw = await self.doc(r.json()["slug"])
            self.assertEqual((raw["content"], raw["title"], raw["encrypted"]), (env, None, True))

    async def test_create_refuses_an_encrypted_document_that_isnt_an_envelope(self):
        before = await self.db["documents"].count_documents({})
        for body in (
            {"content": "# plain text", "encrypted": True},
            {"content": "mdx1.", "encrypted": True},
            {"content": "mdx1.onlyonepart", "encrypted": True},
            {"content": "mdx3.abc.def", "encrypted": True},
            {"content": "mdx2.ab c.def", "encrypted": True},
            {"content": V2, "encrypted": True, "title": "Leaked title"},
        ):
            r = await self.create(**body)
            self.assertEqual(r.status_code, 422, (body, r.text))
            self.assertIn("envelope", r.json()["detail"])
        self.assertEqual(await self.db["documents"].count_documents({}), before)

    async def test_create_refuses_an_envelope_sent_as_plain_text(self):
        for env in (V1, V2):
            r = await self.create(content=env)
            self.assertEqual(r.status_code, 422, r.text)
        # Plain text that merely starts with the letters is fine.
        for ok in ("mdx1 is a format", "mdx2.short.x", "# mdx1.ZGVmZ2hpamtsbW5v.abc"):
            r = await self.create(content=ok)
            self.assertEqual(r.status_code, 201, (ok, r.text))

    async def test_filed_create_checks_the_shape_too(self):
        r = await self.create(self.session("wm"), content="# not sealed", encrypted=True, workspace=self.ws["W1"])
        self.assertEqual(r.status_code, 422, r.text)
        r = await self.create(self.session("wm"), content=V2, encrypted=True, workspace=self.ws["W1"])
        self.assertEqual(r.status_code, 201, r.text)
        self.assertTrue((await self.doc(r.json()["slug"]))["encrypted"])

    async def test_mcp_publish_refuses_an_envelope_as_markdown(self):
        token = await self.mcp_token("wm")
        status, result = await self.mcp_call(token, "publish_document", {"markdown": V2})
        self.assertEqual(status, 200)
        self.assertTrue(result.get("isError"), result)
        self.assertEqual(await self.db["documents"].count_documents({"content": V2}), 0)

    async def test_put_both_directions(self):
        enc = await self.mkdoc("UL", encrypted=True, content=V1, title=None)
        plain = await self.mkdoc("UL")
        h = {"X-Edit-Secret": ES_SECRET}
        url = "/api/v1/documents/"
        # Encrypted: only an envelope, never a title.
        r = await self.http.put(url + enc["slug"], headers=h, json={"content": "# oops plaintext"})
        self.assertEqual(r.status_code, 422, r.text)
        r = await self.http.put(url + enc["slug"], headers=h, json={"content": V2, "title": "x"})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual((await self.doc(enc["slug"]))["content"], V1)
        r = await self.http.put(url + enc["slug"], headers=h, json={"content": V2})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.doc(enc["slug"]))["content"], V2)
        # Plain: never an envelope.
        r = await self.http.put(url + plain["slug"], headers=h, json={"content": V2})
        self.assertEqual(r.status_code, 422, r.text)
        r = await self.http.put(url + plain["slug"], headers=h, json={"content": "# fine"})
        self.assertEqual(r.status_code, 200, r.text)

    def test_shape_helper(self):
        doc_service.check_envelope_shape(encrypted=True, title=None, content=V1)
        doc_service.check_envelope_shape(encrypted=True, title="", content=V2)
        doc_service.check_envelope_shape(encrypted=False, title="t", content="hello")


class BaseRev(AccessWorld):
    async def put(self, slug: str, **body):
        return await self.http.put(f"/api/v1/documents/{slug}", headers={"X-Edit-Secret": ES_SECRET}, json=body)

    async def test_response_carries_rev(self):
        d = await self.mkdoc("UL", encrypted=True, content=V1, title=None)
        r = await self.get(d["slug"])
        self.assertEqual(r.json()["rev"], 1)

    async def test_stale_base_rev_is_409_and_writes_nothing(self):
        d = await self.mkdoc("UL", encrypted=True, content=V1, title=None)
        # The rotation: tab A saves under a new key.
        r = await self.put(d["slug"], content=V2, base_rev=1)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["rev"], 2)
        # Tab B, opened before it, saves its old-key envelope: refused, rotation kept.
        r = await self.put(d["slug"], content=V2_NEXT, base_rev=1)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("changed somewhere else", r.json()["detail"])
        raw = await self.doc(d["slug"])
        self.assertEqual((raw["content"], raw["rev"]), (V2, 2))
        # With the current rev it goes through.
        r = await self.put(d["slug"], content=V2_NEXT, base_rev=2)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.doc(d["slug"]))["rev"], 3)

    async def test_without_base_rev_last_write_wins_as_before(self):
        d = await self.mkdoc("UL")
        for text in ("# one", "# two"):
            r = await self.put(d["slug"], content=text)
            self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.doc(d["slug"]))["rev"], 3)

    async def test_base_rev_must_be_positive(self):
        d = await self.mkdoc("UL")
        r = await self.put(d["slug"], content="# x", base_rev=0)
        self.assertEqual(r.status_code, 422, r.text)

    async def test_the_write_itself_compares_rev(self):
        # A writer that slips in between the read and the write: the CAS refuses.
        d = await self.mkdoc("UL", encrypted=True, content=V1, title=None)
        from app.services import transitions

        orig = transitions.change

        async def racing(db, raw, **kw):
            await db["documents"].update_one({"_id": raw["_id"]}, {"$inc": {"rev": 1}})
            return await orig(db, raw, **kw)

        transitions.change = racing
        try:
            r = await self.put(d["slug"], content=V2, base_rev=1)
        finally:
            transitions.change = orig
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("changed somewhere else", r.json()["detail"])
        self.assertEqual((await self.doc(d["slug"]))["content"], V1)


class KeylessSettings(AccessWorld):
    async def test_patch_settings_changes_expiry_and_keeps_the_envelope(self):
        d = await self.mkdoc("UL", encrypted=True, content=V2, title=None)
        r = await self.http.patch(f"/api/v1/documents/{d['slug']}/settings",
                                  headers={"X-Edit-Secret": ES_SECRET}, json={"expires_in": "7d"})
        self.assertEqual(r.status_code, 200, r.text)
        raw = await self.doc(d["slug"])
        self.assertIsNotNone(raw["expires_at"])
        self.assertEqual((raw["content"], raw["title"], raw["encrypted"]), (V2, None, True))
        self.assertEqual(r.json()["rev"], 2)
        # And a stale editor that read rev 1 can't then write its old envelope over it.
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers={"X-Edit-Secret": ES_SECRET},
                                json={"content": V1, "base_rev": 1})
        self.assertEqual(r.status_code, 409, r.text)

    async def test_patch_settings_removes_a_legacy_server_password(self):
        d = await self.mkdoc("ULP", encrypted=True, content=V2, title=None)
        self.assertEqual((await self.get(d["slug"])).status_code, 401)
        r = await self.http.patch(f"/api/v1/documents/{d['slug']}/settings",
                                  headers={"X-Edit-Secret": ES_SECRET}, json={"remove_password": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone((await self.doc(d["slug"]))["read_password_hash"])
        self.assertEqual((await self.get(d["slug"])).json()["content"], V2)

    async def test_no_new_server_password_on_an_encrypted_document(self):
        # Create, PATCH settings and PUT all refuse it; nothing is written.
        r = await self.http.post("/api/v1/documents", json={"content": V2, "encrypted": True, "read_password": "hunter22"})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("Also require a password", r.text)
        d = await self.mkdoc("UL", encrypted=True, content=V2, title=None)
        r = await self.http.patch(f"/api/v1/documents/{d['slug']}/settings",
                                  headers={"X-Edit-Secret": ES_SECRET}, json={"read_password": "hunter22"})
        self.assertEqual(r.status_code, 422, r.text)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers={"X-Edit-Secret": ES_SECRET},
                                json={"content": V2_NEXT, "read_password": "hunter22"})
        self.assertEqual(r.status_code, 422, r.text)
        raw = await self.doc(d["slug"])
        self.assertEqual((raw.get("read_password_hash"), raw["content"]), (None, V2))
        # A plain document still takes one.
        p = await self.mkdoc("UL", content="# hello")
        r = await self.http.patch(f"/api/v1/documents/{p['slug']}/settings",
                                  headers={"X-Edit-Secret": ES_SECRET}, json={"read_password": "hunter22"})
        self.assertEqual(r.status_code, 200, r.text)

    async def test_patch_settings_needs_the_secret_or_the_owner(self):
        d = await self.mkdoc("UL", encrypted=True, content=V2, title=None)
        r = await self.http.patch(f"/api/v1/documents/{d['slug']}/settings", json={"expires_in": "7d"})
        self.assertIn(r.status_code, (401, 403), r.text)


class Copy(AccessWorld):
    async def test_copy_of_an_encrypted_document_points_at_the_browser(self):
        d = await self.mkdoc("UL", encrypted=True, content=V2, title=None)
        r = await self.http.post(f"/api/v1/documents/{d['slug']}/copy", headers=self.session("stranger"), json={})
        self.assertEqual(r.status_code, 422, r.text)
        detail = r.json()["detail"]
        self.assertIn("Save a copy", detail)
        self.assertIn("full link", detail)
        self.assertIn("new key", detail)
