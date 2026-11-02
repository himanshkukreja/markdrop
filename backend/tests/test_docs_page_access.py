"""Private pages and sections: the API's half (services/docs_page_access.py,
routers/docs_page_access.py) — rules and who they let in, the readers policy the edge reads, the
publish carrying it, reader grants (page password, emailed link, Markdrop sign-in), access requests
and the audit log, preview-as, and Ask AI reading only what the reader may open. The edge's half is
docs-platform/test/readers.test.mjs; the engine's frontend/src/docs/access.test.mjs."""

from __future__ import annotations

import json
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, unquote, urlsplit

from bson import ObjectId

from tests._docs_sites_env import DocsSitesCase, settings

from app.services import docs_page_access as pa
from app.services import docs_site_access as access
from app.services import docs_snapshot
from app.services.docs_jobs import JOBS, SITES

SECRET = "api-test-secret-0123456789abcdef-0123456789"
SH = "S" * 43
HOST = "acme.guides.markdrop.in"
DA = "/api/v1/docs-access"


def fragment(url: str) -> dict:
    return {k: unquote(v[0]) for k, v in parse_qs(urlsplit(url).fragment).items()}


def query(url: str) -> dict:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


class DictStore:
    def __init__(self):
        self.d: dict[str, str] = {}

    def get_text(self, k):
        return self.d.get(k)

    def put_text(self, k, v):
        self.d[k] = v


