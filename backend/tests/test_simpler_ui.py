"""Simpler workspaces UI — backend (scratchpad specs/simpler-ui-spec.md, Backend 1–7).

Folder defaults, exposure counts, Preview as, Request access, Shared with me,
Recent, Quick search, plus the reserved slugs. Every list/preview is checked
across the actor matrix for leaks: anonymous, stranger, viewer (wv), member
(wm), admin (wa), workspace owner (wo), document owner, grantee (gv), removed
member and a tenant token.
"""

from __future__ import annotations

import json
import secrets
from datetime import timedelta
from unittest import mock

from bson import ObjectId

from tests._access_env import AccessWorld, now

from app.services import access, access_requests, mailer, personal
from app.services import traffic
from app.utils.slug import RESERVED_SLUGS


class World(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await access_requests.ensure_indexes(self.db)
        await personal.ensure_indexes(self.db)
        self.mail: list[dict] = []

        async def capture(payload):
            self.mail.append(payload)

        for p in (mock.patch.object(mailer, "is_configured", lambda: True),
                  mock.patch.object(mailer, "_post", capture)):
            p.start()
            self.addCleanup(p.stop)

    async def folder(self, ws_key: str, name: str, parent: str | None = None, **extra) -> str:
        res = await self.db["folders"].insert_one({
            "workspace_id": self.ws[ws_key], "name": name, "slug": name.lower().replace(" ", "-"),
            "parent_id": parent, "created_at": now(), "updated_at": now(), **extra})
        return str(res.inserted_id)

    async def body(self, method: str, path: str, who: str | None = None, headers: dict | None = None,
                   **kw):
        h = headers if headers is not None else (self.session(who) if who else {})
        return await self.http.request(method, path, headers=h, **kw)

    def text_of(self, r) -> str:
        return r.text


# ── 1. Folder default for new items ───────────────────────────────────────────


class FolderDefaults(World):
    async def test_patch_is_admin_only_and_round_trips(self):
        W = self.ws["W1"]
        fid = await self.folder("W1", "Guides")
        url = f"/api/v1/workspaces/{W}/folders/{fid}"
        for who, status in (("wm", 403), ("wv", 403), ("stranger", 404), ("former", 404), ("gv", 404)):
            r = await self.body("PATCH", url, who, json={"default_access": "private"})
            self.assertEqual(r.status_code, status, who)
        r = await self.http.patch(url, json={"default_access": "private"})
        self.assertEqual(r.status_code, 401)
        r = await self.http.patch(url, json={"default_access": "private"}, headers=self.tenant("wa", "W1"))
        self.assertEqual(r.status_code, 401)
        self.assertNotIn("default_access", await self.db["folders"].find_one({"_id": ObjectId(fid)}))

        r = await self.body("PATCH", url, "wa", json={"default_access": "private"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["default_access"], r.json()["effective_default_access"]),
                         ("private", "private"))
        self.assertEqual(r.json()["name"], "Guides")  # nothing else changed
        r = await self.body("PATCH", url, "wo", json={"default_access": None})
        self.assertEqual((r.json()["default_access"], r.json()["effective_default_access"]),
                         (None, "workspace"))  # inherits the workspace's default
        r = await self.body("PATCH", url, "wa", json={"default_access": "everyone"})
        self.assertEqual(r.status_code, 422)
        # Absent ⇒ unchanged.
        await self.body("PATCH", url, "wa", json={"default_access": "link"})
        r = await self.body("PATCH", url, "wa", json={"name": "Guides 2"})
        self.assertEqual(r.json()["default_access"], "link")

    async def test_patch_never_changes_existing_items(self):
        fid = await self.folder("W1", "Guides")
        d = await self.mkdoc("L", folder_id=fid)
        await self.body("PATCH", f"/api/v1/workspaces/{self.ws['W1']}/folders/{fid}", "wa",
                        json={"default_access": "private"})
        self.assertEqual((await self.doc(d["slug"]))["access_level"], "link")

    async def test_tree_carries_defaults(self):
        W = self.ws["W1"]
        f1 = await self.folder("W1", "Open", default_access="link")
        f2 = await self.folder("W1", "Plain")
        await self.db["workspaces"].update_one({"_id": ObjectId(W)}, {"$set": {"settings.default_access": "private"}})
        tree = (await self.body("GET", f"/api/v1/workspaces/{W}/tree", "wv")).json()
        by = {f["id"]: f for f in tree["folders"]}
        self.assertEqual((by[f1]["default_access"], by[f1]["effective_default_access"]), ("link", "link"))
        self.assertEqual((by[f2]["default_access"], by[f2]["effective_default_access"]), (None, "private"))
        self.assertEqual(tree["workspace"]["default_access"], "private")

    async def test_documents_create_filed_uses_the_folder_default(self):
        W = self.ws["W1"]
        fid = await self.folder("W1", "Notes", default_access="private")
        r = await self.body("POST", "/api/v1/documents", "wm",
                            json={"content": "# a", "workspace": W, "folder": fid})
        self.assertEqual(r.status_code, 201, r.text)
        raw = await self.doc(r.json()["slug"])
        self.assertEqual((raw["workspace_id"], raw["folder_id"], raw["access_level"], raw["owner_id"]),
                         (W, fid, "private", self.uid["wm"]))
        self.assertIsNone(r.json()["workspace_error"])
        # By slug path too, and an explicit level wins.
        r = await self.body("POST", "/api/v1/documents", "wm",
                            json={"content": "# b", "workspace": W, "folder": "notes", "access_level": "link"})
        self.assertEqual((await self.doc(r.json()["slug"]))["access_level"], "link")
        # Root: the workspace's default ("workspace" unless set).
        r = await self.body("POST", "/api/v1/documents", "wm", json={"content": "# c", "workspace": W})
        raw = await self.doc(r.json()["slug"])
        self.assertEqual((raw["folder_id"], raw["access_level"]), (None, "workspace"))
        self.assertEqual(r.json()["workspace_url"], f"https://docs.acme.test/{raw['slug']}")

    async def test_documents_create_filed_refusals_create_nothing(self):
        W = self.ws["W1"]
        fid = await self.folder("W1", "Notes")
        before = await self.db["documents"].count_documents({})
        cases = [
            ({}, {"workspace": W}, 401),                                   # anonymous
            (self.session("stranger"), {"workspace": W}, 404),
            (self.session("former"), {"workspace": W}, 404),
            (self.session("wv"), {"workspace": W}, 403),                   # viewers can't add
            (self.session("wm"), {"workspace": W, "folder": "missing"}, 404),
            (self.session("wm2"), {"workspace": W, "folder": fid}, 404),   # other workspace
            (self.session("wm"), {"folder": fid}, 422),                    # folder without workspace
            (self.session("wm"), {"access_level": "workspace"}, 422),
            (self.tenant("wm", "W1"), {"workspace": W}, 401),
        ]
        for headers, extra, status in cases:
            r = await self.http.post("/api/v1/documents", headers=headers, json={"content": "# x", **extra})
            self.assertEqual(r.status_code, status, (extra, r.text))
        self.assertEqual(await self.db["documents"].count_documents({}), before)

    async def test_files_upload_uses_the_folder_default(self):
        W = self.ws["W1"]
        fid = await self.folder("W1", "Media", default_access="link")
        body = {"file_name": "a.html", "size_bytes": 10, "content_type": "text/html",
                "sha256": "a" * 64, "workspace": W, "folder": fid}
        r = await self.body("POST", "/api/v1/files/uploads", "wm", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        sess = await self.db["file_uploads"].find_one({"_id": r.json()["upload_id"]})
        self.assertEqual((sess["access"], sess["folder_id"]), ("link", fid))
        r = await self.body("POST", "/api/v1/files/uploads", "wm",
                            json={**body, "folder": None, "file_name": "b.html", "sha256": "b" * 64})
        sess = await self.db["file_uploads"].find_one({"_id": r.json()["upload_id"]})
        self.assertEqual(sess["access"], "workspace")  # the workspace default at the root
        r = await self.body("POST", "/api/v1/files/uploads", "wm",
                            json={**body, "access": "private", "file_name": "c.html", "sha256": "c" * 64})
        sess = await self.db["file_uploads"].find_one({"_id": r.json()["upload_id"]})
        self.assertEqual(sess["access"], "private")

    async def test_artifact_confirm_filed_born_private_then_default(self):
        W = self.ws["W1"]
        fid = await self.folder("W1", "Pages", default_access="link")
        key = f"art/{self.uid['wm']}/p.html"
        self.r2.put_bytes(key, b"<h1>x</h1>", "text/html", False)
        r = await self.body("POST", "/api/v1/artifacts", "wm",
                            json={"blob_key": key, "filename": "p.html", "workspace": W, "folder": fid})
        self.assertEqual(r.status_code, 201, r.text)
        raw = await self.doc(r.json()["slug"])
        self.assertEqual((raw["workspace_id"], raw["folder_id"], raw["access_level"]), (W, fid, "link"))
        self.assertTrue(self.r2.objects[key]["public"])
        self.assertIsNone(r.json()["workspace_error"])
        # A private default keeps the bytes closed.
        await self.db["folders"].update_one({"_id": ObjectId(fid)}, {"$set": {"default_access": "private"}})
        key2 = f"art/{self.uid['wm']}/q.html"
        self.r2.put_bytes(key2, b"<h1>y</h1>", "text/html", False)
        r = await self.body("POST", "/api/v1/artifacts", "wm",
                            json={"blob_key": key2, "filename": "q.html", "workspace": W, "folder": fid})
        raw = await self.doc(r.json()["slug"])
        self.assertEqual(raw["access_level"], "private")
        self.assertFalse(self.r2.objects[key2]["public"])
        # A viewer is refused before the blob is touched.
        key3 = f"art/{self.uid['wv']}/r.html"
        self.r2.put_bytes(key3, b"<h1>z</h1>", "text/html", False)
        r = await self.body("POST", "/api/v1/artifacts", "wv",
                            json={"blob_key": key3, "filename": "r.html", "workspace": W, "folder": fid})
        self.assertEqual(r.status_code, 403)
        self.assertIn(key3, self.r2.objects)

    async def test_items_add_does_not_apply_the_default(self):
        W = self.ws["W1"]
        fid = await self.folder("W1", "Notes", default_access="private")
        d = await self.mkdoc("L", ws=None, owner="wm", grants=False)
        r = await self.body("POST", f"/api/v1/workspaces/{W}/items/add", "wm",
                            json={"slugs": [d["slug"]], "folder_id": fid})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.doc(d["slug"]))["access_level"], "link")

    async def test_mcp_publish_uses_the_folder_default(self):
        fid = await self.folder("W1", "Agent", default_access="private")
        token = await self.mcp_token("wm")
        status, result = await self.mcp_call(token, "publish_document", {
            "markdown": "# hi", "workspace": self.ws["W1"], "folder": "agent"})
        self.assertEqual(status, 200)
        self.assertFalse(result.get("isError"), result)
        raw = await self.db["documents"].find_one({"folder_id": fid})
        self.assertEqual(raw["access_level"], "private")


