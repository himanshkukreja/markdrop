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