class PageAccessTests(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        for p in (mock.patch.object(settings, "docs_access_secret", SECRET),
                  mock.patch.object(settings, "background_workers_enabled", False)):
            p.start()
            self.addCleanup(p.stop)
        self.sent: list[dict] = []
        sender = mock.AsyncMock(side_effect=lambda **kw: self.sent.append(kw))
        for name in ("send_link_email", "send_request_email", "send_decision_email"):
            p = mock.patch.object(pa, name, mock.AsyncMock(side_effect=lambda _n=name, **kw: self.sent.append({"kind": _n, **kw})))
            p.start()
            self.addCleanup(p.stop)
        del sender
        self.site = await self.create("acme", source={"kind": "template", "template": "product"})
        self.sid = self.site["id"]

    async def row(self) -> dict:
        return await self.db[SITES].find_one({"_id": ObjectId(self.sid)})

    async def rule(self, **body) -> dict:
        return (await self.call("POST", f"/{self.sid}/private/rules", json=body))["rule"]

    async def northwind(self) -> dict:
        return await self.rule(kind="people", name="Northwind", emails=["jane@partner.io"], domains=["northwind.com"])

    async def pages(self) -> list[dict]:
        return (await self.get(f"/{self.sid}/pages"))["pages"]

    async def set_page(self, path: str, *, access_rule: str | None = None, markdown: str | None = None) -> dict:
        p = next(x for x in await self.pages() if x["path"] == path)
        full = await self.get(f"/{self.sid}/pages/{p['id']}")
        body: dict = {"base_rev": full["rev"]}
        if access_rule is not None:
            body["frontmatter_extra"] = {**full["frontmatter_extra"], "access": access_rule}
        if markdown is not None:
            body["markdown"] = markdown
        return await self.call("PUT", f"/{self.sid}/pages/{p['id']}", json=body)

    async def go_live(self) -> None:
        b = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        await self.mark_live(b["id"])

    # ── rules ──

    async def test_rules_bump_the_readers_policy_queue_the_sync_and_are_audited(self):
        v0 = pa.version_of(await self.row())
        nw = await self.northwind()
        self.assertEqual(nw["id"], "northwind")
        self.assertEqual((nw["emails"], nw["domains"]), (["jane@partner.io"], ["northwind.com"]))
        pw = await self.rule(kind="password", name="Partners", password="reseller-2026")
        self.assertTrue(pw["has_password"])
        self.assertEqual(pa.version_of(await self.row()), v0 + 2)
        jobs = await self.db[JOBS].find({"site_id": ObjectId(self.sid), "kind": "access"}).to_list(length=10)
        self.assertEqual([j["status"] for j in jobs], ["queued"])
        view = await self.get(f"/{self.sid}/private")
        self.assertNotIn("password_hash", json.dumps(view))
        self.assertNotIn("$2", json.dumps(view))
        self.assertEqual([r["id"] for r in view["rules"]], ["members", "northwind", "partners"])
        self.assertFalse(view["enforced"])
        # Editors see the rules, not who is on them; viewers and strangers see nothing.
        ed = await self.get(f"/{self.sid}/private", who="editor")
        self.assertNotIn("jane@partner.io", json.dumps(ed))
        self.assertEqual(ed["rules"][1]["emails_count"], 1)
        await self.get(f"/{self.sid}/private", who="viewer", expect=403)
        await self.call("POST", f"/{self.sid}/private/rules", who="editor", json={"kind": "people", "name": "X"}, expect=403)
        # Lists are checked; a public provider is not a customer domain.
        for bad in ({"emails": ["not-an-email"]}, {"domains": ["gmail.com"]}, {"domains": ["no_dots"]}):
            await self.call("PATCH", f"/{self.sid}/private/rules/northwind", json=bad, expect=422)
        await self.call("PATCH", f"/{self.sid}/private/rules/northwind", json={"emails": ["jane@partner.io", "ola@contoso.com"]})
        audit = (await self.get(f"/{self.sid}/private/audit"))["entries"]
        self.assertEqual([e["action"] for e in audit], ["rule_updated", "rule_created", "rule_created"])
        self.assertEqual(audit[0]["detail"]["added"], ["ola@contoso.com"])
        self.assertEqual(audit[0]["actor_name"], "Owner")

    async def test_the_policy_object_holds_who_but_no_hash_and_never_goes_back(self):
        await self.northwind()
        await self.rule(kind="password", name="Partners", password="reseller-2026")
        store = DictStore()
        site = await self.row()
        res = access.write_policy(store, site)
        self.assertTrue(res["written"])
        obj = json.loads(store.d[access.policy_key(self.sid)])
        self.assertEqual((obj["level"], obj["policy_version"]), ("public", 0))
        rules = obj["readers"]["rules"]
        self.assertEqual(rules["northwind"], {"kind": "people", "name": "Northwind", "emails": ["jane@partner.io"], "domains": ["northwind.com"]})
        self.assertEqual(rules["partners"], {"kind": "password", "name": "Partners", "pv": 1})
        self.assertEqual(rules["members"]["kind"], "members")
        self.assertNotIn("$2", store.d[access.policy_key(self.sid)])
        # An older writer (a slow runner) doesn't lower the readers part.
        old = {**site, "page_access": {**site["page_access"], "version": 1, "rules": []}}
        self.assertFalse(access.write_policy(store, old)["written"])
        self.assertIn("partners", json.loads(store.d[access.policy_key(self.sid)])["readers"]["rules"])
        # Writing the same thing again writes nothing.
        self.assertFalse(access.write_policy(store, site)["written"])

    async def test_a_rule_in_use_can_not_be_deleted_and_the_team_rule_is_built_in(self):
        await self.northwind()
        await self.set_page("/", markdown="Hi\n\n:::private{access=\"northwind\"}\nsecret\n:::\n")
        r = await self.http.delete(f"/api/v1/docs-sites/{self.sid}/private/rules/northwind", headers=self.h["owner"])
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"]["pages"], ["/"])
        await self.call("DELETE", f"/{self.sid}/private/rules/members", expect=409)

    async def test_sign_out_every_reader_moves_rv(self):
        self.assertEqual(pa.rv_of(await self.row()), 0)
        await self.call("POST", f"/{self.sid}/private/sign-out-readers")
        self.assertEqual(pa.rv_of(await self.row()), 1)
        await self.call("POST", f"/{self.sid}/private/sign-out-readers", who="editor", expect=403)

    # ── a team member who loses access is signed out of private pages ──

    async def mv(self) -> int:
        return pa.mv_of(await self.row())

    async def access_jobs(self) -> int:
        return await self.db[JOBS].count_documents({"site_id": ObjectId(self.sid), "kind": "access"})

    async def test_a_removed_member_ends_team_member_reader_sessions(self):
        from app.services import docs_studio_roles
        from app.services import workspace as ws_service

        # No private pages set up yet: no readers policy, no reader sessions, nothing to end.
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["viewer"], "none", self.uid["owner"])
        self.assertEqual((await self.mv(), pa.version_of(await self.row())), (0, 0))
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["viewer"], "viewer", self.uid["owner"])

        await self.northwind()
        v = pa.version_of(await self.row())
        await self.db[JOBS].delete_many({"site_id": ObjectId(self.sid), "kind": "access"})
        # The policy, the grants and the edge all carry the members version.
        self.assertEqual(pa.readers_policy(await self.row())["mv"], 0)

        # Their studio role goes: mv and the policy version move on, the access job is queued, audited.
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["viewer"], "none", self.uid["owner"])
        row = await self.row()
        self.assertEqual((pa.mv_of(row), pa.version_of(row)), (1, v + 1))
        self.assertEqual(pa.readers_policy(row)["mv"], 1)
        self.assertEqual(await self.access_jobs(), 1)
        self.assertFalse(pa.enforced(row))
        audit = (await self.get(f"/{self.sid}/private/audit"))["entries"]
        self.assertEqual((audit[0]["action"], audit[0]["actor"]), ("members_signed_out", None))
        self.assertEqual(audit[0]["detail"]["target_user_id"], self.uid["viewer"])
        # The rest of the policy is untouched: the rules, who is on them, and rv (other readers stay in).
        self.assertEqual(pa.rv_of(row), 0)
        self.assertEqual(pa.readers_policy(row)["rules"]["northwind"]["emails"], ["jane@partner.io"])
        store = DictStore()
        access.write_policy(store, row)
        self.assertEqual(json.loads(store.d[access.policy_key(self.sid)])["readers"]["mv"], 1)

        # No change, gaining access, or a role that still reads: nobody signed out.
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["viewer"], "none", self.uid["owner"])
        await docs_studio_roles.set_workspace_role(self.db, self.ws, self.uid["viewer"], "viewer", self.uid["owner"])
        site = await self.row()
        await docs_studio_roles.set_site_override(self.db, site, self.uid["editor"], "viewer", self.uid["owner"])
        self.assertEqual(await self.mv(), 1)

        # A site override that hides the guide, then a member removed from the workspace, then a
        # demoted workspace admin with no studio grant of their own: each ends the sessions.
        await docs_studio_roles.set_site_override(self.db, site, self.uid["viewer"], "none", self.uid["owner"])
        self.assertEqual(await self.mv(), 2)
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws}/members/{self.uid['editor']}", headers=self.h["owner"])
        self.assertEqual(r.status_code, 204, r.text)
        self.assertEqual(await self.mv(), 3)
        await ws_service.set_member_role(self.db, self.ws, self.uid["admin"], "member", self.uid["owner"])
        self.assertEqual(await self.mv(), 4)

    async def test_grants_carry_the_members_version(self):
        await self.northwind()
        await self.go_live()
        await self.db[SITES].update_one({"_id": ObjectId(self.sid)}, {"$set": {"page_access.mv": 5}})
        r = await self.http.post(f"{DA}/reader-grant", json={"site_id": self.sid, "host": HOST, "next": "/x", "sh": SH}, headers=self.h["viewer"])
        self.assertEqual(r.status_code, 200, r.text)
        g = access.read(pa.READER_GRANT, fragment(r.json()["url"])["g"])
        self.assertEqual((g["m"], g["mv"]), (True, 5))
        # Junk in the row is no version (and never a negative one).
        for junk, want in (("x", 0), (-3, 0), (None, 0), (7, 7)):
            self.assertEqual(pa.mv_of({"page_access": {"mv": junk}}), want, junk)

    async def test_a_personal_guide_or_a_guide_without_private_pages_is_left_alone(self):
        self.assertIsNone(await pa.revoke_members(self.db, self.sid, "role_changed"))
        self.assertEqual((await self.mv(), pa.version_of(await self.row())), (0, 0))
        await self.northwind()
        await self.db[SITES].update_one({"_id": ObjectId(self.sid)}, {"$set": {"deleted_at": ObjectId().generation_time}})
        self.assertIsNone(await pa.revoke_members(self.db, self.sid, "role_changed"))
        self.assertEqual(await self.mv(), 0)

    # ── the publish ──

    async def test_a_publish_carries_rules_without_lists_and_the_runner_gets_the_readers_policy(self):
        await self.northwind()
        target = next(p for p in await self.pages() if p["path"] != "/")
        await self.set_page(target["path"], access_rule="northwind")
        await self.set_page("/", markdown="Welcome.\n\n:::private[Partner rates]{access=\"members\"}\nTeam only text.\n:::\n")
        await self.call("PUT", f"/{self.sid}/private/groups", json={"groups": {"Get started": "members"}})
        b = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        build = await self.db["docs_builds"].find_one({"_id": ObjectId(b["id"])})
        spec = await docs_snapshot.bundle(self.db, build)
        files = spec["bundle"]["files"]
        sj = json.loads(files["site.json"])
        self.assertEqual(sj["access"]["rules"]["northwind"], {"kind": "people", "name": "Northwind", "nav": "show"})
        self.assertNotIn("jane@partner.io", json.dumps(files))
        self.assertNotIn("northwind.com", json.dumps(files))
        page_file = docs_snapshot.page_file(target["path"])
        self.assertIn('access: "northwind"', files[page_file])
        # The section stays in the content (the engine cuts it out; the builder checks the build).
        self.assertIn(":::private[Partner rates]", files["index.md"])
        groups = {g["group"]: g.get("access") for g in sj["nav"]}
        if "Get started" in groups:
            self.assertEqual(groups["Get started"], "members")
        readers = spec["publish"]["access"]["readers"]
        self.assertEqual(readers["rules"]["northwind"]["domains"], ["northwind.com"])
        self.assertGreaterEqual(readers["version"], 1)

    async def test_publishing_protected_content_starts_a_readers_policy(self):
        self.assertEqual(pa.version_of(await self.row()), 0)
        await self.set_page("/", markdown="Hi\n\n:::private\nTeam text\n:::\n")
        await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        self.assertEqual(pa.version_of(await self.row()), 1)

    # ── readers: page password ──

    async def test_a_page_password_gets_a_reader_grant_for_that_rule_only(self):
        pw = await self.rule(kind="password", name="Partners", password="reseller-2026")
        await self.go_live()
        post = lambda password, **kw: self.http.post(f"{DA}/page-password?site={self.sid}", data={  # noqa: E731
            "host": HOST, "next": "/pricing", "sh": SH, "rule": pw["id"], "password": password, **kw}, headers={"X-Real-IP": "198.51.100.9"})
        r = await post("reseller-2026")
        self.assertEqual(r.status_code, 303, r.text)
        loc = r.headers["location"]
        self.assertTrue(loc.startswith(f"https://{HOST}/_access/callback#g="), loc)
        f = fragment(loc)
        self.assertEqual((f["kind"], f["next"]), ("reader", "/pricing"))
        g = access.read(pa.READER_GRANT, f["g"])
        self.assertEqual((g["s"], g["h"], g["sh"], g["pw"], g["rv"]), (self.sid, HOST, SH, [["partners", 1]], 0))
        self.assertNotIn("e", g)
        self.assertIsNone(access.read(access.GRANT_PURPOSE, f["g"]))  # not a site-wide grant
        wrong = await post("nope")
        self.assertEqual(query(wrong.headers["location"]).get("m"), "wrong")
        self.assertEqual(urlsplit(wrong.headers["location"]).path, "/_access/page")
        other = await self.http.post(f"{DA}/page-password?site={self.sid}", data={"host": HOST, "next": "/", "sh": SH, "rule": "members", "password": "x"})
        self.assertEqual(query(other.headers["location"])["m"], "changed")
        evil = await self.http.post(f"{DA}/page-password?site={self.sid}", data={"host": "evil.test", "next": "/", "sh": SH, "rule": "partners", "password": "reseller-2026"})
        self.assertEqual(evil.status_code, 400)
        # A new password: the old one stops working and the version in grants moves on.
        await self.call("PATCH", f"/{self.sid}/private/rules/partners", json={"password": "new-pass-2027"})
        self.assertEqual(query((await post("reseller-2026")).headers["location"])["m"], "wrong")
        g2 = access.read(pa.READER_GRANT, fragment((await post("new-pass-2027")).headers["location"])["g"])
        self.assertEqual(g2["pw"], [["partners", 2]])

    # ── readers: emailed links ──

    async def test_an_emailed_link_for_a_listed_domain_is_single_use_and_not_tied_to_a_browser(self):
        await self.northwind()
        await self.go_live()
        send = lambda email: self.http.post(f"{DA}/email-link?site={self.sid}", data={  # noqa: E731
            "host": HOST, "next": "/enterprise/sso", "rule": "northwind", "email": email}, headers={"X-Real-IP": "198.51.100.10"})
        r = await send("Ana@Northwind.com")
        self.assertEqual(r.status_code, 303)
        self.assertEqual(query(r.headers["location"]), {"next": "/enterprise/sso", "rule": "northwind", "m": "sent"})
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]["to"], "ana@northwind.com")
        url = self.sent[0]["url"]
        token = url.rsplit("/", 1)[-1]
        self.assertTrue(url.startswith(f"{settings.api_base_url.rstrip('/')}{DA}/email-link/"))
        # The stored row is the token's hash, never the token.
        self.assertIsNone(await self.db[pa.LINKS].find_one({"_id": token}))
        page = await self.http.get(f"{DA}/email-link/{token}")
        self.assertEqual(page.status_code, 200)
        self.assertIn("ana@northwind.com", page.text)
        self.assertIn("<form method=post>", page.text)
        used = await self.http.post(f"{DA}/email-link/{token}")
        self.assertEqual(used.status_code, 303)
        f = fragment(used.headers["location"])
        g = access.read(pa.READER_GRANT, f["g"])
        self.assertEqual((g["e"], g["x"], g.get("sh"), g.get("m")), ("ana@northwind.com", "email", None, None))
        self.assertTrue(g["exp"] <= time.time() + 121)
        self.assertEqual((await self.http.post(f"{DA}/email-link/{token}")).status_code, 410)
        self.assertEqual((await self.http.get(f"{DA}/email-link/{token}")).status_code, 410)

    async def test_an_unlisted_address_gets_the_same_answer_and_no_email_and_team_members_get_m(self):
        await self.northwind()
        await self.go_live()
        r = await self.http.post(f"{DA}/email-link?site={self.sid}", data={"host": HOST, "next": "/", "rule": "northwind", "email": "eve@evil.test"})
        self.assertEqual(query(r.headers["location"])["m"], "sent")
        self.assertEqual(self.sent, [])
        bad = await self.http.post(f"{DA}/email-link?site={self.sid}", data={"host": HOST, "next": "/", "rule": "northwind", "email": "nope"})
        self.assertEqual(query(bad.headers["location"])["m"], "email")
        await self.http.post(f"{DA}/email-link?site={self.sid}", data={"host": HOST, "next": "/", "rule": "members", "email": "viewer@example.com"})
        token = self.sent[-1]["url"].rsplit("/", 1)[-1]
        g = access.read(pa.READER_GRANT, fragment((await self.http.post(f"{DA}/email-link/{token}")).headers["location"])["g"])
        self.assertTrue(g["m"])

    async def test_email_links_are_rate_limited_per_address(self):
        await self.northwind()
        await self.go_live()
        for i in range(6):
            r = await self.http.post(f"{DA}/email-link?site={self.sid}", data={"host": HOST, "next": "/", "rule": "northwind", "email": "ana@northwind.com"},
                                     headers={"X-Real-IP": f"198.51.100.{20 + i}"})
        self.assertEqual(query(r.headers["location"])["m"], "rate")
        self.assertEqual(len(self.sent), 5)

    # ── readers: Markdrop sign-in ──

    async def test_reader_grant_carries_the_account_email_and_team_membership(self):
        await self.go_live()
        r = await self.http.post(f"{DA}/reader-grant", json={"site_id": self.sid, "host": HOST, "next": "/x", "sh": SH}, headers=self.h["viewer"])
        self.assertEqual(r.status_code, 200, r.text)
        g = access.read(pa.READER_GRANT, fragment(r.json()["url"])["g"])
        self.assertEqual((g["e"], g["m"], g["sh"]), ("viewer@example.com", True, SH))
        s = await self.http.post(f"{DA}/reader-grant", json={"site_id": self.sid, "host": HOST, "sh": SH}, headers=self.h["stranger"])
        g2 = access.read(pa.READER_GRANT, fragment(s.json()["url"])["g"])
        self.assertEqual((g2["e"], g2.get("m")), ("stranger@example.com", None))
        self.assertEqual((await self.http.post(f"{DA}/reader-grant", json={"site_id": self.sid, "host": HOST, "sh": SH})).status_code, 401)
        self.assertEqual((await self.http.post(f"{DA}/reader-grant", json={"site_id": self.sid, "host": "evil.test", "sh": SH}, headers=self.h["viewer"])).status_code, 400)

    # ── requests ──

    async def test_access_requests_reach_the_admins_and_approval_adds_the_email(self):
        await self.northwind()
        await self.go_live()
        ask = lambda email: self.http.post(f"{DA}/request?site={self.sid}", data={  # noqa: E731
            "host": HOST, "next": "/enterprise/sso", "rule": "northwind", "email": email, "note": "I run SSO at Contoso"})
        r = await ask("ola@contoso.com")
        self.assertEqual(query(r.headers["location"])["m"], "requested")
        await ask("ola@contoso.com")  # the same request again: one row, one email
        notices = [s for s in self.sent if s["kind"] == "send_request_email"]
        self.assertEqual(len(notices), 1)
        self.assertEqual(sorted(notices[0]["to"]), ["admin@example.com", "owner@example.com"])
        self.assertIn("/settings/private#requests", notices[0]["url"])
        view = await self.get(f"/{self.sid}/private")
        self.assertEqual(view["requests_pending"], 1)
        req = view["requests"][0]
        self.assertEqual((req["email"], req["rule"], req["note"]), ("ola@contoso.com", "northwind", "I run SSO at Contoso"))
        out = await self.call("POST", f"/{self.sid}/private/requests/{req['id']}/approve", json={})
        rule = next(r for r in out["private"]["rules"] if r["id"] == "northwind")
        self.assertIn("ola@contoso.com", rule["emails"])
        self.assertEqual(out["private"]["requests_pending"], 0)
        self.assertTrue(any(s["kind"] == "send_decision_email" and s["approved"] for s in self.sent))
        await self.call("POST", f"/{self.sid}/private/requests/{req['id']}/approve", json={}, expect=409)
        r2 = await ask("max@contoso.com")
        self.assertEqual(r2.status_code, 303)
        rid = (await self.get(f"/{self.sid}/private"))["requests"][0]["id"]
        await self.call("POST", f"/{self.sid}/private/requests/{rid}/decline", json={})
        actions = [e["action"] for e in (await self.get(f"/{self.sid}/private/audit"))["entries"]]
        self.assertEqual(actions[:2], ["request_declined", "request_approved"])

    # ── preview-as and warnings ──

    async def test_preview_as_public_member_email_and_link_warnings(self):
        await self.northwind()
        target = next(p for p in await self.pages() if p["path"] != "/")
        await self.set_page(target["path"], access_rule="northwind")
        await self.set_page("/", markdown=f"See [the setup]({target['path']}).\n\n:::private{{access=\"members\"}}\nx\n:::\n")
        pub = await self.get(f"/{self.sid}/private/preview?as=public")
        row = next(r for r in pub["pages"] if r["path"] == target["path"])
        self.assertEqual((row["rule"], row["open"]), ("northwind", False))
        home = next(r for r in pub["pages"] if r["path"] == "/")
        self.assertEqual(home["sections"], [{"rule": "members", "open": False, "unknown_rule": False}])
        nw = await self.get(f"/{self.sid}/private/preview?as=email&email=ana@northwind.com")
        self.assertTrue(next(r for r in nw["pages"] if r["path"] == target["path"])["open"])
        self.assertFalse(next(r for r in nw["pages"] if r["path"] == "/")["sections"][0]["open"])
        mem = await self.get(f"/{self.sid}/private/preview?as=member")
        self.assertEqual(mem["locked"], 0)
        await self.get(f"/{self.sid}/private/preview?as=email&email=nope", expect=422)
        view = await self.get(f"/{self.sid}/private")
        self.assertEqual(view["warnings"], [{"from": "/", "to": target["path"], "rule": "northwind"}])
        self.assertEqual(view["protected_pages"], 1)
        self.assertEqual(view["private_sections"], 1)