# ── 2. Exposure counts ────────────────────────────────────────────────────────


class Exposure(World):
    async def test_counts_only_what_the_caller_can_read(self):
        W = self.ws["W1"]
        fid = await self.folder("W1", "Mixed")
        await self.mkdoc("L", folder_id=fid)
        await self.mkdoc("LP", folder_id=fid)
        await self.mkdoc("W", folder_id=fid)
        await self.mkdoc("P", folder_id=fid)                       # owner's: wm/wa can't read
        await self.mkdoc("P", folder_id=fid, owner="wm", grants=False)
        await self.mkdoc("L")                                      # root
        await self.mkdoc("P")                                      # root, owner's

        def get(tree):
            return next(f for f in tree["folders"] if f["id"] == fid)["exposure"], tree["root_exposure"]

        exp, root = get((await self.body("GET", f"/api/v1/workspaces/{W}/tree", "wm")).json())
        self.assertEqual(exp, {"link": 2, "workspace": 1, "private": 1, "password": 1})
        self.assertEqual(root, {"link": 1, "workspace": 0, "private": 0, "password": 0})
        # The admin's redacted rows are never counted.
        exp, root = get((await self.body("GET", f"/api/v1/workspaces/{W}/tree", "wa")).json())
        self.assertEqual(exp, {"link": 2, "workspace": 1, "private": 0, "password": 1})
        self.assertEqual(root["private"], 0)
        exp, root = get((await self.body("GET", f"/api/v1/workspaces/{W}/tree", "owner")).json())
        self.assertEqual(exp["private"], 1)
        self.assertEqual(root["private"], 1)
        for who, status in (("stranger", 404), ("gv", 404), ("former", 404)):
            self.assertEqual((await self.body("GET", f"/api/v1/workspaces/{W}/tree", who)).status_code, status)


