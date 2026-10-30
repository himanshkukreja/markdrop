"""Password and members-only docs sites stay off until the edge enforces access."""
from tests._docs_sites_env import DocsSitesCase, settings


class PrivateSitesGuardTests(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme", source={"kind": "template", "template": "product"})
        self.sid = self.site["id"]
        settings.docs_private_sites_enabled = False

    async def test_settings_refuse_non_public_access(self):
        for level in ("password", "members"):
            await self.call("PATCH", f"/{self.sid}", json={"settings": {"access": {"level": level}}}, expect=422)
        site = await self.get(f"/{self.sid}")
        self.assertEqual(site["settings"]["access"]["level"], "public")

    async def test_publish_and_restore_refuse_a_non_public_site(self):
        b = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        # A site stored as members-only (written before the guard, or by hand) never goes live.
        from bson import ObjectId
        await self.db["docs_sites"].update_one({"_id": ObjectId(self.sid)},
                                               {"$set": {"settings.access.level": "members"}})
        await self.call("POST", f"/{self.sid}/publish", json={}, expect=409)
        await self.call("POST", f"/{self.sid}/builds/{b['id']}/restore", json={}, expect=409)