class AskAiAccessTests(unittest.TestCase):
    FILES = {
        "site.json": json.dumps({"name": "Acme", "url": "https://docs.acme.test", "nav": [
            {"group": "Start", "pages": ["/guides/sso"]}, {"group": "Enterprise", "access": "northwind", "pages": ["/enterprise/setup"]}],
            "access": {"rules": {"northwind": {"kind": "people", "name": "Northwind"}}}}),
        "guides/sso.md": "---\ntitle: SSO\n---\nPublic intro about single sign-on.\n\n:::private{access=\"northwind\"}\n## Tenant values\nThe entity id is urn:acme:northwind-prod-4471.\n:::\n\n:::private\nTeam-only escalation path via the zebra channel.\n:::\n",
        "enterprise/setup.md": "---\ntitle: Northwind setup\n---\nConfigure the okta tenant with the northwind metadata file.\n",
        "team/runbook.md": "---\ntitle: Runbook\naccess: members\n---\nPage the on-call through the zebra channel.\n",
    }

    def index(self, reveal=frozenset()):
        from app.services import docs_index, docs_sites

        site = json.loads(self.FILES["site.json"])
        cfg = docs_sites.SiteConfig("acme", Path("x"), site, {})
        return docs_index.Index(Path("x"), "acme", reveal).load_files(self.FILES, cfg, ("t",))

    def text(self, idx) -> str:
        return json.dumps([(p.path, p.body) for p in idx.pages.values()]) + json.dumps([s.raw for s in idx.sections.values()])

    def test_the_public_index_has_no_protected_page_or_section(self):
        idx = self.index()
        self.assertEqual(sorted(idx.pages), ["/guides/sso"])
        t = self.text(idx)
        for secret in ("northwind-prod-4471", "zebra", "okta tenant", "Tenant values"):
            self.assertNotIn(secret, t)
        self.assertIn("Private section", t)
        for s, _ in idx.search("entity id northwind zebra okta tenant"):
            self.assertNotIn("4471", s.raw)

    def test_a_reader_index_reveals_exactly_their_rules(self):
        nw = self.index(frozenset({"northwind"}))
        self.assertEqual(sorted(nw.pages), ["/enterprise/setup", "/guides/sso"])
        t = self.text(nw)
        self.assertIn("northwind-prod-4471", t)
        self.assertNotIn("zebra", t)
        team = self.index(frozenset({"members", "northwind"}))
        self.assertIn("/team/runbook", team.pages)
        self.assertIn("zebra", self.text(team))

    def test_ai_tokens_are_checked(self):
        with mock.patch.object(settings, "docs_access_secret", SECRET):
            good = access.sign(pa.AI_TOKEN, {"s": "site1", "r": ["northwind", "BAD!"], "exp": int(time.time()) + 600})
            self.assertEqual(pa.ai_rules(good, "site1"), frozenset({"northwind"}))
            self.assertEqual(pa.ai_rules(good, "site2"), frozenset())
            self.assertEqual(pa.ai_rules(access.sign(pa.AI_TOKEN, {"s": "site1", "r": ["northwind"], "exp": int(time.time()) - 1}), "site1"), frozenset())
            self.assertEqual(pa.ai_rules(access.sign(pa.AI_TOKEN, {"s": "site1", "r": ["northwind"], "exp": int(time.time()) + 86400}), "site1"), frozenset())
            self.assertEqual(pa.ai_rules(access.sign(pa.READER_GRANT, {"s": "site1", "r": ["northwind"], "exp": int(time.time()) + 60}), "site1"), frozenset())
            self.assertEqual(pa.ai_rules(None, "site1"), frozenset())