# ── 3. Preview as ─────────────────────────────────────────────────────────────


class Preview(World):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.W = self.ws["W1"]
        self.fid = await self.folder("W1", "Guides")
        self.sub = await self.folder("W1", "Team only", parent=self.fid)
        self.L = await self.mkdoc("L", folder_id=self.fid)
        self.LP = await self.mkdoc("LP", folder_id=self.fid)
        self.Wd = await self.mkdoc("W", folder_id=self.fid)
        self.P_owner = await self.mkdoc("P", folder_id=self.fid, title="Secret plan")   # gv/ge granted
        self.P_wm = await self.mkdoc("P", folder_id=self.fid, owner="wm", grants=False, title="WM draft")
        self.W_sub = await self.mkdoc("W", folder_id=self.sub)

    def url(self, **q) -> str:
        qs = "&".join(f"{k}={v}" for k, v in {"folder": self.fid, **q}.items())
        return f"/api/v1/workspaces/{self.W}/preview?{qs}"

    async def test_who_may_preview(self):
        self.assertEqual((await self.http.get(self.url())).status_code, 401)
        self.assertEqual((await self.http.get(self.url(), headers=self.tenant("wa", "W1"))).status_code, 401)
        for who, status in (("stranger", 404), ("gv", 404), ("former", 404), ("wm2", 404),
                            ("wv", 403), ("wm", 200), ("wa", 200), ("wo", 200), ("owner", 200)):
            self.assertEqual((await self.body("GET", self.url(), who)).status_code, status, who)
        # as=email: admins and the owner only — it reveals someone's grants.
        for who, status in (("wm", 403), ("owner", 403), ("wa", 200), ("wo", 200)):
            r = await self.body("GET", self.url(**{"as": "email", "email": "gv@example.com"}), who)
            self.assertEqual(r.status_code, status, who)
        r = await self.body("GET", self.url(**{"as": "email"}), "wa")
        self.assertEqual(r.status_code, 422)
        r = await self.body("GET", self.url(folder="nope"), "wm")
        self.assertEqual(r.status_code, 404)
        r = await self.body("GET", f"/api/v1/workspaces/{self.ws['W2']}/preview?folder={self.fid}", "wm2")
        self.assertEqual(r.status_code, 404)  # a folder of another workspace

    async def test_as_anyone_for_a_member(self):
        r = await self.body("GET", self.url(**{"as": "anyone"}), "wm")
        body = r.json()
        self.assertEqual(body["as"], "anyone")
        self.assertEqual(body["folder"], {"id": self.fid, "name": "Guides", "path": "guides"})
        self.assertEqual([i["slug"] for i in body["visible"]["items"]], [self.L["slug"]])
        hidden = {h["slug"]: h for h in body["hidden"] if h["kind"] != "folder"}
        self.assertEqual(set(hidden), {self.LP["slug"], self.Wd["slug"], self.P_wm["slug"]})
        self.assertEqual(hidden[self.LP["slug"]]["reason"], "password")
        self.assertEqual(hidden[self.Wd["slug"]]["reason"], "team")
        self.assertEqual(hidden[self.P_wm["slug"]]["reason"], "people")
        self.assertTrue(hidden[self.P_wm["slug"]]["yours"])
        self.assertTrue(hidden[self.P_wm["slug"]]["can_open_up"])      # wm owns it; link would open it
        self.assertFalse(hidden[self.Wd["slug"]]["can_open_up"])       # not wm's
        self.assertFalse(hidden[self.LP["slug"]]["can_open_up"])
        folders = [h for h in body["hidden"] if h["kind"] == "folder"]
        self.assertEqual([(f["title"], f["reason"], f["folder_id"]) for f in folders],
                         [("Team only", "folder_empty", self.sub)])
        self.assertEqual(body["counts"], {"visible": 1, "total": 4, "folders_visible": 0, "folders_total": 1})
        # The owner's private doc never appears: wm can't read it.
        self.assertNotIn(self.P_owner["slug"], r.text)
        self.assertNotIn("Secret plan", r.text)

    async def test_as_member(self):
        body = (await self.body("GET", self.url(**{"as": "member"}), "wm")).json()
        self.assertEqual({i["slug"] for i in body["visible"]["items"]},
                         {self.L["slug"], self.LP["slug"], self.Wd["slug"]})
        self.assertEqual([f["id"] for f in body["visible"]["folders"]], [self.sub])
        hidden = [h for h in body["hidden"]]
        self.assertEqual([(h["slug"], h["reason"]) for h in hidden], [(self.P_wm["slug"], "people")])
        self.assertTrue(hidden[0]["can_open_up"])  # a member viewer reads link docs

    async def test_admin_redacted_rows_stay_redacted(self):
        r = await self.body("GET", self.url(**{"as": "anyone"}), "wa")
        body = r.json()
        self.assertNotIn(self.P_owner["slug"], r.text)
        self.assertNotIn("Secret plan", r.text)
        self.assertNotIn(self.P_wm["slug"], r.text)
        redacted = [h for h in body["hidden"] if h["slug"] is None and h["kind"] != "folder"]
        self.assertEqual(len(redacted), 2)
        self.assertTrue(all(h["title"] is None and h["reason"] == "people" and not h["can_open_up"]
                            for h in redacted))
        self.assertEqual(body["counts"]["total"], 5)
        # A person who CAN open the private doc: still redacted for the admin.
        r = await self.body("GET", self.url(**{"as": "email", "email": "gv@example.com"}), "wa")
        self.assertNotIn(self.P_owner["slug"], r.text)
        self.assertNotIn("Secret plan", r.text)
        vis = r.json()["visible"]["items"]
        self.assertIn({"slug": None, "title": None, "kind": "markdown", "mime": None, "redacted": True}, vis)

    async def test_as_email_without_an_account_uses_only_that_address_grants(self):
        await self.db["document_grants"].insert_one({
            "document_id": str(self.Wd["_id"]), "email": "newbie@example.com", "role": "viewer",
            "created_at": now(), "granted_by_user_id": self.uid["owner"], "granted_via": None})
        body = (await self.body("GET", self.url(**{"as": "email", "email": "NewBie@Example.com"}), "wa")).json()
        self.assertEqual({i["slug"] for i in body["visible"]["items"]}, {self.L["slug"], self.Wd["slug"]})
        self.assertEqual(await self.db["users"].count_documents({"email": "newbie@example.com"}), 0)

    async def test_as_email_of_a_member_and_of_a_removed_member(self):
        body = (await self.body("GET", self.url(**{"as": "email", "email": "wv@example.com"}), "wo")).json()
        self.assertEqual({i["slug"] for i in body["visible"]["items"]},
                         {self.L["slug"], self.LP["slug"], self.Wd["slug"]})
        body = (await self.body("GET", self.url(**{"as": "email", "email": "former@example.com"}), "wo")).json()
        self.assertEqual({i["slug"] for i in body["visible"]["items"]}, {self.L["slug"]})

    async def test_signin_reason_and_root(self):
        fid = await self.folder("WR", "Docs")
        rl = await self.mkdoc("RL", folder_id=fid)
        body = (await self.body("GET", f"/api/v1/workspaces/{self.ws['WR']}/preview?folder={fid}&as=anyone",
                                "wm")).json()
        self.assertEqual([(h["slug"], h["reason"]) for h in body["hidden"]], [(rl["slug"], "signin")])
        root_doc = await self.mkdoc("L")
        body = (await self.body("GET", f"/api/v1/workspaces/{self.W}/preview?folder=root&as=anyone", "wm")).json()
        self.assertEqual(body["folder"], {"id": None, "name": "Acme", "path": ""})
        self.assertEqual([i["slug"] for i in body["visible"]["items"]], [root_doc["slug"]])
        self.assertEqual([f["id"] for f in body["visible"]["folders"]], [self.fid])

    async def test_preview_changes_nothing(self):
        before = await self.db["documents"].find({}, {"access_level": 1, "access_epoch": 1}).to_list(None)
        await self.body("GET", self.url(**{"as": "anyone"}), "owner")
        after = await self.db["documents"].find({}, {"access_level": 1, "access_epoch": 1}).to_list(None)
        self.assertEqual(before, after)


