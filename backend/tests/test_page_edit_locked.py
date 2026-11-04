"""``can.edit_locked``: who may still edit (and lock / unlock) a page locked by its ``locked``
property: its owner and its workspace's admins, as services/pages.may_edit_locked decides.

The page editor reads it so an admin on a locked page gets the editor, as the Lock menu promises
("Only you and workspace admins can edit") and as the server already allows.
"""

from __future__ import annotations

from tests._access_env import AccessWorld


class EditLockedFlag(AccessWorld):
    async def test_owner_and_admins_yes_members_and_grantees_no(self):
        d = await self.mkdoc("W", editor="blocks")
        expect = {"owner": True, "wa": True, "wo": True, "wm": False, "ge": False, "gv": False}
        for who, want in expect.items():
            r = await self.http.get(f"/api/v1/documents/{d['slug']}/access", headers=self.session(who))
            self.assertEqual(r.status_code, 200, (who, r.text))
            self.assertEqual(r.json()["can"].get("edit_locked"), want, who)