class SplitParityTests(unittest.TestCase):
    """split_private cuts what the engine's splitPrivate cuts (frontend/src/docs/access.test.mjs)."""

    def test_hidden_revealed_nested_fenced_quoted_listed_unclosed(self):
        src = ("Intro.\n\n:::private[SSO]{access=\"northwind\"}\n## Rotate\nnw-cert-7731\n```bash\n:::\necho inside\n```\n:::\n\n"
               "## Public\n\n::::private{access=\"members\"}\n:::warning\nTeam warning\n:::\n::::\n\nTail.")
        body, rules = pa.split_private(src, None)
        self.assertEqual(rules, ["northwind", "members"])
        for secret in ("nw-cert-7731", "Rotate", "echo inside", "Team warning"):
            self.assertNotIn(secret, body)
        for kept in ("Intro.", "## Public", "Tail.", "_Private section: SSO._"):
            self.assertIn(kept, body)
        shown, _ = pa.split_private(src, {"northwind"})
        self.assertIn("nw-cert-7731", shown)
        self.assertNotIn("Team warning", shown)
        self.assertNotIn("quoted secret", pa.split_private("> :::private\n> quoted secret\n> :::\nafter", None)[0])
        self.assertNotIn("list secret", pa.split_private("- :::private\n  list secret\n  :::\n- next", None)[0])
        self.assertNotIn("more", pa.split_private("a\n:::private\nsecret\nmore", None)[0])
        code = "```md\n:::private\nshown as code\n:::\n```"
        self.assertEqual(pa.split_private(code, None)[0], code)

    def test_page_rules(self):
        self.assertEqual(pa.page_rule(None, "northwind"), "northwind")
        self.assertIsNone(pa.page_rule("public", "northwind"))
        self.assertEqual(pa.page_rule("partners", None), "partners")
        self.assertEqual(pa.page_rule("../x", None), "invalid")
        self.assertIsNone(pa.page_rule("inherit", None))


if __name__ == "__main__":
    unittest.main()