# ── 4. Request access ─────────────────────────────────────────────────────────


class RequestAccess(World):
    def path(self, slug: str) -> str:
        return f"/api/v1/documents/{slug}/access-requests"

    async def test_flow_request_approve_read(self):
        d = await self.mkdoc("P", ws=None, title="Q4 roadmap")
        r = await self.body("POST", self.path(d["slug"]), "stranger", json={"message": "For Thursday"})
        self.assertEqual(r.status_code, 201, r.text)
        rid = r.json()["id"]
        self.assertEqual(r.json(), {"id": rid, "status": "pending"})
        self.assertEqual(len(self.mail), 1)
        mail = self.mail[0]
        self.assertEqual(mail["to"], ["owner@example.com"])
        for action in ("view", "edit", "decline"):
            self.assertIn(f"https://markdrop.in/requests/{rid}?action={action}", mail["html"])
        self.assertIn("For Thursday", mail["html"])
        self.assertIn("stranger@example.com", mail["html"])

        # The gate state.
        mine = (await self.body("GET", self.path(d["slug"]) + "/mine", "stranger")).json()
        self.assertEqual((mine["can_request_access"], mine["request_pending"], mine["request"]["id"]),
                         (True, True, rid))
        # Twice ⇒ 409.
        r = await self.body("POST", self.path(d["slug"]), "stranger", json={})
        self.assertEqual(r.status_code, 409)

        # The owner's list and the single request.
        lst = (await self.body("GET", "/api/v1/me/access-requests", "owner")).json()
        self.assertEqual(lst["pending_count"], 1)
        req = lst["requests"][0]
        self.assertEqual((req["id"], req["requester"]["email"], req["document"]["slug"],
                          req["document"]["title"], req["message"]),
                         (rid, "stranger@example.com", d["slug"], "Q4 roadmap", "For Thursday"))
        one = await self.body("GET", f"/api/v1/access-requests/{rid}", "owner")
        self.assertEqual(one.json()["id"], rid)

        # Approve: an owner-made grant, the requester reads, and is told.
        self.mail.clear()
        r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner", json={"decision": "view"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["role_granted"]), ("approved", "viewer"))
        g = await self.db["document_grants"].find_one({"document_id": str(d["_id"]), "email": "stranger@example.com"})
        self.assertEqual((g["role"], g["granted_by_user_id"], g.get("granted_via"), g.get("parent_grant_id")),
                         ("viewer", self.uid["owner"], None, None))
        self.assertEqual((await self.get(d["slug"], self.session("stranger"))).status_code, 200)
        self.assertEqual([m["to"] for m in self.mail], [["stranger@example.com"]])

        # Double approve: idempotent, nothing new.
        self.mail.clear()
        r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner", json={"decision": "view"})
        self.assertEqual((r.status_code, r.json()["status"]), (200, "approved"))
        self.assertEqual(self.mail, [])
        self.assertEqual(await self.db["document_grants"].count_documents(
            {"document_id": str(d["_id"]), "email": "stranger@example.com"}), 1)
        # A different second decision ⇒ 409, grant untouched.
        for decision in ("decline", "edit"):
            r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner",
                                json={"decision": decision})
            self.assertEqual(r.status_code, 409, decision)
        self.assertEqual((await self.db["document_grants"].find_one({"_id": g["_id"]}))["role"], "viewer")
        # Now readable: mine says no request button, and a new request is 409.
        mine = (await self.body("GET", self.path(d["slug"]) + "/mine", "stranger")).json()
        self.assertFalse(mine["can_request_access"])
        self.assertEqual((await self.body("POST", self.path(d["slug"]), "stranger", json={})).status_code, 409)
        self.assertEqual((await self.body("GET", "/api/v1/me/access-requests", "owner")).json()["pending_count"], 0)

    async def test_decline_notifies_and_allows_asking_again(self):
        d = await self.mkdoc("W", title="Team doc")
        rid = (await self.body("POST", self.path(d["slug"]), "stranger", json={})).json()["id"]
        self.assertIn("not in Acme", self.mail[0]["html"])
        self.mail.clear()
        r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner",
                            json={"decision": "decline"})
        self.assertEqual((r.status_code, r.json()["status"], r.json()["role_granted"]), (200, "declined", None))
        self.assertIsNone(await self.db["document_grants"].find_one({"email": "stranger@example.com"}))
        self.assertEqual([m["to"] for m in self.mail], [["stranger@example.com"]])
        self.assertEqual((await self.get(d["slug"], self.session("stranger"))).status_code, 404)
        r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner",
                            json={"decision": "decline"})
        self.assertEqual(r.status_code, 200)  # idempotent
        mine = (await self.body("GET", self.path(d["slug"]) + "/mine", "stranger")).json()
        self.assertEqual((mine["can_request_access"], mine["request_pending"], mine["request"]["status"]),
                         (True, False, "declined"))
        r = await self.body("POST", self.path(d["slug"]), "stranger", json={})
        self.assertEqual(r.status_code, 201)

    async def test_edit_grants_editor(self):
        d = await self.mkdoc("P", ws=None)
        rid = (await self.body("POST", self.path(d["slug"]), "stranger", json={})).json()["id"]
        r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner", json={"decision": "edit"})
        self.assertEqual(r.json()["role_granted"], "editor")
        doc = (await self.get(d["slug"], self.session("stranger"))).json()
        self.assertTrue(doc["can"]["edit"])

    async def test_no_existence_oracle_beyond_the_anonymous_gate(self):
        p = await self.mkdoc("P", ws=None)
        x = await self.mkdoc("P", ws=None, expires_at=now() - timedelta(seconds=5))
        h = self.session("stranger")
        missing = await self.http.post(self.path("no-such-doc"), headers=h, json={})
        expired = await self.http.post(self.path(x["slug"]), headers=h, json={})
        read_missing = await self.get("no-such-doc", h)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual((missing.status_code, missing.content), (expired.status_code, expired.content))
        self.assertEqual(missing.content, read_missing.content)   # same 404 as the read route
        mine_missing = await self.http.get(self.path("no-such-doc") + "/mine", headers=h)
        mine_expired = await self.http.get(self.path(x["slug"]) + "/mine", headers=h)
        self.assertEqual((mine_missing.status_code, mine_missing.content),
                         (mine_expired.status_code, mine_expired.content))
        self.assertEqual(mine_missing.status_code, 404)
        # Eligible only where an anonymous read already says the sign-in gate.
        anon = await self.get(p["slug"])
        self.assertEqual((anon.status_code, anon.headers.get("X-Markdrop-Gate")), (401, "signin"))
        self.assertEqual((await self.http.post(self.path(p["slug"]), headers=h, json={})).status_code, 201)
        # The read route itself still answers a signed-in stranger exactly like a missing doc (I5).
        self.assertEqual((await self.get(p["slug"], h)).content, read_missing.content)
        self.assertEqual(await self.db["access_requests"].count_documents({}), 1)

    async def test_who_can_request(self):
        L = await self.mkdoc("L", ws=None)
        LP = await self.mkdoc("LP", ws=None)
        P = await self.mkdoc("P", ws=None)
        W = await self.mkdoc("W")
        RL = await self.mkdoc("RL")
        cases = [
            (L, "stranger", 409), (LP, "stranger", 403), (P, "gv", 409), (P, "owner", 409),
            (W, "wv", 409), (W, "wm", 409), (W, "former", 201), (RL, "stranger", 201),
            (P, "wa", 201),  # an admin isn't the owner of an unfiled doc
        ]
        for doc, who, status in cases:
            r = await self.body("POST", self.path(doc["slug"]), who, json={})
            self.assertEqual(r.status_code, status, (who, doc["access_level"], r.text))
        self.assertEqual((await self.http.post(self.path(P["slug"]), json={})).status_code, 401)
        r = await self.http.post(self.path(W["slug"]), json={}, headers=self.tenant("stranger", "W1"))
        self.assertEqual(r.status_code, 401)
        r = await self.body("POST", self.path(P["slug"]), "stranger", json={"message": "x" * 501})
        self.assertEqual(r.status_code, 422)

    async def test_owner_less_doc_is_never_requestable(self):
        d = await self.mkdoc("L", ws=None, owner=None, read_password_hash=None)
        r = await self.body("POST", self.path(d["slug"]), "stranger", json={})
        self.assertEqual(r.status_code, 409)  # readable link doc

    async def test_rate_limit_per_user(self):
        docs = [await self.mkdoc("P", ws=None, grants=False) for _ in range(11)]
        for d in docs[:10]:
            r = await self.body("POST", self.path(d["slug"]), "stranger", json={})
            self.assertEqual(r.status_code, 201)
        r = await self.body("POST", self.path(docs[10]["slug"]), "stranger", json={})
        self.assertEqual(r.status_code, 429)

    async def test_only_the_owner_decides(self):
        d = await self.mkdoc("W", title="Team doc")
        rid = (await self.body("POST", self.path(d["slug"]), "stranger", json={})).json()["id"]
        for who in ("stranger", "wa", "wo", "wm", "ge", "gv", "former"):
            r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", who, json={"decision": "edit"})
            self.assertEqual(r.status_code, 404, who)
            self.assertEqual((await self.body("GET", f"/api/v1/access-requests/{rid}", who)).status_code, 404)
            lst = (await self.body("GET", "/api/v1/me/access-requests?status=all", who)).json()
            self.assertEqual(lst["requests"], [], who)
        self.assertEqual((await self.http.post(f"/api/v1/access-requests/{rid}/decision",
                                               json={"decision": "view"})).status_code, 401)
        r = await self.http.post(f"/api/v1/access-requests/{rid}/decision", json={"decision": "view"},
                                 headers=self.tenant("owner", "W1"))
        self.assertEqual(r.status_code, 401)
        r = await self.body("POST", f"/api/v1/access-requests/{ObjectId()}/decision", "owner",
                            json={"decision": "view"})
        self.assertEqual(r.status_code, 404)
        r = await self.body("POST", f"/api/v1/access-requests/not-an-id/decision", "owner",
                            json={"decision": "view"})
        self.assertEqual(r.status_code, 404)
        self.assertIsNone(await self.db["document_grants"].find_one({"email": "stranger@example.com"}))
        self.assertEqual((await self.db["access_requests"].find_one({}))["status"], "pending")
        # The owner, even after leaving the workspace, still decides (D4).
        await self.remove_member("W1", "owner")
        r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner", json={"decision": "view"})
        self.assertEqual(r.status_code, 200)

    async def test_deleted_or_expired_doc_hides_the_request(self):
        d = await self.mkdoc("P", ws=None)
        rid = (await self.body("POST", self.path(d["slug"]), "stranger", json={})).json()["id"]
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"expires_at": now() - timedelta(seconds=1)}})
        self.assertEqual((await self.body("GET", "/api/v1/me/access-requests", "owner")).json(),
                         {"requests": [], "pending_count": 0})
        r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner", json={"decision": "view"})
        self.assertEqual(r.status_code, 404)

    async def test_approve_never_lowers_existing_access(self):
        d = await self.mkdoc("P", ws=None)
        rid = (await self.body("POST", self.path(d["slug"]), "stranger", json={})).json()["id"]
        r = await self.body("POST", f"/api/v1/documents/{d['slug']}/access/people", "owner",
                            json={"email": "stranger@example.com", "role": "editor", "notify": False})
        self.assertEqual(r.status_code, 201, r.text)
        r = await self.body("POST", f"/api/v1/access-requests/{rid}/decision", "owner", json={"decision": "view"})
        self.assertEqual(r.status_code, 200)
        g = await self.db["document_grants"].find_one({"document_id": str(d["_id"]), "email": "stranger@example.com"})
        self.assertEqual(g["role"], "editor")

    async def test_html_in_message_and_title_is_escaped(self):
        d = await self.mkdoc("P", ws=None, title='<a href="http://evil">x</a>')
        await self.db["users"].update_one({"_id": ObjectId(self.uid["stranger"])},
                                          {"$set": {"name": "<script>alert(1)</script>"}})
        await self.body("POST", self.path(d["slug"]), "stranger", json={"message": "<img src=x onerror=y>"})
        html = self.mail[0]["html"]
        self.assertNotIn('<a href="http://evil">', html)
        self.assertNotIn("<script>", html)
        self.assertNotIn("<img src=x", html)


