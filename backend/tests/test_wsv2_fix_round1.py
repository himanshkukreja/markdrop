"""Regression tests for the Workspaces v2 adversarial fix round 1
(specs/wsv2-fix-round1.md). One class per finding id; each test failed on
feat/workspaces-v2 @ a333ff1 and passes with its fix."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest import mock

from bson import ObjectId

from tests._access_env import HOSTS, AccessWorld

from app.services import lifecycle, publicity


def now():
    return datetime.now(timezone.utc)


# ── HIGH ──────────────────────────────────────────────────────────────────────


class C1WorkspaceDeleteNeverWidens(AccessWorld):
    """Deleting a sign-in workspace while R2 fails must not leave its link
    documents filed in a deleted workspace (readable by anyone, then published
    by the reconciler)."""

    async def _delete(self, key: str, name: str):
        return await self.http.request("DELETE", f"/api/v1/workspaces/{self.ws[key]}",
                                       json={"confirm_name": name}, headers=self.session("wo"))

    async def test_c1_r2_failure_during_delete_keeps_docs_private(self):
        a = await self.mkdoc("RL", kind="artifact")
        m = await self.mkdoc("RL")
        self.r2.fail_set_public = True
        r = await self._delete("WR", "Acme Private")
        self.assertEqual(r.status_code, 200, r.text)
        self.r2.fail_set_public = False
        for d in (a, m):
            row = await self.doc(d["slug"])
            self.assertIsNone(row.get("workspace_id"))
            self.assertEqual(row["access_level"], "private")
            self.assertEqual((await self.get(d["slug"])).status_code, 401)
            self.assertEqual((await self.get(d["slug"], self.session("stranger"))).status_code, 404)
        self.assertTrue((await self.doc(a["slug"])).get("access_dirty"))
        await lifecycle.reconcile_once(self.db, full=True)
        row = await self.doc(a["slug"])
        self.assertEqual(row["access_level"], "private")
        self.assertFalse(self.r2.objects[a["blob_key"]]["public"])
        self.assertEqual((await self.get(a["slug"])).status_code, 401)

    async def test_c1_workspace_row_kept_while_a_doc_is_still_filed(self):
        d = await self.mkdoc("RL")

        async def stuck(db, raw, workspace_id, *, require_auth):
            return None  # the release never lands

        with mock.patch.object(lifecycle, "release_db_first", stuck):
            r = await self._delete("WR", "Acme Private")
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIsNotNone(await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["WR"])}))
        self.assertEqual((await self.doc(d["slug"]))["workspace_id"], self.ws["WR"])

    async def test_c1_dangling_link_doc_reads_private_and_is_released_private(self):
        d = await self.mkdoc("RL", kind="artifact")
        await self.db["workspaces"].delete_one({"_id": ObjectId(self.ws["WR"])})
        self.assertEqual((await self.get(d["slug"])).status_code, 401)
        self.assertEqual((await self.get(d["slug"], self.session("stranger"))).status_code, 404)
        self.assertEqual((await self.get(d["slug"], self.session("owner"))).status_code, 200)
        self.assertTrue(await publicity.workspace_requires_auth(self.db, self.ws["WR"]))
        await lifecycle.reconcile_once(self.db, full=True)
        row = await self.doc(d["slug"])
        self.assertIsNone(row.get("workspace_id"))
        self.assertEqual(row["access_level"], "private")
        self.assertFalse(self.r2.objects[d["blob_key"]]["public"])

    async def test_c1_migration_releases_dangling_link_docs_as_private(self):
        d = await self.mkdoc("L")
        await self.db["workspaces"].delete_one({"_id": ObjectId(self.ws["W1"])})
        await lifecycle.migrate(self.db)
        row = await self.doc(d["slug"])
        self.assertIsNone(row.get("workspace_id"))
        self.assertEqual(row["access_level"], "private")
        self.assertTrue(row.get("access_dirty"))


# ── MEDIUM ────────────────────────────────────────────────────────────────────


class _Grants(AccessWorld):
    async def grant(self, who: str, slug: str, email: str, role: str):
        return await self.http.post(f"/api/v1/documents/{slug}/access/people",
                                    json={"email": email, "role": role}, headers=self.session(who))

    async def person(self, name: str) -> None:
        self.email[name] = f"{name}@example.com"
        self.uid[name] = await self.make_user(self.email[name], name.upper())

    async def roles(self, d: dict) -> dict:
        rows = await self.db["document_grants"].find({"document_id": str(d["_id"])}).to_list(100)
        return {g["email"]: g["role"] for g in rows}


class C2NoGrantLaundering(_Grants):
    async def test_c2_regrant_dies_with_the_member(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("y")
        self.assertEqual((await self.grant("wm", d["slug"], "x@example.com", "editor")).status_code, 201)
        r = await self.grant("x", d["slug"], "y@example.com", "editor")
        self.assertEqual(r.status_code, 201, r.text)
        y = await self.db["document_grants"].find_one({"email": "y@example.com"})
        self.assertEqual(y["granted_via"], self.ws["W1"])
        self.assertIsNotNone(y.get("parent_grant_id"))
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                   headers=self.session("wo"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.roles(d), {})
        self.assertEqual((await self.get(d["slug"], self.session("y"))).status_code, 404)

    async def test_c2_regrant_shrinks_with_demotion(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.person("x")
        await self.person("y")
        await self.grant("wm", d["slug"], "x@example.com", "editor")
        await self.grant("x", d["slug"], "y@example.com", "editor")
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                                json={"role": "viewer"}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 204)
        self.assertEqual(await self.roles(d), {"x@example.com": "viewer", "y@example.com": "viewer"})

    async def test_c2_owner_rooted_regrant_survives(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        await self.person("y")
        await self.db["document_grants"].insert_one({
            "document_id": str(d["_id"]), "email": self.email["wm"], "role": "viewer",
            "created_at": now(), "granted_via": None, "granted_by_user_id": self.uid["owner"]})
        self.assertEqual((await self.grant("wm", d["slug"], "y@example.com", "viewer")).status_code, 201)
        await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/members/{self.uid['wm']}",
                               headers=self.session("wo"))
        self.assertEqual((await self.roles(d)).get("y@example.com"), "viewer")


class C7GrantRacingRemoval(_Grants):
    async def test_c7_grant_written_during_removal_is_dropped(self):
        from app.services import access

        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        orig = access.facts
        fired = {"done": False}

        async def facts_then_removed(actor, doc, ctx):
            out = await orig(actor, doc, ctx)
            if not fired["done"] and actor.user_id == self.uid["wm"]:
                fired["done"] = True  # the removal lands between the check and the write
                await self.remove_member("W1", "wm")
                await lifecycle.member_left(self.db, self.ws["W1"], self.uid["wm"])
            return out

        with mock.patch.object(access, "facts", facts_then_removed):
            r = await self.grant("wm", d["slug"], "z@example.com", "editor")
        self.assertNotEqual(r.status_code, 201, r.text)
        self.assertIsNone(await self.db["document_grants"].find_one({"email": "z@example.com"}))

    async def test_c7_reconciler_drops_grants_whose_granter_left(self):
        d = await self.mkdoc("W", grants=False)
        await self.db["document_grants"].insert_one({
            "document_id": str(d["_id"]), "email": "z@example.com", "role": "editor",
            "created_at": now(), "granted_via": self.ws["W1"], "granted_by_user_id": self.uid["former"]})
        await lifecycle.reconcile_once(self.db)
        self.assertIsNone(await self.db["document_grants"].find_one({"email": "z@example.com"}))


class C3PartialSettingsMerge(AccessWorld):
    async def _put(self, key: str, body: dict, who: str = "wa"):
        return await self.http.put(f"/api/v1/workspaces/{self.ws[key]}", json=body, headers=self.session(who))

    async def test_c3_partial_settings_keep_require_auth(self):
        a = await self.mkdoc("RL", kind="artifact")
        r = await self._put("WR", {"settings": {"viewer_chrome": "full"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["settings"]["require_auth_to_view"])
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["WR"])})
        self.assertTrue(ws["settings"]["require_auth_to_view"])
        self.assertFalse(self.r2.objects[a["blob_key"]]["public"])
        self.assertEqual((await self.get(a["slug"])).status_code, 401)

    async def test_c3_partial_branding_keeps_other_fields(self):
        await self.db["workspaces"].update_one(
            {"_id": ObjectId(self.ws["W1"])},
            {"$set": {"branding": {"site_name": "Acme", "hide_markdrop_branding": True,
                                   "logo_url": "https://cdn.acme.test/l.png"}}})
        r = await self._put("W1", {"branding": {"accent_color": "#123456"}})
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()["branding"]
        self.assertTrue(b["hide_markdrop_branding"])
        self.assertEqual(b["site_name"], "Acme")
        self.assertEqual(b["accent_color"], "#123456")
        r = await self._put("W1", {"branding": {"logo_url": None}})
        self.assertIsNone(r.json()["branding"]["logo_url"])
        self.assertEqual(r.json()["branding"]["site_name"], "Acme")

    async def test_c3_null_settings_object_on_a_legacy_row(self):
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["W1"])}, {"$set": {"settings": None}})
        r = await self._put("W1", {"settings": {"members_can_share_folders": False}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["settings"]["members_can_share_folders"])


class C4McpWorkspaceByName(AccessWorld):
    async def call(self, who: str, tool: str, args: dict) -> dict:
        status, res = await self.mcp_call(await self.mcp_token(who), tool, args)
        self.assertEqual(status, 200)
        return res

    async def test_c4_same_name_workspace_is_refused_not_guessed(self):
        await self.db["workspaces"].update_one(
            {"_id": ObjectId(self.ws["W2"])},
            {"$set": {"name": "Acme", "created_at": now() - timedelta(days=30)}})
        await self.add_member("W2", "wm", "member")
        res = await self.call("wm", "publish_document", {"markdown": "# victim secret", "workspace": "Acme"})
        self.assertTrue(res.get("isError"), res)
        text = res["content"][0]["text"]
        self.assertIn("More than one", text)
        self.assertIn(self.ws["W1"], text)
        self.assertIn(self.ws["W2"], text)
        self.assertEqual(await self.db["documents"].count_documents({"workspace_id": self.ws["W2"]}), 0)
        # By id or by live domain it is unambiguous.
        for ref in (self.ws["W1"], HOSTS["W1"], f"https://{HOSTS['W1']}/"):
            res = await self.call("wm", "publish_document", {"markdown": "# ok", "workspace": ref})
            self.assertFalse(res.get("isError"), res)
            slug = res["structuredContent"]["slug"]
            self.assertEqual((await self.doc(slug))["workspace_id"], self.ws["W1"])

    async def test_c4_unique_name_still_resolves(self):
        res = await self.call("wm", "list_folders", {"workspace": "acme"})
        self.assertFalse(res.get("isError"), res)
        self.assertEqual(res["structuredContent"]["workspace_id"], self.ws["W1"])


class B1FolderPagesTenantTokens(AccessWorld):
    async def _setup(self):
        from app.services import folder as folder_service

        self.f = await folder_service.create_folder(self.db, self.ws["W1"], "Secret Plans", None)
        self.d = await self.mkdoc("W", folder_id=self.f.id, folder_path=[self.f.slug])
        share = await folder_service.set_share(self.db, self.ws["W1"], self.f.id, "workspace", self.uid["wo"])
        self.share_id = share["id"]

    async def _host_folder(self, headers: dict):
        return await self.http.get("/api/v1/host/folder", params={"host": HOSTS["W1"], "path": self.f.slug},
                                   headers=headers)

    async def test_b1_tenant_token_needs_origin_on_folder_pages(self):
        await self._setup()
        good = self.tenant("wm", "W1")
        self.assertEqual((await self._host_folder(good)).status_code, 200)
        no_origin = {"Authorization": good["Authorization"]}
        self.assertEqual((await self._host_folder(no_origin)).status_code, 401)
        evil = {**good, "Origin": "https://evil.test"}
        self.assertEqual((await self._host_folder(evil)).status_code, 401)
        r = await self.http.get(f"/api/v1/folders/shared/{self.share_id}", headers=no_origin)
        self.assertEqual(r.status_code, 401)
        r = await self.http.get(f"/api/v1/folders/shared/{self.share_id}", headers=good)
        self.assertEqual(r.status_code, 200, r.text)

    async def test_b1_tenant_token_of_a_dead_host_is_refused(self):
        await self._setup()
        await self.add_domain("W1", "old.acme.test", is_primary=False)
        from app.utils.auth import create_tenant_token

        token, _ = create_tenant_token(self.uid["wm"], self.email["wm"], self.ws["W1"], "old.acme.test")
        h = {"Authorization": f"Bearer {token}", "Origin": "https://old.acme.test"}
        r = await self.http.get(f"/api/v1/folders/shared/{self.share_id}", headers=h)
        self.assertEqual(r.status_code, 200, r.text)
        await self.db["domains"].delete_one({"host": "old.acme.test"})
        r = await self.http.get(f"/api/v1/folders/shared/{self.share_id}", headers=h)
        self.assertEqual(r.status_code, 401)
        r = await self.http.get("/api/v1/host/folder", params={"host": HOSTS["W1"], "path": self.f.slug},
                                headers=h)
        self.assertEqual(r.status_code, 401)


class SmallBFolderGates(AccessWorld):
    async def test_signin_body_has_no_workspace_id_or_internal_name(self):
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["WR"])},
                                               {"$set": {"branding.site_name": "Acme Docs"}})
        r = await self.http.get("/api/v1/host/folder", params={"host": HOSTS["WR"], "path": ""})
        self.assertEqual(r.status_code, 401)
        body = r.text
        self.assertNotIn(self.ws["WR"], body)
        self.assertNotIn("Acme Private", body)
        self.assertEqual(r.json()["workspace"]["branding"]["site_name"], "Acme Docs")

    async def test_gated_workspace_link_share_hides_its_name_from_strangers(self):
        from app.services import folder as folder_service

        f = await folder_service.create_folder(self.db, self.ws["WR"], "Codename", None)
        await self.mkdoc("RW", folder_id=f.id, folder_path=[f.slug], grants=False)
        share = await folder_service.set_share(self.db, self.ws["WR"], f.id, "link", self.uid["wo"])
        r = await self.http.get(f"/api/v1/folders/shared/{share['id']}", headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("Codename", r.text)
        r = await self.http.get("/api/v1/host/folder", params={"host": HOSTS["WR"], "path": f.slug},
                                headers=self.session("stranger"))
        self.assertEqual(r.status_code, 404)
        self.assertNotIn("Codename", r.text)
        # A member still sees it.
        r = await self.http.get(f"/api/v1/folders/shared/{share['id']}", headers=self.session("wv"))
        self.assertEqual(r.status_code, 200, r.text)


class B6TrailRedaction(AccessWorld):
    async def test_b6_unreadable_ancestor_not_named_in_trail(self):
        from app.services import folder as folder_service

        parent = await folder_service.create_folder(self.db, self.ws["W1"], "Codename Falcon", None)
        child = await folder_service.create_folder(self.db, self.ws["W1"], "Public Drop", parent.id)
        await self.mkdoc("W", folder_id=parent.id, folder_path=[parent.slug])
        await folder_service.set_share(self.db, self.ws["W1"], child.id, "link", self.uid["wo"])
        r = await self.http.get("/api/v1/host/folder",
                                params={"host": HOSTS["W1"], "path": f"{parent.slug}/{child.slug}"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("Codename Falcon", [t["name"] for t in r.json()["trail"]])
        # A member who can read the parent's document still gets the full trail.
        r = await self.http.get("/api/v1/host/folder",
                                params={"host": HOSTS["W1"], "path": f"{parent.slug}/{child.slug}"},
                                headers=self.session("wm"))
        self.assertIn("Codename Falcon", [t["name"] for t in r.json()["trail"]])


class B5DocAndFolderAddresses(AccessWorld):
    async def folder(self, name: str, parent=None, ws: str = "W1"):
        from app.services import folder as folder_service

        return await folder_service.create_folder(self.db, self.ws[ws], name, parent)

    async def test_b5_member_doc_cannot_take_a_folders_address(self):
        f = await self.folder("Members Area")
        d = await self.mkdoc("UL", owner="wm", slug="members-area")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/add",
                                 json={"slugs": [d["slug"]], "folder_id": None}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIsNone((await self.doc(d["slug"])).get("workspace_id"))
        # Filed elsewhere, then moved next to the folder: refused too.
        other = await self.folder("Other")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/add",
                                 json={"slugs": [d["slug"]], "folder_id": other.id}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/items/move",
                                 json={"slugs": [d["slug"]], "folder_id": None}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual((await self.doc(d["slug"]))["folder_id"], other.id)
        self.assertEqual(f.slug, "members-area")

    async def test_b5_folder_cannot_take_a_documents_address(self):
        await self.mkdoc("W", slug="handbook")
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/folders",
                                 json={"name": "Handbook"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409, r.text)
        g = await self.folder("Guides")
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{g.id}",
                                json={"name": "Handbook"}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 409, r.text)
        inner = await self.folder("Handbook", g.id)  # fine: another parent
        r = await self.http.put(f"/api/v1/workspaces/{self.ws['W1']}/folders/{inner.id}",
                                json={"parent_id": None, "reparent": True}, headers=self.session("wa"))
        self.assertEqual(r.status_code, 409, r.text)

    async def test_b5_rename_and_upload_onto_a_folder_address_refused(self):
        await self.folder("Plans")
        d = await self.mkdoc("W", owner="wm")
        r = await self.http.patch(f"/api/v1/documents/{d['slug']}/slug", json={"new_slug": "plans"},
                                  headers=self.session("wm"))
        self.assertEqual(r.status_code, 409, r.text)
        r = await self.http.post("/api/v1/files/uploads", json={
            "file_name": "p.html", "size_bytes": 10, "sha256": "a" * 64, "workspace": self.ws["W1"],
            "slug": "plans"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 409, r.text)

    async def test_b5_deleting_a_folder_cannot_move_a_doc_onto_a_folder(self):
        top = await self.folder("Top")
        await self.folder("Reports")
        await self.mkdoc("W", slug="reports", folder_id=top.id, folder_path=[top.slug])
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/folders/{top.id}",
                                   headers=self.session("wa"))
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIsNotNone(await self.db["folders"].find_one({"_id": ObjectId(top.id)}))

    async def test_b5_existing_collision_folder_wins_on_the_domain(self):
        await self.folder("Members Area")
        d = await self.mkdoc("L", owner="wm", slug="members-area")  # filed at root, predates the rule
        scoped = {"X-Markdrop-Workspace": self.ws["W1"]}
        self.assertEqual((await self.get(d["slug"], scoped)).status_code, 404)
        self.assertEqual((await self.get(d["slug"], self.tenant("wv", "W1"))).status_code, 404)
        self.assertEqual((await self.get(d["slug"])).status_code, 200)  # markdrop.in/<slug> unchanged
        out = await lifecycle.migrate(self.db)
        self.assertEqual(out["slug_collisions"], 1)
        # An admin's own document keeps its address.
        await self.db["documents"].update_one({"_id": d["_id"]}, {"$set": {"owner_id": self.uid["wa"]}})
        self.assertEqual((await self.get(d["slug"], scoped)).status_code, 200)


class B3ExpiryPurgeIsScheduled(AccessWorld):
    async def test_b3_setting_an_expiry_books_a_purge_at_that_moment(self):
        from app.services import revalidate

        d = await self.mkdoc("L", owner="owner")
        when = now() + timedelta(minutes=5)
        r = await self.http.put(f"/api/v1/documents/{d['slug']}", headers=self.session("owner"), json={
            "content": "x", "expires_in": "custom", "custom_expires_at": when.isoformat()})
        self.assertEqual(r.status_code, 200, r.text)
        job = await self.db["revalidate_jobs"].find_one({"key": f"doc:{d['slug']}", "scheduled": True})
        self.assertIsNotNone(job)
        due = publicity.aware(job["next_at"])
        self.assertGreaterEqual(due, when)
        self.assertLess(due, when + timedelta(seconds=5))
        self.assertIsNotNone(await self.db["revalidate_jobs"].find_one(
            {"key": f"tag:wsl:{self.ws['W1']}", "scheduled": True}))
        # Ordinary purges of the same page don't consume it…
        await revalidate.purge_doc(self.db, await self.doc(d["slug"]))
        self.assertIsNotNone(await self.db["revalidate_jobs"].find_one(
            {"key": f"doc:{d['slug']}", "scheduled": True, "state": "pending"}))
        # …and the worker sends it once it is due.
        sched = {"key": f"doc:{d['slug']}", "scheduled": True}
        with mock.patch.object(revalidate.settings, "page_revalidate_enabled", True):
            await revalidate.run_due(self.db)
            self.assertEqual((await self.db["revalidate_jobs"].find_one(sched))["state"], "pending")
            with mock.patch.object(revalidate, "_now", lambda: when + timedelta(seconds=2)):
                self.posted.clear()
                await revalidate.run_due(self.db)
            self.assertIn({"slug": d["slug"]}, self.posted)
            self.assertEqual((await self.db["revalidate_jobs"].find_one(sched))["state"], "done")

    async def test_b3_new_document_with_expiry_books_its_purge(self):
        r = await self.http.post("/api/v1/documents", headers=self.session("owner"),
                                 json={"content": "# x", "expires_in": "1d"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertIsNotNone(await self.db["revalidate_jobs"].find_one(
            {"key": f"doc:{r.json()['slug']}", "scheduled": True}))

    async def test_b3_sweeper_waits_for_an_imminent_expiry(self):
        from app.services import background

        d = await self.mkdoc("L", ws=None, expires_at=now() + timedelta(seconds=1.2))
        with mock.patch.object(background, "SWEEP_EVERY", 5.0):
            await background._sweep(self.db)
        self.assertIsNone(await self.doc(d["slug"]))


# ── LOW ───────────────────────────────────────────────────────────────────────


class B4ConsentFollowsTheWorkspace(AccessWorld):
    async def _mint(self, who: str, host: str, **body):
        return await self.http.post("/api/v1/auth/tenant-token", json={"host": host, **body},
                                    headers=self.session(who))

    async def test_b4_consent_not_reused_after_reclaim(self):
        host = HOSTS["W1"]
        r = await self._mint("stranger", host, consent=True)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self._mint("stranger", host)).status_code, 200)  # remembered
        # The host changes hands: W1 loses it, W2 verifies it.
        await self.db["domains"].delete_many({"host": host})
        await self.add_domain("W2", host, is_primary=False)
        r = await self._mint("stranger", host)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json()["detail"], "consent_required")

    async def test_b4_remove_domain_forgets_consents(self):
        from app.services import domain as domain_service

        host = HOSTS["W1"]
        self.assertEqual((await self._mint("stranger", host, consent=True)).status_code, 200)
        self.assertEqual(await self.db["tenant_consents"].count_documents({"host": host}), 1)
        row = await self.db["domains"].find_one({"host": host})
        await domain_service.remove_domain(self.db, self.ws["W1"], str(row["_id"]))
        self.assertEqual(await self.db["tenant_consents"].count_documents({"host": host}), 0)


class B8CorsCacheClearedOnDomainChange(AccessWorld):
    async def test_b8_removed_host_loses_cors_at_once(self):
        from app.middleware import tenant_cors
        from app.services import domain as domain_service

        host = HOSTS["W1"]
        origin = f"https://{host}"
        pre = {"Origin": origin, "Access-Control-Request-Method": "GET",
               "Access-Control-Request-Headers": "authorization"}
        tenant_cors.clear_cache()
        r = await self.http.options("/api/v1/documents/x", headers=pre)
        self.assertEqual(r.headers.get("access-control-allow-origin"), origin)
        row = await self.db["domains"].find_one({"host": host})
        await domain_service.remove_domain(self.db, self.ws["W1"], str(row["_id"]))
        r = await self.http.options("/api/v1/documents/x", headers=pre)
        self.assertNotEqual(r.headers.get("access-control-allow-origin"), origin)


class B2NarrowingWaitsForThePurge(AccessWorld):
    async def test_b2_purge_is_sent_after_the_write_and_before_the_answer(self):
        from app.services import revalidate

        d = await self.mkdoc("L", ws=None)
        seen: list[tuple[dict, str]] = []

        async def post(payload):
            row = await self.doc(d["slug"])
            seen.append((payload, row["access_level"]))
            return 200

        with mock.patch.object(revalidate.settings, "page_revalidate_enabled", True), \
                mock.patch.object(revalidate, "_spawn", lambda *a, **k: None), \
                mock.patch.object(revalidate, "_post", post):
            r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level",
                                    json={"level": "private"}, headers=self.session("owner"))
            self.assertIn(r.status_code, (200, 204), r.text)
            sent = [lvl for payload, lvl in seen if payload == {"slug": d["slug"]}]
        self.assertEqual(sent, ["private"])  # delivered before the answer, after the write
        job = await self.db["revalidate_jobs"].find_one({"key": f"doc:{d['slug']}"})
        self.assertEqual(job["state"], "done")

    async def test_b2_widening_stays_in_the_background(self):
        from app.services import revalidate

        d = await self.mkdoc("P", ws=None)
        seen: list[dict] = []

        async def post(payload):
            seen.append(payload)
            return 200

        with mock.patch.object(revalidate.settings, "page_revalidate_enabled", True), \
                mock.patch.object(revalidate, "_spawn", lambda *a, **k: None), \
                mock.patch.object(revalidate, "_post", post):
            r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level",
                                    json={"level": "link"}, headers=self.session("owner"))
            self.assertIn(r.status_code, (200, 204), r.text)
        self.assertEqual(seen, [])


class B7OgForOldSlugs(AccessWorld):
    async def test_b7_gated_old_slug_gets_the_workspace_card_not_the_generic_one(self):
        from app.routers import og as og_router

        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws["WR"])},
                                               {"$set": {"branding.hide_markdrop_branding": True}})
        d = await self.mkdoc("RL", old_slugs=["old-secret"])
        cards = []

        def render(card):
            cards.append(card)
            return b"png"

        with mock.patch.object(og_router.og_render, "render_og_png", render):
            r = await self.http.get("/api/v1/og/old-secret.png", params={"host": HOSTS["WR"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(cards[-1].kind, "private")
        self.assertIsNotNone(cards[-1].brand)
        self.assertTrue(cards[-1].brand.hide_markdrop_branding)
        self.assertNotIn(d["title"], repr(cards[-1]))


class C5McpSetAccessKeepsPassword(AccessWorld):
    async def call(self, who: str, tool: str, args: dict) -> dict:
        return (await self.mcp_call(await self.mcp_token(who), tool, args))[1]

    async def test_c5_private_keeps_the_password_inert(self):
        d = await self.mkdoc("LP", ws=None)
        res = await self.call("owner", "set_access", {"document": d["slug"], "access": "private"})
        self.assertFalse(res.get("isError"), res)
        row = await self.doc(d["slug"])
        self.assertEqual(row["access_level"], "private")
        self.assertTrue(row.get("read_password_hash"))
        r = await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "link"},
                                headers=self.session("owner"))
        self.assertIn(r.status_code, (200, 204))
        r = await self.get(d["slug"])
        self.assertEqual((r.status_code, r.headers.get("x-markdrop-gate")), (401, "password"))

    async def test_c5_link_still_removes_the_password(self):
        d = await self.mkdoc("LP", ws=None)
        res = await self.call("owner", "set_access", {"document": d["slug"], "access": "link"})
        self.assertFalse(res.get("isError"), res)
        self.assertFalse((await self.doc(d["slug"])).get("read_password_hash"))


class C13Leftovers(AccessWorld):
    async def call(self, who: str, tool: str, args: dict) -> dict:
        return (await self.mcp_call(await self.mcp_token(who), tool, args))[1]

    async def test_c13_link_in_a_signin_workspace_is_not_called_public(self):
        d = await self.mkdoc("RW")
        res = await self.call("owner", "set_access", {"document": d["slug"], "access": "link"})
        text = res["content"][0]["text"]
        self.assertNotIn("anyone with the link", text)
        self.assertNotIn("public", text)
        self.assertIn("members of its workspace", text)
        res = await self.call("wm", "publish_document", {"markdown": "# x", "workspace": self.ws["WR"],
                                                          "access": "link"})
        self.assertNotIn("anyone with the link", res["content"][0]["text"])

    async def test_c13_create_upload_takes_a_slug(self):
        from app.mcp import tools as mcp_tools

        tool = next(t for t in mcp_tools.TOOLS if t.name == "create_upload")
        self.assertIn("slug", tool.input_schema["properties"])
        res = await self.call("owner", "create_upload", {
            "file_name": "a.html", "size_bytes": 10, "sha256": "b" * 64, "slug": "my-upload-slug"})
        self.assertFalse(res.get("isError"), res)
        sess = await self.db["file_uploads"].find_one({}, sort=[("_id", -1)])
        self.assertEqual(sess.get("slug"), "my-upload-slug")

    async def test_c13_restored_version_gets_the_current_epoch(self):
        d = await self.mkdoc("P", ws=None, kind="artifact", access_epoch=3, file_version=2)
        old_key = f"art/{self.uid['owner']}/old.html"
        self.r2.put_bytes(old_key, b"<p>old</p>", "text/html", False)
        self.r2.objects[old_key]["ae"] = "1"
        for v, key in ((1, old_key), (2, d["blob_key"])):
            await self.db["file_versions"].insert_one({
                "doc_id": str(d["_id"]), "version": v, "blob_key": key, "user_id": self.uid["owner"],
                "size_bytes": 10, "mime": "text/html", "created_at": now()})
        r = await self.http.post(f"/api/v1/files/{d['slug']}/versions/1/restore", headers=self.session("owner"))
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.doc(d["slug"])
        self.assertEqual(row["blob_key"], old_key)
        self.assertEqual(self.r2.objects[old_key].get("ae"), str(row.get("access_epoch") or 0))
        self.assertFalse(self.r2.objects[old_key]["public"])

    async def test_c13_granter_who_lost_access_cannot_manage_their_grants(self):
        d = await self.mkdoc("W", grants=False, allow_resharing=True)
        r = await self.http.post(f"/api/v1/documents/{d['slug']}/access/people",
                                 json={"email": "x@example.com", "role": "viewer"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 201)
        await self.http.put(f"/api/v1/documents/{d['slug']}/access/level", json={"level": "private"},
                            headers=self.session("owner"))
        self.assertIsNotNone(await self.db["document_grants"].find_one({"email": "x@example.com"}))
        r = await self.http.delete(f"/api/v1/documents/{d['slug']}/access/people/x@example.com",
                                   headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)
        r = await self.http.post(f"/api/v1/documents/{d['slug']}/access/people",
                                 json={"email": "x@example.com", "role": "editor"}, headers=self.session("wm"))
        self.assertEqual(r.status_code, 404)
        self.assertEqual((await self.http.get(f"/api/v1/documents/{d['slug']}/access",
                                              headers=self.session("wm"))).status_code, 404)


class C13SetPublicKeepsMetadata(__import__("unittest").TestCase):
    def test_c13_set_public_keeps_live_and_other_keys(self):
        from app.services import r2

        calls = {}

        class Client:
            def head_object(self, **kw):
                return {"ContentType": "text/html", "Metadata": {"live": "1", "public": "1", "ae": "0"}}

            def copy_object(self, **kw):
                calls.update(kw)

        with mock.patch.object(r2, "_client", lambda: Client()):
            self.assertTrue(r2.set_public("k", False, "text/html", 4))
        self.assertEqual(calls["Metadata"], {"live": "1", "ae": "4"})
        with mock.patch.object(r2, "_client", lambda: Client()):
            self.assertTrue(r2.set_public("k", True, "text/html", None))
        self.assertEqual(calls["Metadata"], {"live": "1", "public": "1", "ae": "0"})
        self.assertEqual(calls["CacheControl"], "no-cache, must-revalidate")


class C6OldSlugRaces(AccessWorld):
    async def test_c6_create_racing_a_rename_cannot_take_the_old_slug(self):
        import asyncio

        from app.services import document as doc_service

        await self.mkdoc("L", ws=None, owner="owner", slug="orig-y")
        orig_free = doc_service._slug_free
        gate = asyncio.Event()

        async def free_then_wait(db, slug, owner_id):
            out = await orig_free(db, slug, owner_id)
            if slug == "orig-y":
                gate.set()
                await asyncio.sleep(0.2)
            return out

        async def rename_after():
            await gate.wait()
            return await self.http.patch("/api/v1/documents/orig-y/slug", json={"new_slug": "renamed-y"},
                                         headers=self.session("owner"))

        with mock.patch.object(doc_service, "_slug_free", free_then_wait):
            a, b = await asyncio.gather(
                self.http.post("/api/v1/documents", json={"content": "phish", "custom_slug": "orig-y"},
                               headers=self.session("stranger")), rename_after())
        self.assertEqual(b.status_code, 200, b.text)
        self.assertEqual(a.status_code, 409, a.text)
        self.assertIsNone(await self.db["documents"].find_one({"slug": "orig-y"}))
        r = await self.get("orig-y", self.session("gv"))
        self.assertEqual(r.headers.get("x-markdrop-moved"), "renamed-y")

    async def test_c6_rename_racing_another_rename_cannot_take_its_old_slug(self):
        import asyncio

        await self.mkdoc("L", ws=None, owner="owner", slug="taken-z")
        mine = await self.mkdoc("L", ws=None, owner="stranger", slug="mine-z")
        orig = lifecycle.slug_unavailable
        gate = asyncio.Event()

        async def check_then_wait(db, slug, owner_id, doc_id=None):
            out = await orig(db, slug, owner_id, doc_id)
            if slug == "taken-z" and not gate.is_set():
                gate.set()
                await asyncio.sleep(0.2)
            return out

        async def vacate():
            await gate.wait()
            return await self.http.patch("/api/v1/documents/taken-z/slug", json={"new_slug": "moved-z"},
                                         headers=self.session("owner"))

        with mock.patch.object(lifecycle, "slug_unavailable", check_then_wait):
            # taken-z is live (unique index) when checked; the owner renames
            # away from it meanwhile, then the stranger's write lands.
            a, b = await asyncio.gather(
                self.http.patch(f"/api/v1/documents/{mine['slug']}/slug", json={"new_slug": "taken-z"},
                                headers=self.session("stranger")), vacate())
        self.assertEqual(b.status_code, 200, b.text)
        self.assertNotEqual(a.status_code, 200, a.text)
        self.assertEqual((await self.doc("mine-z") or {}).get("_id"), mine["_id"])
        self.assertIsNone(await self.db["documents"].find_one({"slug": "taken-z"}))


class C8MoveRacingFolderDelete(AccessWorld):
    async def test_c8_move_racing_delete_leaves_no_dangling_folder(self):
        import asyncio

        from app.services import folder as folder_service

        W = self.ws["W1"]
        c = await folder_service.create_folder(self.db, W, "C", None)
        d = await self.mkdoc("W")
        orig = folder_service.path_of
        gate = asyncio.Event()

        async def slow_path_of(db, ws, fid):
            out = await orig(db, ws, fid)
            if fid == c.id and not gate.is_set():
                gate.set()
                await asyncio.sleep(0.2)
            return out

        async def delete_later():
            await gate.wait()
            return await self.http.delete(f"/api/v1/workspaces/{W}/folders/{c.id}", headers=self.session("wa"))

        with mock.patch.object(folder_service, "path_of", slow_path_of):
            await asyncio.gather(
                self.http.post(f"/api/v1/workspaces/{W}/items/move",
                               json={"slugs": [d["slug"]], "folder_id": c.id}, headers=self.session("wm")),
                delete_later())
        self.assertIsNone(await self.db["folders"].find_one({"_id": ObjectId(c.id)}))
        row = await self.doc(d["slug"])
        self.assertIsNone(row.get("folder_id"))
        self.assertEqual(row.get("folder_path"), [])

    async def test_c8_reconciler_roots_dangling_folder_refs(self):
        d = await self.mkdoc("W", folder_id=str(ObjectId()), folder_path=["gone"])
        await lifecycle.reconcile_once(self.db, full=True)
        row = await self.doc(d["slug"])
        self.assertIsNone(row.get("folder_id"))
        self.assertEqual(row.get("folder_path"), [])
        self.assertEqual(row["workspace_id"], self.ws["W1"])


class C9CreateFolderUnderTheLock(AccessWorld):
    async def test_c9_create_racing_a_move_never_exceeds_max_depth(self):
        import asyncio

        from app.services import folder as folder_service

        W = self.ws["W1"]
        parent, chain = None, []
        for i in range(7):
            f = await folder_service.create_folder(self.db, W, f"f{i}", parent)
            chain.append(f)
            parent = f.id
        x = await folder_service.create_folder(self.db, W, "X", None)
        y = await folder_service.create_folder(self.db, W, "Y", x.id)
        orig = folder_service._depth_of
        gate = asyncio.Event()

        async def slow_depth(db, ws, fid):
            out = await orig(db, ws, fid)
            if fid == y.id and not gate.is_set():
                gate.set()
                await asyncio.sleep(0.2)
            return out

        async def move_later():
            await gate.wait()
            return await self.http.put(f"/api/v1/workspaces/{W}/folders/{x.id}",
                                       json={"parent_id": chain[5].id, "reparent": True},
                                       headers=self.session("wa"))

        with mock.patch.object(folder_service, "_depth_of", slow_depth):
            await asyncio.gather(
                self.http.post(f"/api/v1/workspaces/{W}/folders", json={"name": "Z", "parent_id": y.id},
                               headers=self.session("wm")),
                move_later())
        z = await self.db["folders"].find_one({"name": "Z"})
        if z is not None:
            self.assertLessEqual(await orig(self.db, W, str(z["_id"])), folder_service.MAX_DEPTH)


class C10C11McpScopeAndOracle(AccessWorld):
    async def call(self, who: str, tool: str, args: dict) -> dict:
        return (await self.mcp_call(await self.mcp_token(who), tool, args))[1]

    async def test_c10_remove_from_workspace_honours_the_host_scope(self):
        d = await self.mkdoc("L")  # filed in W1
        res = await self.call("wa", "remove_from_workspace", {"document": f"https://{HOSTS['W2']}/{d['slug']}"})
        self.assertTrue(res.get("isError"), res)
        self.assertEqual((await self.doc(d["slug"]))["workspace_id"], self.ws["W1"])
        res = await self.call("wa", "remove_from_workspace", {"document": f"https://{HOSTS['W1']}/{d['slug']}"})
        self.assertFalse(res.get("isError"), res)

    async def test_c10_create_upload_target_honours_the_host_scope(self):
        a = await self.mkdoc("W", kind="artifact", owner="wm")  # in W1, wm owns it
        res = await self.call("wm", "create_upload", {
            "file_name": "a.html", "size_bytes": 10, "sha256": "c" * 64,
            "target_slug": f"https://{HOSTS['W2']}/{a['slug']}"})
        self.assertTrue(res.get("isError"), res)
        self.assertEqual(await self.db["file_uploads"].count_documents({}), 0)

    async def test_c11_no_existence_oracle(self):
        u = await self.mkdoc("P", ws=None, grants=False)
        missing = (await self.call("stranger", "remove_from_workspace", {"document": "no-such-doc-xyz"}))
        unfiled = (await self.call("stranger", "remove_from_workspace", {"document": u["slug"]}))
        filed = await self.mkdoc("P", grants=False)
        other = (await self.call("stranger", "remove_from_workspace", {"document": filed["slug"]}))
        texts = {r["content"][0]["text"] for r in (missing, unfiled, other)}
        self.assertEqual(len(texts), 1, texts)
        # The owner still gets the precise answer.
        res = await self.call("owner", "remove_from_workspace", {"document": u["slug"]})
        self.assertIn("isn't in a workspace", res["content"][0]["text"])


class C12AdminInvitationsAreTheOwners(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        from app.services import mailer

        async def send(**kw):
            return None

        for p in (mock.patch.object(mailer, "is_configured", lambda: True),
                  mock.patch.object(mailer, "send_invite_email", send)):
            p.start()
            self.addCleanup(p.stop)

    async def invite(self, who: str, email: str, role: str):
        return await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/invitations",
                                    json={"email": email, "role": role}, headers=self.session(who))

    async def test_c12_admin_cannot_replace_or_revoke_an_admin_invitation(self):
        r = await self.invite("wo", "boss@example.com", "admin")
        self.assertEqual(r.status_code, 201, r.text)
        inv_id = r.json()["id"]
        before = await self.db["invitations"].find_one({"email": "boss@example.com", "status": "pending"})
        r = await self.invite("wa", "boss@example.com", "member")
        self.assertEqual(r.status_code, 409, r.text)
        after = await self.db["invitations"].find_one({"email": "boss@example.com", "status": "pending"})
        self.assertEqual((after["role"], after["token_hash"]), ("admin", before["token_hash"]))
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/invitations/{inv_id}",
                                   headers=self.session("wa"))
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual((await self.db["invitations"].find_one({"_id": ObjectId(inv_id)}))["status"], "pending")
        # The owner still can; admins keep managing member invitations.
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/invitations/{inv_id}",
                                   headers=self.session("wo"))
        self.assertEqual(r.status_code, 204, r.text)
        r = await self.invite("wa", "pal@example.com", "member")
        self.assertEqual(r.status_code, 201, r.text)
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws['W1']}/invitations/{r.json()['id']}",
                                   headers=self.session("wa"))
        self.assertEqual(r.status_code, 204, r.text)


class A1PasswordAttemptsShared(__import__("unittest").IsolatedAsyncioTestCase):
    """The wrong-password window is shared by every API worker (Redis)."""

    @classmethod
    def setUpClass(cls):
        import shutil
        import socket
        import subprocess
        import time as _time

        exe = shutil.which("redis-server")
        if not exe:
            raise __import__("unittest").SkipTest("redis-server not installed")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.proc = subprocess.Popen([exe, "--port", str(cls.port), "--save", "", "--appendonly", "no"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.1).close()
                break
            except OSError:
                _time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)

    async def test_a1_two_workers_share_one_window(self):
        from app.config import get_settings
        from app.services import access

        with mock.patch.object(get_settings(), "redis_url", f"redis://127.0.0.1:{self.port}/0"):
            w1, w2 = access._Attempts(), access._Attempts()
            slug = f"s-{__import__('secrets').token_hex(3)}"
            for _ in range(5):
                await w1.fail(slug, "1.2.3.4")
                await w2.fail(slug, "1.2.3.4")
            self.assertTrue(await w1.blocked(slug, "1.2.3.4"))
            self.assertTrue(await w2.blocked(slug, "1.2.3.4"))
            self.assertFalse(await w2.blocked(slug, "5.6.7.8"))

    async def test_a1_falls_back_to_memory_when_redis_is_down(self):
        from app.config import get_settings
        from app.services import access

        with mock.patch.object(get_settings(), "redis_url", "redis://127.0.0.1:9/0"):
            w = access._Attempts()
            for _ in range(10):
                await w.fail("s", "ip")
            self.assertTrue(await w.blocked("s", "ip"))


class TransferToAnyMember(AccessWorld):
    async def test_transfer_to_a_viewer_is_allowed(self):
        r = await self.http.post(f"/api/v1/workspaces/{self.ws['W1']}/transfer",
                                 json={"user_id": self.uid["wv"]}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        ws = await self.db["workspaces"].find_one({"_id": ObjectId(self.ws["W1"])})
        self.assertEqual(ws["owner_id"], self.uid["wv"])
        old = await self.db["memberships"].find_one({"workspace_id": self.ws["W1"], "user_id": self.uid["wo"]})
        self.assertEqual(old["role"], "admin")
