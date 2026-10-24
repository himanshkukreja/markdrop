"""OAuth 2.1 for the MCP server: discovery, registration, the authorization
request, consent, PKCE, codes, refresh rotation, revocation, connected apps,
Client ID Metadata Documents, audience checks and CORS.
"""

from __future__ import annotations

import base64
import unittest
from datetime import timedelta
from unittest import mock

from tests._mcp_env import API, REDIRECT, RESOURCE, McpTestCase, pkce, query

import httpx

from app.services import api_token, cimd, oauth_server


class Discovery(McpTestCase):
    async def test_protected_resource_metadata_both_paths(self):
        for path in ("/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"):
            r = await self.http.get(path)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json(), {
                "resource": RESOURCE, "authorization_servers": [API],
                "scopes_supported": ["documents:read", "documents:write"],
                "bearer_methods_supported": ["header"], "resource_name": "Markdrop",
                "resource_documentation": "https://markdrop.in/mcp",
            })
            self.assertEqual(r.headers["access-control-allow-origin"], "*")

    async def test_authorization_server_metadata_and_oidc_alias(self):
        a = (await self.http.get("/.well-known/oauth-authorization-server")).json()
        b = (await self.http.get("/.well-known/openid-configuration")).json()
        self.assertEqual(a, b)
        self.assertEqual(a["issuer"], API)
        self.assertEqual(a["authorization_endpoint"], f"{API}/oauth/authorize")
        self.assertEqual(a["token_endpoint"], f"{API}/oauth/token")
        self.assertEqual(a["registration_endpoint"], f"{API}/oauth/register")
        self.assertEqual(a["revocation_endpoint"], f"{API}/oauth/revoke")
        self.assertEqual(a["code_challenge_methods_supported"], ["S256"])
        self.assertEqual(a["grant_types_supported"], ["authorization_code", "refresh_token"])
        self.assertEqual(a["token_endpoint_auth_methods_supported"],
                         ["none", "client_secret_post", "client_secret_basic"])
        self.assertTrue(a["client_id_metadata_document_supported"])
        self.assertTrue(a["authorization_response_iss_parameter_supported"])

    async def test_cors_public_endpoints_without_credentials(self):
        r = await self.http.options("/oauth/token", headers={
            "Origin": "https://inspector.example", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type, authorization"})
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertNotIn("access-control-allow-credentials", r.headers)
        self.assertIn("authorization", r.headers["access-control-allow-headers"])
        # /mcp from a disallowed browser origin is refused at the preflight.
        r = await self.http.options("/mcp", headers={
            "Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        self.assertEqual(r.status_code, 403)
        r = await self.http.options("/mcp", headers={
            "Origin": "https://claude.ai", "Access-Control-Request-Method": "POST"})
        self.assertEqual(r.status_code, 204)
        # An ordinary request from a site that is also a static CORS origin
        # gets * and no credentials on these paths only.
        r = await self.http.get("/.well-known/oauth-authorization-server",
                                headers={"Origin": "http://localhost:3000"})
        self.assertEqual(r.headers["access-control-allow-origin"], "*")
        self.assertNotIn("access-control-allow-credentials", r.headers)
        self.assertIn("WWW-Authenticate", r.headers["access-control-expose-headers"])

    async def test_existing_api_cors_unchanged(self):
        r = await self.http.options("/api/v1/documents", headers={
            "Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
        self.assertEqual(r.headers["access-control-allow-origin"], "http://localhost:3000")
        self.assertEqual(r.headers["access-control-allow-credentials"], "true")


class Registration(McpTestCase):
    async def test_public_client(self):
        out = await self.register(client_uri="https://client.example", logo_uri="https://client.example/l.png")
        self.assertTrue(out["client_id"].startswith("mdc_"))
        self.assertIn("client_id_issued_at", out)
        self.assertNotIn("client_secret", out)
        self.assertEqual(out["token_endpoint_auth_method"], "none")
        stored = await self.db["oauth_clients"].find_one({"_id": out["client_id"]})
        self.assertEqual(stored["redirect_uris"], [REDIRECT])

    async def test_confidential_client_gets_secret(self):
        out = await self.register(token_endpoint_auth_method="client_secret_basic")
        self.assertTrue(out["client_secret"].startswith("mdcs_"))
        self.assertEqual(out["client_secret_expires_at"], 0)
        stored = await self.db["oauth_clients"].find_one({"_id": out["client_id"]})
        self.assertNotIn(out["client_secret"], str(stored))

    async def test_redirect_rules(self):
        for bad in (["http://client.example/cb"], ["javascript:alert(1)"], [], ["https://x.example/cb#frag"],
                    ["data:text/html,hi"]):
            r = await self.http.post("/oauth/register", json={"client_name": "x", "redirect_uris": bad})
            self.assertEqual(r.status_code, 400, bad)
            self.assertEqual(r.json()["error"], "invalid_redirect_uri")
            self.assertEqual(r.headers["cache-control"], "no-store")
        for good in ("http://127.0.0.1:33418/callback", "http://localhost/cb",
                     "cursor://anysphere.cursor-retrieval/oauth/callback"):
            await self.register(redirect_uris=[good])

    async def test_bad_metadata(self):
        r = await self.http.post("/oauth/register", json={"redirect_uris": [REDIRECT],
                                                          "token_endpoint_auth_method": "private_key_jwt"})
        self.assertEqual(r.json()["error"], "invalid_client_metadata")
        r = await self.http.post("/oauth/register", json={"redirect_uris": [REDIRECT], "grant_types": ["implicit"]})
        self.assertEqual(r.json()["error"], "invalid_client_metadata")
        r = await self.http.post("/oauth/register", content=b"not json")
        self.assertEqual(r.status_code, 400)

    async def test_extra_metadata_is_narrowed_not_refused(self):
        out = await self.register(grant_types=["authorization_code", "refresh_token", "client_credentials"],
                                  logo_uri="http://insecure.example/logo.png", scope="openid documents:read")
        self.assertEqual(out["grant_types"], ["authorization_code", "refresh_token"])
        self.assertNotIn("logo_uri", out)
        self.assertNotIn("scope", out)
        out = await self.register(scope="documents:read")
        self.assertEqual(out["scope"], "documents:read")


class Authorize(McpTestCase):
    async def test_happy_path_redirects_to_consent(self):
        client = await self.register()
        _, challenge = pkce()
        r = await self.authorize(client["client_id"], challenge)
        self.assertEqual(r.status_code, 302)
        request_id = query(r.headers["location"])["request"]
        stored = await self.db["oauth_requests"].find_one({"_id": request_id})
        self.assertEqual(stored["scopes"], ["documents:read", "documents:write"])
        self.assertEqual(stored["resource"], RESOURCE)
        self.assertGreaterEqual(len(request_id), 40)

    async def test_unknown_client_and_bad_redirect_render_html(self):
        _, challenge = pkce()
        r = await self.authorize("mdc_nope", challenge)
        self.assertEqual(r.status_code, 400)
        self.assertIn("text/html", r.headers["content-type"])
        client = await self.register()
        r = await self.authorize(client["client_id"], challenge, redirect_uri="https://client.example/other")
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("location", r.headers)

    async def test_loopback_port_is_ignored(self):
        client = await self.register(redirect_uris=["http://127.0.0.1:1234/callback"])
        _, challenge = pkce()
        r = await self.authorize(client["client_id"], challenge, redirect_uri="http://127.0.0.1:5555/callback")
        self.assertEqual(r.status_code, 302)
        r = await self.authorize(client["client_id"], challenge, redirect_uri="http://127.0.0.1:5555/elsewhere")
        self.assertEqual(r.status_code, 400)
        r = await self.authorize(client["client_id"], challenge, redirect_uri="http://localhost:5555/callback")
        self.assertEqual(r.status_code, 400)

    async def test_errors_after_redirect_validation_go_back_to_client(self):
        client = await self.register()
        verifier, challenge = pkce()
        cases = [
            ({"code_challenge_method": "plain"}, "invalid_request"),
            ({"code_challenge": ""}, "invalid_request"),
            ({"response_type": "token"}, "unsupported_response_type"),
            ({"scope": "documents:read admin"}, "invalid_scope"),
            ({"resource": "https://other.example/mcp"}, "invalid_target"),
        ]
        for extra, error in cases:
            r = await self.authorize(client["client_id"], challenge, **extra)
            self.assertEqual(r.status_code, 302, extra)
            loc = r.headers["location"]
            self.assertTrue(loc.startswith(REDIRECT), loc)
            q = query(loc)
            self.assertEqual(q["error"], error, extra)
            self.assertEqual(q["state"], "st-1")
            self.assertEqual(q["iss"], API)

    async def test_resource_comparison_is_tolerant(self):
        client = await self.register()
        _, challenge = pkce()
        for value in ("https://API.markdrop.in/mcp/", "HTTPS://api.markdrop.in/mcp"):
            r = await self.authorize(client["client_id"], challenge, resource=value)
            self.assertTrue(r.headers["location"].startswith("https://markdrop.in/oauth/consent"), value)

    async def test_scope_subset_and_offline_access(self):
        client = await self.register()
        _, challenge = pkce()
        r = await self.authorize(client["client_id"], challenge, scope="documents:read offline_access")
        stored = await self.db["oauth_requests"].find_one({"_id": query(r.headers["location"])["request"]})
        self.assertEqual(stored["scopes"], ["documents:read"])


class Consent(McpTestCase):
    async def _pending(self) -> tuple[dict, str]:
        client = await self.register(client_uri="https://client.example", logo_uri="https://client.example/l.png")
        _, challenge = pkce()
        r = await self.authorize(client["client_id"], challenge)
        return client, query(r.headers["location"])["request"]

    async def test_request_summary(self):
        _, rid = await self._pending()
        r = await self.http.get(f"/api/v1/oauth/requests/{rid}",
                                headers={"Authorization": f"Bearer {self.session}"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["client"], {
            "name": "Test App", "uri": "https://client.example", "logo_uri": "https://client.example/l.png",
            "redirect_host": "client.example", "verified_by": "registration"})
        self.assertEqual([s["name"] for s in body["scopes"]], ["documents:read", "documents:write"])
        self.assertTrue(all(s["title"] and s["description"] for s in body["scopes"]))
        self.assertEqual(body["account"], {"email": "priya@example.com", "name": "Priya"})
        self.assertEqual(body["resource"], RESOURCE)

    async def test_needs_a_site_session(self):
        _, rid = await self._pending()
        r = await self.http.get(f"/api/v1/oauth/requests/{rid}")
        self.assertEqual(r.status_code, 401)
        raw, _ = await api_token.create_token(self.db, self.user_id, "t")
        r = await self.http.get(f"/api/v1/oauth/requests/{rid}", headers={"Authorization": f"Bearer {raw}"})
        self.assertEqual(r.status_code, 401)

    async def test_unknown_and_expired(self):
        r = await self.http.get("/api/v1/oauth/requests/nope", headers={"Authorization": f"Bearer {self.session}"})
        self.assertEqual(r.status_code, 404)
        _, rid = await self._pending()
        await self.db["oauth_requests"].update_one(
            {"_id": rid}, {"$set": {"expires_at": oauth_server._now() - timedelta(seconds=1)}})
        r = await self.http.get(f"/api/v1/oauth/requests/{rid}", headers={"Authorization": f"Bearer {self.session}"})
        self.assertEqual(r.status_code, 404)

    async def test_deny_redirects_with_access_denied_and_deletes_request(self):
        client, rid = await self._pending()
        r = await self.http.post(f"/api/v1/oauth/requests/{rid}/decision", json={"approve": False},
                                 headers={"Authorization": f"Bearer {self.session}"})
        q = query(r.json()["redirect_url"])
        self.assertEqual(q, {"error": "access_denied", "error_description": "The user declined.",
                             "state": "st-1", "iss": API})
        self.assertIsNone(await self.db["oauth_requests"].find_one({"_id": rid}))
        self.assertEqual(await self.db["oauth_grants"].count_documents({}), 0)

    async def test_approve_creates_grant_and_hashed_code(self):
        client, rid = await self._pending()
        r = await self.http.post(f"/api/v1/oauth/requests/{rid}/decision", json={"approve": True},
                                 headers={"Authorization": f"Bearer {self.session}"})
        url = r.json()["redirect_url"]
        self.assertTrue(url.startswith(REDIRECT + "?"))
        self.assertIn("iss=https%3A%2F%2Fapi.markdrop.in", url)
        q = query(url)
        self.assertEqual(q["state"], "st-1")
        self.assertIsNone(await self.db["oauth_codes"].find_one({"_id": q["code"]}))
        self.assertIsNotNone(await self.db["oauth_codes"].find_one({"_id": oauth_server.hash_token(q["code"])}))
        grant = await self.db["oauth_grants"].find_one({"user_id": self.user_id})
        self.assertEqual(grant["client_id"], client["client_id"])
        # Decided once: a second decision finds nothing.
        r = await self.http.post(f"/api/v1/oauth/requests/{rid}/decision", json={"approve": True},
                                 headers={"Authorization": f"Bearer {self.session}"})
        self.assertEqual(r.status_code, 404)


class Tokens(McpTestCase):
    async def _code(self, client: dict, **authorize_extra) -> tuple[str, str]:
        verifier, challenge = pkce()
        url = await self.consent(await self.authorize(client["client_id"], challenge, **authorize_extra))
        return query(url)["code"], verifier

    async def test_exchange_issues_opaque_hashed_tokens(self):
        client = await self.register()
        code, verifier = await self._code(client)
        r = await self.exchange(client["client_id"], code, verifier)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["cache-control"], "no-store")
        body = r.json()
        self.assertEqual(body["token_type"], "Bearer")
        self.assertEqual(body["expires_in"], 3600)
        self.assertEqual(body["scope"], "documents:read documents:write")
        self.assertTrue(body["access_token"].startswith("mdat_"))
        self.assertTrue(body["refresh_token"].startswith("mdrt_"))
        rec = await self.db["oauth_tokens"].find_one({"_id": oauth_server.hash_token(body["access_token"])})
        self.assertEqual((rec["kind"], rec["user_id"], rec["resource"]), ("access", self.user_id, RESOURCE))
        self.assertIsNone(await self.db["oauth_tokens"].find_one({"_id": body["access_token"]}))

    async def test_pkce_mismatch(self):
        client = await self.register()
        code, _ = await self._code(client)
        wrong, _ = pkce()
        r = await self.exchange(client["client_id"], code, wrong)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "invalid_grant")

    async def test_code_reuse_revokes_issued_tokens(self):
        client = await self.register()
        code, verifier = await self._code(client)
        first = (await self.exchange(client["client_id"], code, verifier)).json()
        self.assertEqual((await self.rpc(first["access_token"], "ping")).status_code, 200)
        r = await self.exchange(client["client_id"], code, verifier)
        self.assertEqual(r.json()["error"], "invalid_grant")
        self.assertEqual((await self.rpc(first["access_token"], "ping")).status_code, 401)
        r = await self.http.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": client["client_id"],
                                                       "refresh_token": first["refresh_token"]})
        self.assertEqual(r.json()["error"], "invalid_grant")

    async def test_redirect_resource_and_client_must_match(self):
        client = await self.register(redirect_uris=[REDIRECT, "https://client.example/two"])
        code, verifier = await self._code(client)
        r = await self.exchange(client["client_id"], code, verifier, redirect_uri="https://client.example/two")
        self.assertEqual(r.json()["error"], "invalid_grant")
        code, verifier = await self._code(client)
        r = await self.exchange(client["client_id"], code, verifier, resource="https://other.example/mcp")
        self.assertEqual(r.json()["error"], "invalid_target")
        other = await self.register()
        code, verifier = await self._code(client)
        r = await self.exchange(other["client_id"], code, verifier)
        self.assertEqual(r.json()["error"], "invalid_grant")

    async def test_expired_code(self):
        client = await self.register()
        code, verifier = await self._code(client)
        await self.db["oauth_codes"].update_one({"_id": oauth_server.hash_token(code)},
                                                {"$set": {"expires_at": oauth_server._now() - timedelta(seconds=1)}})
        r = await self.exchange(client["client_id"], code, verifier)
        self.assertEqual(r.json()["error"], "invalid_grant")

    async def test_confidential_client_authentication(self):
        client = await self.register(token_endpoint_auth_method="client_secret_basic")
        code, verifier = await self._code(client)
        form = {"grant_type": "authorization_code", "code": code, "code_verifier": verifier,
                "redirect_uri": REDIRECT}
        bad = base64.b64encode(f"{client['client_id']}:wrong".encode()).decode()
        r = await self.http.post("/oauth/token", data=form, headers={"Authorization": f"Basic {bad}"})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"], "invalid_client")
        self.assertIn("Basic", r.headers["www-authenticate"])
        good = base64.b64encode(f"{client['client_id']}:{client['client_secret']}".encode()).decode()
        r = await self.http.post("/oauth/token", data=form, headers={"Authorization": f"Basic {good}"})
        self.assertEqual(r.status_code, 200, r.text)
        # client_secret_post
        post = await self.register(token_endpoint_auth_method="client_secret_post")
        code, verifier = await self._code(post)
        r = await self.exchange(post["client_id"], code, verifier)
        self.assertEqual(r.status_code, 401)
        code, verifier = await self._code(post)
        r = await self.exchange(post["client_id"], code, verifier, client_secret=post["client_secret"])
        self.assertEqual(r.status_code, 200, r.text)

    async def test_refresh_rotation_and_reuse_detection(self):
        client, first = await self.connect()
        form = {"grant_type": "refresh_token", "client_id": client["client_id"],
                "refresh_token": first["refresh_token"], "resource": RESOURCE}
        r = await self.http.post("/oauth/token", data=form)
        self.assertEqual(r.status_code, 200, r.text)
        second = r.json()
        self.assertNotEqual(second["refresh_token"], first["refresh_token"])
        self.assertEqual((await self.rpc(second["access_token"], "ping")).status_code, 200)
        # Replaying the rotated token revokes the whole family.
        r = await self.http.post("/oauth/token", data=form)
        self.assertEqual(r.json()["error"], "invalid_grant")
        self.assertEqual((await self.rpc(second["access_token"], "ping")).status_code, 401)
        r = await self.http.post("/oauth/token", data={**form, "refresh_token": second["refresh_token"]})
        self.assertEqual(r.json()["error"], "invalid_grant")

    async def test_refresh_can_narrow_but_not_widen(self):
        client, first = await self.connect(scope="documents:read")
        r = await self.http.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": client["client_id"],
                                                       "refresh_token": first["refresh_token"],
                                                       "scope": "documents:write"})
        self.assertEqual(r.json()["error"], "invalid_scope")
        client, first = await self.connect()
        r = await self.http.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": client["client_id"],
                                                       "refresh_token": first["refresh_token"],
                                                       "scope": "documents:read"})
        self.assertEqual(r.json()["scope"], "documents:read")

    async def test_refresh_bound_to_client(self):
        client, first = await self.connect()
        other = await self.register()
        r = await self.http.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": other["client_id"],
                                                       "refresh_token": first["refresh_token"]})
        self.assertEqual(r.json()["error"], "invalid_grant")
        # ...and the real client can still use it.
        r = await self.http.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": client["client_id"],
                                                       "refresh_token": first["refresh_token"]})
        self.assertEqual(r.status_code, 200)

    async def test_unsupported_grant(self):
        client = await self.register()
        r = await self.http.post("/oauth/token", data={"grant_type": "password", "client_id": client["client_id"]})
        self.assertEqual(r.json()["error"], "unsupported_grant_type")