# ── 5. Shared with me ─────────────────────────────────────────────────────────


class SharedWithMe(World):
    async def test_lists_effective_grants_newest_first(self):
        fid = await self.folder("W1", "Inner")
        a = await self.mkdoc("P", ws=None, title="A")
        b = await self.mkdoc("W", folder_id=fid, folder_path=["inner"], title="B")
        r = await self.body("GET", "/api/v1/me/shared", "gv")
        self.assertEqual(r.status_code, 200, r.text)
        items = r.json()["items"]
        self.assertEqual([i["slug"] for i in items], [b["slug"], a["slug"]])
        row = items[0]
        self.assertEqual((row["role"], row["access"], row["owner"]["name"], row["url"]),
                         ("viewer", "workspace", "OWNER", f"https://docs.acme.test/inner/{b['slug']}"))
        self.assertIsNone(row["folder"])          # gv isn't a member: no folder names
        self.assertEqual(row["workspace"], {"id": self.ws["W1"], "name": "Acme"})
        self.assertNotIn("id", row)               # never the internal id of someone else's doc
        self.assertTrue(row["new"])
        self.assertEqual(r.json()["new_count"], 2)
        # Opening one clears its "new".
        self.assertEqual((await self.get(a["slug"], self.session("gv"))).status_code, 200)
        r = (await self.body("GET", "/api/v1/me/shared", "gv")).json()
        self.assertEqual(r["new_count"], 1)
        self.assertEqual({i["slug"]: i["new"] for i in r["items"]}, {a["slug"]: False, b["slug"]: True})
        # A member grantee does see the folder name.
        await self.add_member("W1", "gv", "viewer")
        r = (await self.body("GET", "/api/v1/me/shared", "gv")).json()
        self.assertEqual(r["items"][0]["folder"]["name"], "Inner")

    async def test_revoked_expired_dead_chain_and_own_never_show(self):
        keep = await self.mkdoc("P", ws=None, title="Keep")
        revoked = await self.mkdoc("P", ws=None)
        expired = await self.mkdoc("P", ws=None)
        await self.db["document_grants"].delete_one({"document_id": str(revoked["_id"]), "email": "gv@example.com"})
        await self.db["documents"].update_one({"_id": expired["_id"]}, {"$set": {"expires_at": now() - timedelta(seconds=1)}})
        # A member's delegated grant on a public link doc: dies with the membership.
        ln = await self.mkdoc("L", grants=False)
        await self.make_user("x@example.com", "X")
        await self.db["document_grants"].insert_one({
            "document_id": str(ln["_id"]), "email": "x@example.com", "role": "viewer", "created_at": now(),
            "granted_by_user_id": self.uid["wm"], "granted_via": self.ws["W1"]})
        await self.db["document_grants"].insert_one({
            "document_id": str(keep["_id"]), "email": "x@example.com", "role": "viewer", "created_at": now(),
            "granted_by_user_id": self.uid["owner"], "granted_via": None})
        from app.utils.auth import create_access_token

        uid_x = str((await self.db["users"].find_one({"email": "x@example.com"}))["_id"])
        x = {"Authorization": f"Bearer {create_access_token(uid_x, 'x@example.com')[0]}"}
        slugs = [i["slug"] for i in (await self.http.get("/api/v1/me/shared", headers=x)).json()["items"]]
        self.assertEqual(set(slugs), {ln["slug"], keep["slug"]})
        await self.remove_member("W1", "wm")
        slugs = [i["slug"] for i in (await self.http.get("/api/v1/me/shared", headers=x)).json()["items"]]
        self.assertEqual(slugs, [keep["slug"]])   # readable (link) but the grant is dead ⇒ not "shared"
        gv = [i["slug"] for i in (await self.body("GET", "/api/v1/me/shared", "gv")).json()["items"]]
        self.assertEqual(gv, [keep["slug"]])
        self.assertEqual((await self.body("GET", "/api/v1/me/shared", "owner")).json()["items"], [])

    async def test_paging(self):
        docs = []
        for i in range(5):
            d = await self.mkdoc("P", ws=None, grants=False)
            await self.db["document_grants"].insert_one({
                "document_id": str(d["_id"]), "email": "gv@example.com", "role": "viewer",
                "created_at": now() + timedelta(seconds=i), "granted_by_user_id": self.uid["owner"]})
            docs.append(d["slug"])
        seen, cursor = [], None
        while True:
            q = "/api/v1/me/shared?limit=2" + (f"&cursor={cursor}" if cursor else "")
            body = (await self.body("GET", q, "gv")).json()
            seen += [i["slug"] for i in body["items"]]
            cursor = body["next_cursor"]
            if not cursor:
                break
        self.assertEqual(seen, list(reversed(docs)))
        self.assertEqual((await self.body("GET", "/api/v1/me/shared?cursor=garbage", "gv")).status_code, 422)

    async def test_auth(self):
        self.assertEqual((await self.http.get("/api/v1/me/shared")).status_code, 401)
        self.assertEqual((await self.http.get("/api/v1/me/shared", headers=self.tenant("gv", "W1"))).status_code, 401)
        self.assertEqual((await self.body("GET", "/api/v1/me/shared", "stranger")).json(),
                         {"items": [], "next_cursor": None, "new_count": 0})


