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