class Revocation(McpTestCase):
    async def test_revoke_access_token(self):
        client, tokens = await self.connect()
        r = await self.http.post("/oauth/revoke", data={"token": tokens["access_token"], "client_id": client["client_id"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((await self.rpc(tokens["access_token"], "ping")).status_code, 401)

    async def test_revoke_refresh_token_revokes_family(self):
        client, tokens = await self.connect()
        await self.http.post("/oauth/revoke", data={"token": tokens["refresh_token"], "client_id": client["client_id"]})
        self.assertEqual((await self.rpc(tokens["access_token"], "ping")).status_code, 401)

    async def test_other_clients_tokens_are_left_alone(self):
        _, tokens = await self.connect()
        other = await self.register()
        r = await self.http.post("/oauth/revoke", data={"token": tokens["access_token"], "client_id": other["client_id"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((await self.rpc(tokens["access_token"], "ping")).status_code, 200)

    async def test_unknown_token_is_fine(self):
        r = await self.http.post("/oauth/revoke", data={"token": "mdat_nothing"})
        self.assertEqual(r.status_code, 200)


class Connections(McpTestCase):
    async def test_list_and_disconnect(self):
        client, tokens = await self.connect()
        await self.rpc(tokens["access_token"], "ping")
        auth = {"Authorization": f"Bearer {self.session}"}
        rows = (await self.http.get("/api/v1/me/connections", headers=auth)).json()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["client_id"], client["client_id"])
        self.assertEqual(row["name"], "Test App")
        self.assertEqual(row["scopes"], ["documents:read", "documents:write"])
        self.assertTrue(row["connected_at"].endswith("Z"))
        self.assertIsNotNone(row["last_used_at"])
        r = await self.http.delete(f"/api/v1/me/connections/{client['client_id']}", headers=auth)
        self.assertEqual(r.status_code, 204)
        self.assertEqual((await self.rpc(tokens["access_token"], "ping")).status_code, 401)
        r = await self.http.post("/oauth/token", data={"grant_type": "refresh_token", "client_id": client["client_id"],
                                                       "refresh_token": tokens["refresh_token"]})
        self.assertEqual(r.json()["error"], "invalid_grant")
        self.assertEqual((await self.http.get("/api/v1/me/connections", headers=auth)).json(), [])
        r = await self.http.delete(f"/api/v1/me/connections/{client['client_id']}", headers=auth)
        self.assertEqual(r.status_code, 404)

    async def test_other_users_see_nothing(self):
        await self.connect()
        other = await self.make_user("sam@example.com")
        from app.utils.auth import create_access_token

        token, _ = create_access_token(other, "sam@example.com")
        rows = (await self.http.get("/api/v1/me/connections", headers={"Authorization": f"Bearer {token}"})).json()
        self.assertEqual(rows, [])


CIMD_URL = "https://app.example/oauth/client.json"


def cimd_doc(**overrides) -> dict:
    return {"client_id": CIMD_URL, "client_name": "Metadata App",
            "redirect_uris": [REDIRECT], "logo_uri": "https://app.example/logo.png", **overrides}


class ClientIdMetadataDocuments(McpTestCase):
    async def test_valid_document_flows_end_to_end(self):
        verifier, challenge = pkce()
        with mock.patch.object(cimd, "_fetch_document", mock.AsyncMock(return_value=cimd_doc())) as fetch:
            r = await self.authorize(CIMD_URL, challenge)
            self.assertEqual(r.status_code, 302, r.text)
            rid = query(r.headers["location"])["request"]
            summary = (await self.http.get(f"/api/v1/oauth/requests/{rid}",
                                           headers={"Authorization": f"Bearer {self.session}"})).json()
            self.assertEqual(summary["client"]["verified_by"], "cimd")
            self.assertEqual(summary["client"]["name"], "Metadata App")
            # Cached: a second authorization doesn't fetch again.
            await self.authorize(CIMD_URL, challenge)
            self.assertEqual(fetch.await_count, 1)
        r = await self.http.post(f"/api/v1/oauth/requests/{rid}/decision", json={"approve": True},
                                 headers={"Authorization": f"Bearer {self.session}"})
        code = query(r.json()["redirect_url"])["code"]
        r = await self.exchange(CIMD_URL, code, verifier)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((await self.rpc(r.json()["access_token"], "ping")).status_code, 200)

    async def test_invalid_documents_are_refused_without_redirect(self):
        _, challenge = pkce()
        bad_docs = [
            cimd_doc(client_id="https://app.example/other.json"),
            cimd_doc(redirect_uris=[]),
            cimd_doc(client_name=""),
            cimd_doc(redirect_uris=["http://app.example/cb"]),
            cimd_doc(token_endpoint_auth_method="client_secret_basic"),
        ]
        for doc in bad_docs:
            cimd.clear_cache()
            with mock.patch.object(cimd, "_fetch_document", mock.AsyncMock(return_value=doc)):
                r = await self.authorize(CIMD_URL, challenge)
            self.assertEqual(r.status_code, 400, doc)
            self.assertIn("text/html", r.headers["content-type"])

    async def test_redirect_not_in_document(self):
        _, challenge = pkce()
        with mock.patch.object(cimd, "_fetch_document", mock.AsyncMock(return_value=cimd_doc())):
            r = await self.authorize(CIMD_URL, challenge, redirect_uri="https://attacker.example/cb")
        self.assertEqual(r.status_code, 400)

    def test_url_shape(self):
        for bad in ("http://app.example/client.json", "https://app.example", "https://app.example/",
                    "https://user:pw@app.example/c.json", "https://app.example/c.json#x", "ftp://app.example/c"):
            with self.assertRaises(cimd.CIMDError, msg=bad):
                cimd.check_url_shape(bad)
        self.assertEqual(cimd.check_url_shape(CIMD_URL), ("https", "app.example", 443))

    async def test_private_addresses_blocked(self):
        for ip in ("127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1",
                   "fd00::1", "0.0.0.0", "::ffff:127.0.0.1"):
            with self.assertRaises(cimd.CIMDError, msg=ip):
                await cimd._resolve(ip, 443)
        self.assertEqual(await cimd._resolve("93.184.216.34", 443), "93.184.216.34")

    async def test_hostname_resolving_privately_is_blocked(self):
        import asyncio
        import socket

        async def fake(host, port, type=None):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", port)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", fake):
            with self.assertRaises(cimd.CIMDError):
                await cimd._resolve("sneaky.example", 443)

    async def _fetch_with(self, handler) -> dict:
        real_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            return real_client(*args, transport=httpx.MockTransport(handler), **kwargs)

        with mock.patch.object(cimd, "_resolve", mock.AsyncMock(return_value="93.184.216.34")), \
                mock.patch.object(cimd.httpx, "AsyncClient", client_factory):
            return await cimd._fetch_document(CIMD_URL)

    async def test_fetch_pins_address_and_reads_document(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["host"] = request.headers["host"]
            seen["sni"] = request.extensions.get("sni_hostname")
            return httpx.Response(200, json=cimd_doc())

        data = await self._fetch_with(handler)
        self.assertEqual(data["client_name"], "Metadata App")
        self.assertEqual(seen["url"], "https://93.184.216.34/oauth/client.json")
        self.assertEqual(seen["host"], "app.example")
        self.assertEqual(seen["sni"], "app.example")

    async def test_fetch_rejects_oversize(self):
        def handler(request):
            return httpx.Response(200, content=b"{" + b" " * (70 * 1024) + b"}")

        with self.assertRaises(cimd.CIMDError) as ctx:
            await self._fetch_with(handler)
        self.assertIn("too large", str(ctx.exception))

    async def test_fetch_refuses_redirect_to_http(self):
        def handler(request):
            return httpx.Response(302, headers={"location": "http://app.example/c.json"})

        with self.assertRaises(cimd.CIMDError) as ctx:
            await self._fetch_with(handler)
        self.assertIn("https", str(ctx.exception))

    async def test_fetch_non_json(self):
        with self.assertRaises(cimd.CIMDError):
            await self._fetch_with(lambda request: httpx.Response(200, content=b"<html>"))


class Audience(McpTestCase):
    async def test_site_session_and_api_tokens_are_refused_on_mcp(self):
        r = await self.rpc(self.session, "ping")
        self.assertEqual(r.status_code, 401)
        self.assertIn('error="invalid_token"', r.headers["www-authenticate"])
        raw, _ = await api_token.create_token(self.db, self.user_id, "t")
        self.assertEqual((await self.rpc(raw, "ping")).status_code, 401)

    async def test_token_for_another_resource_is_refused(self):
        _, tokens = await self.connect()
        await self.db["oauth_tokens"].update_one(
            {"_id": oauth_server.hash_token(tokens["access_token"])},
            {"$set": {"resource": "https://other.example/mcp"}})
        oauth_server.clear_access_cache()
        r = await self.rpc(tokens["access_token"], "ping")
        self.assertEqual(r.status_code, 401)

    async def test_expired_access_token(self):
        _, tokens = await self.connect()
        await self.db["oauth_tokens"].update_one(
            {"_id": oauth_server.hash_token(tokens["access_token"])},
            {"$set": {"expires_at": oauth_server._now() - timedelta(seconds=1)}})
        oauth_server.clear_access_cache()
        self.assertEqual((await self.rpc(tokens["access_token"], "ping")).status_code, 401)

    async def test_mdat_token_is_not_a_site_session(self):
        _, tokens = await self.connect()
        r = await self.http.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {tokens['access_token']}"})
        self.assertEqual(r.status_code, 401)


class Settings(unittest.TestCase):
    def test_issuer_and_resource_derivation(self):
        from app.config import Settings as S

        s = S(api_base_url="https://api.markdrop.in/")
        self.assertEqual((s.oauth_issuer_url, s.mcp_resource), ("https://api.markdrop.in", "https://api.markdrop.in/mcp"))
        s = S(api_base_url="http://127.0.0.1:8096")
        self.assertEqual((s.oauth_issuer_url, s.mcp_resource), ("http://127.0.0.1:8096", "http://127.0.0.1:8096/mcp"))
        s = S(api_base_url="http://api.example.com")
        self.assertEqual(s.oauth_issuer_url, "https://api.example.com")
        s = S(api_base_url="http://x", mcp_resource_url="https://api.markdrop.in/mcp", oauth_issuer="https://api.markdrop.in")
        self.assertEqual((s.oauth_issuer_url, s.mcp_resource), ("https://api.markdrop.in", "https://api.markdrop.in/mcp"))


if __name__ == "__main__":
    unittest.main()