# ── 6. Recent ─────────────────────────────────────────────────────────────────


class Recent(World):
    async def recent(self, who: str) -> list[str]:
        r = await self.body("GET", "/api/v1/me/recent", who)
        self.assertEqual(r.status_code, 200, r.text)
        return [i["slug"] for i in r.json()["items"]]

    async def test_records_reads_and_rechecks(self):
        w = await self.mkdoc("W")
        p = await self.mkdoc("P", ws=None)
        lp = await self.mkdoc("LP", ws=None)
        await self.get(w["slug"], self.session("wm"))
        await self.get(p["slug"], self.session("gv"))
        await self.get(lp["slug"], {**self.session("stranger"), "X-Read-Password": "pw-correct"})
        await self.get(p["slug"], self.session("stranger"))   # denied: not recorded
        await self.get(w["slug"])                              # anonymous: not recorded
        self.assertEqual(await self.recent("wm"), [w["slug"]])
        self.assertEqual(await self.recent("gv"), [p["slug"]])
        # Password docs are asked again each time: not listed without it.
        self.assertEqual(await self.recent("stranger"), [])
        self.assertEqual(await self.db["recent_views"].count_documents({"user_id": self.uid["stranger"]}), 1)
        # Revoked access disappears at once.
        await self.remove_member("W1", "wm")
        self.assertEqual(await self.recent("wm"), [])
        await self.db["document_grants"].delete_many({"document_id": str(p["_id"]), "email": "gv@example.com"})
        self.assertEqual(await self.recent("gv"), [])
        # Restored access brings it back (the row was kept); expiry removes it.
        await self.add_member("W1", "wm", "member")
        self.assertEqual(await self.recent("wm"), [w["slug"]])
        await self.db["documents"].update_one({"_id": w["_id"]}, {"$set": {"expires_at": now() - timedelta(seconds=1)}})
        self.assertEqual(await self.recent("wm"), [])

    async def test_newest_first_capped(self):
        for i in range(personal.RECENT_KEEP + 5):
            await personal.record_view(self.db, self.uid["wm"], ObjectId())
        self.assertEqual(await self.db["recent_views"].count_documents({"user_id": self.uid["wm"]}),
                         personal.RECENT_KEEP)
        a = await self.mkdoc("L")
        b = await self.mkdoc("L")
        await self.get(a["slug"], self.session("wm"))
        await self.get(b["slug"], self.session("wm"))
        await self.get(a["slug"], self.session("wm"))
        self.assertEqual(await self.recent("wm"), [a["slug"], b["slug"]])
        ttl = [i for i in await self.db["recent_views"].list_indexes().to_list(None) if i.get("expireAfterSeconds")]
        self.assertEqual(ttl[0]["expireAfterSeconds"], 90 * 24 * 3600)

    async def test_auth(self):
        self.assertEqual((await self.http.get("/api/v1/me/recent")).status_code, 401)
        self.assertEqual((await self.http.get("/api/v1/me/recent", headers=self.tenant("wm", "W1"))).status_code, 401)


