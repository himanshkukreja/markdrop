"""Adversarial round 3 regressions: require sign-in toggled while a workspace is being deleted (R3-1)."""

from __future__ import annotations

from unittest import mock

from bson import ObjectId

from tests._access_env import AccessWorld

from app.services import lifecycle
from app.services import workspace as ws_service


class R3_1RequireAuthDuringDelete(AccessWorld):
    async def test_settings_write_is_refused_while_deleting(self):
        W = self.ws["W1"]
        doc = await self.mkdoc("L", kind="artifact")
        orig = lifecycle.release_workspace_documents
        seen = {}

        async def release(db, wid, require_auth, **kw):
            if not seen:
                r = await self.http.put(f"/api/v1/workspaces/{W}",
                                        json={"settings": {"require_auth_to_view": True}},
                                        headers=self.session("wa"))
                seen["status"] = r.status_code
                row = await db["workspaces"].find_one({"_id": ObjectId(W)})
                seen["stored"] = (row.get("settings") or {}).get("require_auth_to_view")
            return await orig(db, wid, require_auth, **kw)

        with mock.patch.object(lifecycle, "release_workspace_documents", release):
            r = await self.http.request("DELETE", f"/api/v1/workspaces/{W}",
                                        json={"confirm_name": "Acme"}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(seen["status"], 409)          # refused mid-delete
        self.assertFalse(seen["stored"])               # the setting never changed
        row = await self.doc(doc["slug"])
        self.assertIsNone(row.get("workspace_id"))     # released, never widened past what it was

    async def test_release_uses_the_stored_setting_not_a_stale_read(self):
        W = self.ws["W1"]
        doc = await self.mkdoc("L", kind="artifact")
        real_get = ws_service.get_workspace

        async def stale_get(db, wid):
            ws = await real_get(db, wid)
            # The toggle lands after delete_workspace read the workspace, before the doors shut.
            await db["workspaces"].update_one({"_id": ObjectId(W)},
                                              {"$set": {"settings.require_auth_to_view": True}})
            return ws

        with mock.patch.object(ws_service, "get_workspace", stale_get):
            r = await self.http.request("DELETE", f"/api/v1/workspaces/{W}",
                                        json={"confirm_name": "Acme"}, headers=self.session("wo"))
        self.assertEqual(r.status_code, 200, r.text)
        row = await self.doc(doc["slug"])
        self.assertEqual(row["access_level"], "private")   # sign-in workspace link docs leave as private
        self.assertEqual((await self.get(doc["slug"])).status_code, 401)
        self.assertFalse(self.r2.objects[doc["blob_key"]]["public"])
