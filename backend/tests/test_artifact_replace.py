"""Replacing an artifact's file: the same per-type ceiling and quota as creating one.

R2 is mocked (tests/_mcp_env.py blanks the real keys); MongoDB is a throwaway database.
"""

from __future__ import annotations

from unittest import mock

from tests._mcp_env import McpTestCase, settings

from app.services import r2

MB = 1024 * 1024


class ReplaceFile(McpTestCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.objects: dict[str, dict] = {}
        self.deleted: list[str] = []
        patches = [
            mock.patch.object(r2, "is_configured", lambda: True),
            mock.patch.object(r2, "head", lambda key: self.objects.get(key)),
            mock.patch.object(r2, "delete", lambda key: self.deleted.append(key)),
            mock.patch.object(r2, "set_public", lambda *a, **k: True),
            mock.patch.object(r2, "set_public_prefix", lambda *a, **k: True),
            mock.patch.object(r2, "delete_prefix", lambda *a, **k: True),
            mock.patch.object(settings, "artifact_origin", "https://markdrop-artifacts.example.workers.dev"),
            mock.patch.object(settings, "artifact_signing_key", "k"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.auth = {"Authorization": f"Bearer {self.session}"}

    def upload(self, name: str, mime: str, size: int) -> str:
        key = f"art/{self.user_id}/{name}"
        self.objects[key] = {"size": size, "content_type": mime}
        return key

    async def create(self, slug: str, name: str, mime: str, size: int):
        key = self.upload(name, mime, size)
        r = await self.http.post("/api/v1/artifacts", headers=self.auth,
                                 json={"blob_key": key, "filename": name, "custom_slug": slug})
        self.assertEqual(r.status_code, 201, r.text)

    async def replace(self, slug: str, name: str, mime: str, size: int):
        key = self.upload(name, mime, size)
        r = await self.http.put(f"/api/v1/artifacts/{slug}/file", headers=self.auth,
                                json={"blob_key": key, "filename": name})
        return r, key

    async def test_video_up_to_the_video_limit(self):
        await self.create("demo-video", "v1.mp4", "video/mp4", 40 * MB)
        r, _ = await self.replace("demo-video", "v2.mp4", "video/mp4", 188 * MB)
        self.assertEqual(r.status_code, 200, r.text)
        raw = await self.db["documents"].find_one({"slug": "demo-video"})
        self.assertEqual(raw["size_bytes"], 188 * MB)

    async def test_video_over_the_video_limit(self):
        await self.create("big-video", "v1.mp4", "video/mp4", 40 * MB)
        r, key = await self.replace("big-video", "v2.mp4", "video/mp4", settings.artifact_max_video_bytes + 1)
        self.assertEqual(r.status_code, 413, r.text)
        self.assertIn(f"{settings.artifact_max_video_bytes // MB} MB", r.json()["detail"])
        self.assertIn(key, self.deleted)

    async def test_document_keeps_the_document_limit(self):
        await self.create("a-report", "r1.pdf", "application/pdf", 2 * MB)
        r, key = await self.replace("a-report", "r2.pdf", "application/pdf", settings.artifact_max_bytes + 1)
        self.assertEqual(r.status_code, 413, r.text)
        self.assertIn(key, self.deleted)

    async def test_quota_counts_the_replaced_file_as_freed(self):
        with mock.patch.object(settings, "artifact_user_quota_bytes", 300 * MB):
            await self.create("near-quota", "v1.mp4", "video/mp4", 250 * MB)
            # 250 → 280 MB: net +30 MB fits a 300 MB quota.
            r, _ = await self.replace("near-quota", "v2.mp4", "video/mp4", 280 * MB)
            self.assertEqual(r.status_code, 200, r.text)
            await self.create("other", "o.mp4", "video/mp4", 15 * MB)
            # 280 + 15 used; 280 → 290 MB would be 305 MB.
            r, key = await self.replace("near-quota", "v3.mp4", "video/mp4", 290 * MB)
            self.assertEqual(r.status_code, 507, r.text)
            self.assertIn(key, self.deleted)