# ── 7. Quick search ───────────────────────────────────────────────────────────


class QuickSearch(World):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.private_owner = await self.mkdoc("P", title="Roadmap private")            # W1, owner's
        self.team = await self.mkdoc("W", title="Roadmap team")                        # W1
        self.own = await self.mkdoc("P", ws=None, owner="wm", grants=False, title="Roadmap own")
        self.shared = await self.mkdoc("P", ws=None, grants=False, title="Roadmap shared")
        await self.db["document_grants"].insert_one({
            "document_id": str(self.shared["_id"]), "email": "wm@example.com", "role": "viewer",
            "created_at": now(), "granted_by_user_id": self.uid["owner"]})
        self.other = await self.mkdoc("P", ws=None, grants=False, title="Roadmap other")
        self.ws2 = await self.mkdoc("W", ws="W2", owner="wm2", grants=False, title="Roadmap ws2")
        self.enc = await self.mkdoc("W", title="Roadmap enc", encrypted=True)
        self.content_only = await self.mkdoc("W", title="Plain", content="roadmap in the body")
        self.fid = await self.folder("W1", "Roadmaps")

    async def search(self, who, q="roadmap", **kw):
        headers = self.session(who) if isinstance(who, str) else who
        r = await self.http.get("/api/v1/search/quick", params={"q": q, **kw}, headers=headers)
        self.assertEqual(r.status_code, 200, r.text)
        return r

    async def test_member_sees_only_what_they_can_read(self):
        r = await self.search("wm", limit=20)
        body = r.json()
        self.assertEqual({f["slug"] for f in body["files"]},
                         {self.team["slug"], self.own["slug"], self.shared["slug"]})
        for leaked in (self.private_owner, self.other, self.ws2, self.enc, self.content_only):
            self.assertNotIn(leaked["slug"], r.text)
        self.assertNotIn("Roadmap private", r.text)
        self.assertEqual([(f["id"], f["workspace"]["name"]) for f in body["folders"]], [(self.fid, "Acme")])
        self.assertTrue(all(not f.get("redacted") for f in body["files"]))

    async def test_admin_gets_no_redacted_rows(self):
        r = await self.search("wa", limit=20)
        self.assertEqual({f["slug"] for f in r.json()["files"]}, {self.team["slug"]})
        self.assertNotIn(self.private_owner["slug"], r.text)

    async def test_matrix(self):
        expect = {
            "owner": {self.private_owner["slug"], self.team["slug"], self.shared["slug"], self.other["slug"]},
            "stranger": set(),
            "gv": {self.private_owner["slug"], self.team["slug"]},     # grants from the fixture
            "wv": {self.team["slug"]},
            "wo": {self.team["slug"]},
            "wm2": {self.ws2["slug"]},
        }
        for who, slugs in expect.items():
            r = await self.search(who, limit=20)
            self.assertEqual({f["slug"] for f in r.json()["files"]}, slugs, who)
        # A removed member loses the workspace at once.
        await self.remove_member("W1", "wv")
        r = await self.search("wv", limit=20)
        self.assertEqual(r.json(), {"files": [], "folders": [], "workspaces": []})
        # A grantee outside the workspace sees no folder names.
        self.assertEqual((await self.search("gv")).json()["folders"], [])

    async def test_short_query_regex_and_workspaces(self):
        self.assertEqual((await self.search("wm", q="r")).json(), {"files": [], "folders": [], "workspaces": []})
        self.assertEqual((await self.search("wm", q="(draft[")).json()["files"], [])
        ws = (await self.search("wm", q="acm")).json()["workspaces"]
        self.assertEqual({w["name"] for w in ws}, {"Acme", "Acme Private"})
        self.assertEqual((await self.search("wm", q="Roadmap", limit=2)).json()["files"].__len__(), 2)

    async def test_auth(self):
        self.assertEqual((await self.http.get("/api/v1/search/quick?q=roadmap")).status_code, 401)
        r = await self.http.get("/api/v1/search/quick?q=roadmap", headers=self.tenant("wm", "W1"))
        self.assertEqual(r.status_code, 401)


