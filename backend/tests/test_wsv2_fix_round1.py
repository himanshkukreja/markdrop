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
