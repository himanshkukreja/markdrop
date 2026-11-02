"""Markdrop Guides' studio on its own host, guides.markdrop.in.

The setting that names it (guides_studio_url → studio_url / studio_link), the studio host's CORS,
the links the API builds into the studio (emails, the GitHub App callback), the hand-off's
POST /api/v1/auth/studio-token (a full session only: never from a custom domain's tenant token, an
API token or an MCP token) and first-party analytics from the studio host.
"""

from __future__ import annotations

from tests import _access_env as aenv  # noqa: F401  (pins settings first)

import unittest
from unittest import mock

import jwt

from app.config import Settings, get_settings
from app.routers import docs_github, docs_page_access
from app.services import traffic
from app.utils.auth import decode_access_token

settings = get_settings()
STUDIO = "https://guides.markdrop.in"
SITE = "6650f2c4a1b2c3d4e5f60718"


class StudioSettingTests(unittest.TestCase):
    def make(self, **kw) -> Settings:
        return Settings(_env_file=None, **kw)

    def test_default_is_the_studio_host(self):
        s = self.make(frontend_url="https://markdrop.in", cors_origins=["https://markdrop.in"])
        self.assertEqual(s.studio_url, STUDIO)
        self.assertEqual(s.studio_link("/"), f"{STUDIO}/")
        self.assertEqual(s.studio_link("/new?ws=w1"), f"{STUDIO}/new?ws=w1")
        self.assertEqual(s.studio_link(f"/{SITE}/settings/private#requests"), f"{STUDIO}/{SITE}/settings/private#requests")

    def test_local_frontend_keeps_the_studio_under_guides(self):
        s = self.make(frontend_url="http://localhost:3400")
        self.assertEqual(s.studio_url, "http://localhost:3400/guides")
        self.assertEqual(s.studio_link("/"), "http://localhost:3400/guides/home")
        self.assertEqual(s.studio_link("/?ws=w1"), "http://localhost:3400/guides/home?ws=w1")
        self.assertEqual(s.studio_link("/github/installed"), "http://localhost:3400/guides/github/installed")

    def test_explicit_setting_wins(self):
        s = self.make(frontend_url="http://localhost:3000", guides_studio_url="http://guides.localhost:3000/")
        self.assertEqual(s.studio_url, "http://guides.localhost:3000")
        self.assertEqual(s.studio_link("/new"), "http://guides.localhost:3000/new")
        self.assertIn("http://guides.localhost:3000", s.cors_origins)

    def test_the_studio_origin_is_always_allowed(self):
        s = self.make(frontend_url="https://markdrop.in", cors_origins=["https://markdrop.in", "https://www.markdrop.in"])
        self.assertEqual(s.cors_origins, ["https://markdrop.in", "https://www.markdrop.in", STUDIO])
        # Already listed: not twice.
        s = self.make(frontend_url="https://markdrop.in", cors_origins=[STUDIO, "https://markdrop.in"])
        self.assertEqual(s.cors_origins.count(STUDIO), 1)
        # The running app's settings (tests pin frontend_url to production's).
        self.assertIn(STUDIO, settings.cors_origins)

    def test_unknown_setting_names_are_still_refused(self):
        with self.assertRaises(Exception):
            self.make(guides_studio_urls="x")


class StudioLinkTests(unittest.IsolatedAsyncioTestCase):
    def test_github_app_comes_back_to_the_studio_host(self):
        self.assertEqual(docs_github._callback_url(), f"{STUDIO}/github/installed")

    async def test_access_request_email_links_the_studio(self):
        sent = {}

        async def fake_send(**kw):
            sent.update(kw)

        async def members(_db, _site):
            return [{"email": "admin@acme.test", "effective_role": "admin"}]

        with mock.patch.object(docs_page_access.pa, "send_request_email", fake_send), \
                mock.patch("app.services.docs_studio_roles.site_members", members):
            await docs_page_access._notify_admins(None, {"_id": SITE, "name": "Acme"}, "r@x.test", {"id": "r1"}, "")
        self.assertEqual(sent["url"], f"{STUDIO}/{SITE}/settings/private#requests")

    def test_studio_host_beats_are_the_apps(self):
        # The studio host reports its pages as app routes; they're counted like markdrop.in's.
        self.assertEqual(traffic.clean_path(f"/guides/{SITE}/design", "guides.markdrop.in"), "/guides/[site]/design")
        self.assertEqual(traffic.clean_path("/guides/home", "guides.markdrop.in"), "/guides/home")
        self.assertEqual(traffic.clean_path("/guides", "markdrop.in"), "/guides")
        # A customer's domain is still a workspace document.
        self.assertEqual(traffic.clean_path("/guides/x", "docs.acme.test"), "/[workspace-doc]")


class StudioTokenTests(aenv.AccessWorld):
    async def mint(self, headers: dict | None = None):
        return await self.http.post("/api/v1/auth/studio-token", headers=headers or {})

    async def test_full_session_gets_a_fresh_full_session(self):
        r = await self.mint(self.session("wm"))
        self.assertEqual(r.status_code, 200, r.text)
        payload = decode_access_token(r.json()["token"])
        self.assertEqual(payload["typ"], "access")
        self.assertEqual(payload["sub"], self.uid["wm"])
        # It is a working session.
        me = await self.http.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {r.json()['token']}", "Origin": STUDIO})
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(me.json()["email"], self.email["wm"])
        self.assertEqual(me.headers.get("access-control-allow-origin"), STUDIO)

    async def test_signed_out_is_401(self):
        self.assertEqual((await self.mint()).status_code, 401)

    async def test_never_from_a_custom_domains_tenant_token(self):
        r = await self.mint(self.tenant("wm", "W1"))
        self.assertIn(r.status_code, (401, 403), r.text)
        self.assertNotIn("token", r.text)

    async def test_never_from_an_api_token(self):
        r = await self.mint(await self.api_token("wm"))
        self.assertEqual(r.status_code, 403, r.text)

    async def test_never_from_an_mcp_token(self):
        token = await self.mcp_token("wm")
        r = await self.mint({"Authorization": f"Bearer {token}"})
        self.assertIn(r.status_code, (401, 403), r.text)

    async def test_never_from_another_kind_of_signed_token(self):
        other = jwt.encode({"sub": self.uid["wm"], "typ": "oauth_state"}, settings.auth_secret, algorithm="HS256")
        r = await self.mint({"Authorization": f"Bearer {other}"})
        self.assertEqual(r.status_code, 403, r.text)

    async def test_studio_host_preflight_is_credentialed_cors(self):
        r = await self.http.options("/api/v1/auth/studio-token", headers={
            "Origin": STUDIO, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["access-control-allow-origin"], STUDIO)
        self.assertEqual(r.headers.get("access-control-allow-credentials"), "true")
        # A published guide (another origin under guides.markdrop.in) is not the studio.
        r = await self.http.options("/api/v1/auth/studio-token", headers={
            "Origin": "https://acme.guides.markdrop.in", "Access-Control-Request-Method": "POST"})
        self.assertNotEqual(r.headers.get("access-control-allow-origin"), "https://acme.guides.markdrop.in")


if __name__ == "__main__":
    unittest.main()