# ── Reserved routes ───────────────────────────────────────────────────────────


class Reserved(World):
    async def test_new_app_routes_are_reserved_for_documents_not_folders(self):
        for word in ("shared", "recent", "requests"):
            self.assertIn(word, RESERVED_SLUGS)
            self.assertIn(word, traffic.APP_ROUTES)
            r = await self.body("POST", "/api/v1/documents", "wm", json={"content": "# x", "custom_slug": word})
            self.assertEqual(r.status_code, 409, word)
        r = await self.body("POST", f"/api/v1/workspaces/{self.ws['W1']}/folders", "wm", json={"name": "Shared"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["slug"], "shared")


class Privacy(World):
    async def test_privacy_is_a_name_for_two_settings(self):
        W = self.ws["W1"]
        url = f"/api/v1/workspaces/{W}"
        cases = [({"require_auth_to_view": False, "default_access": "link"}, "open"),
                 ({"require_auth_to_view": False, "default_access": "workspace"}, "team"),
                 ({"require_auth_to_view": True, "default_access": "workspace"}, "locked"),
                 ({"require_auth_to_view": True, "default_access": "private"}, "custom"),
                 ({"require_auth_to_view": False, "default_access": "private"}, "custom")]
        for settings, privacy in cases:
            r = await self.body("PUT", url, "wa", json={"settings": settings})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["privacy"], privacy, settings)
            self.assertEqual((await self.body("GET", url, "wv")).json()["privacy"], privacy)
