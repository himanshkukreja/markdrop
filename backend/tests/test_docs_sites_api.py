"""Hosted docs sites API: sites, roles, limits, settings, publishing, reviews,
builds, restore, jobs, uploads and usage events (routers/docs_sites.py).

Pages, locks and versions are in test_docs_site_pages.py. The docs R2 bucket is
in memory (tests/_docs_sites_env.py); nothing here reaches a network.
"""

from __future__ import annotations

import unittest
from unittest import mock

from bson import ObjectId

from tests._docs_sites_env import BASE, DocsSitesCase, settings

from app.services import docs_site_settings as site_settings

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class Create(DocsSitesCase):
    async def test_blank_site_in_a_workspace(self):
        site = await self.create("acme")
        self.assertEqual((site["name"], site["slug"], site["status"], site["your_role"]),
                         ("Acme Docs", "acme", "draft", "owner"))
        self.assertEqual(site["url"], "https://acme.docs.markdrop.in")
        self.assertEqual(site["workspace_id"], self.ws)
        self.assertEqual(site["source"], {"kind": "blank"})
        self.assertEqual(site["counts"]["pages"], 1)
        self.assertIsNone(site["live_build"])
        self.assertEqual(site["settings"]["theme"]["preset"], "clean")
        self.assertEqual(site["settings"]["access"], {"level": "public", "has_password": False})
        self.assertEqual(site["limits"]["sites"], 3)
        home = await self.home(site["id"])
        self.assertEqual((home["path"], home["rev"], home["has_changes"]), ("/", 1, True))
        self.assertEqual(site["settings"]["nav"], [{"group": "Getting started", "pages": [home["id"]]}])
        ev = await self.db["docs_events"].find_one({"kind": "docs_site_created"})
        self.assertEqual((ev["user_id"], ev["workspace_id"], ev["meta"]["source"]),
                         (self.uid["owner"], self.ws, "blank"))
        versions = await self.get(f"/{site['id']}/pages/{home['id']}/versions")
        self.assertEqual([(v["rev"], v["kind"]) for v in versions], [(1, "save")])

    async def test_who_can_create(self):
        await self.create("by-admin", "admin")
        await self.create("by-editor", "editor", expect=403)
        await self.create("by-viewer", "viewer", expect=403)
        await self.create("by-stranger", "stranger", expect=404)
        # A personal site: anyone signed in, owner only.
        mine = await self.create("strangers-own", "stranger", workspace=False)
        self.assertEqual((mine["workspace_id"], mine["your_role"]), (None, "owner"))
        await self.get(f"/{mine['id']}", "owner", expect=404)
        r = await self.http.post(BASE, json={"name": "x", "slug": "nobody"})
        self.assertEqual(r.status_code, 401)

    async def test_workspace_being_deleted_refuses(self):
        await self.db["workspaces"].update_one({"_id": ObjectId(self.ws)}, {"$set": {"deleting": True}})
        await self.create("acme", expect=409)

    async def test_slug_rules(self):
        for bad in ("ab", "a" * 41, "-acme", "acme-", "ac_me", "acmé", "a.b"):
            await self.create(bad, expect=422)
        for reserved in ("www", "api", "docs", "admin", "app", "mail", "status", "cdn", "assets", "static"):
            await self.create(reserved, expect=422)
        site = await self.create("Acme-Docs")  # case-folded
        self.assertEqual(site["slug"], "acme-docs")
        await self.create("acme-docs", "admin", expect=409)

        r = await self.get("/slug-available", params={"slug": "acme-docs"})
        self.assertEqual((r["available"], r["reason"]), (False, "taken"))
        r = await self.get("/slug-available", params={"slug": "www"})
        self.assertEqual((r["available"], r["reason"]), (False, "reserved"))
        r = await self.get("/slug-available", params={"slug": "x"})
        self.assertEqual((r["available"], r["reason"]), (False, "invalid"))
        r = await self.get("/slug-available", params={"slug": "fresh-one"})
        self.assertEqual((r["available"], r["url"]), (True, "https://fresh-one.docs.markdrop.in"))
        # Your own site's slug is available to itself.
        r = await self.get("/slug-available", params={"slug": "acme-docs", "site_id": site["id"]})
        self.assertTrue(r["available"])

    async def test_three_sites_per_workspace(self):
        a = await self.create("one")
        await self.create("two")
        await self.create("three", "admin")
        r = await self.http.post(BASE, json={"workspace_id": self.ws, "name": "4", "slug": "four"},
                                 headers=self.h["owner"])
        self.assertEqual(r.status_code, 429)
        self.assertIn("3 docs sites", r.json()["detail"])
        # Personal sites have their own allowance.
        await self.create("mine", workspace=False)
        # Deleting one frees a slot, and its address.
        await self.call("DELETE", f"/{a['id']}")
        await self.create("one")

    async def test_templates(self):
        expected = {"product": ("clean", "/getting-started/quickstart"), "api": ("technical", "/api/authentication"),
                    "helpcenter": ("helpcenter", "/troubleshooting/cant-sign-in")}
        for i, (template, (preset, a_path)) in enumerate(expected.items()):
            site = await self.create(f"tpl-{i}", "owner" if i < 2 else "admin",
                                     source={"kind": "template", "template": template})
            self.assertEqual(site["source"], {"kind": "template", "template": template})
            self.assertEqual(site["settings"]["theme"]["preset"], preset)
            listing = await self.get(f"/{site['id']}/pages")
            paths = {p["path"]: p["id"] for p in listing["pages"]}
            self.assertIn("/", paths)
            self.assertIn(a_path, paths)
            nav_ids = [pid for g in listing["nav"] for pid in g["pages"]]
            self.assertEqual(nav_ids[0], paths["/"])
            self.assertEqual(sorted(nav_ids), sorted(paths.values()))
        await self.create("tpl-x", source={"kind": "template", "template": "nope"}, expect=422)
        await self.create("tpl-y", source={"kind": "template"}, expect=422)

    async def test_gitbook_import_queues_a_job(self):
        site = await self.create("imported", source={"kind": "gitbook", "url": "https://docs.acme.test/"})
        self.assertEqual(site["source"], {"kind": "gitbook", "url": "https://docs.acme.test/"})
        self.assertEqual(site["counts"]["pages"], 0)
        job = site["job"]
        self.assertEqual((job["kind"], job["status"], job["payload"]),
                         ("import", "queued", {"source": "gitbook", "url": "https://docs.acme.test/"}))
        row = await self.db["docs_jobs"].find_one({"_id": ObjectId(job["id"])})
        self.assertEqual((row["site_id"], row["attempts"], row["locked_until"]), (ObjectId(site["id"]), 0, None))
        self.assertEqual(await self.db["docs_events"].count_documents({"kind": "docs_imported"}), 1)
        got = await self.get(f"/{site['id']}/jobs/{job['id']}")
        self.assertEqual(got["id"], job["id"])
        for bad in ("http://docs.acme.test", "https://localhost/x", "https://10.0.0.1/", "ftp://x.y", "notaurl"):
            await self.create("imported-2", source={"kind": "gitbook", "url": bad}, expect=422)

    async def test_github_source_is_pending(self):
        site = await self.create("from-gh", source={"kind": "github", "repo": {
            "owner": "acme", "name": "docs", "branch": "main", "path": "docs/"}})
        self.assertEqual(site["source"], {"kind": "github", "status": "pending", "repo": {
            "owner": "acme", "name": "docs", "branch": "main", "path": "/docs"}})
        self.assertEqual(site["counts"]["pages"], 0)
        await self.create("from-gh2", source={"kind": "github"}, expect=422)
        await self.create("from-gh3", source={"kind": "github", "repo": {"owner": "a b", "name": "d"}}, expect=422)


class ListAndRead(DocsSitesCase):
    async def test_list_by_workspace_and_personal(self):
        a = await self.create("acme")
        await self.create("mine", workspace=False)
        for who, role in (("owner", "owner"), ("admin", "admin"), ("editor", "editor"), ("viewer", "viewer")):
            res = await self.get("", who, params={"workspace_id": self.ws})
            self.assertEqual([s["slug"] for s in res["sites"]], ["acme"])
            self.assertEqual(res["sites"][0]["your_role"], role)
            self.assertEqual(res["usage"], {"sites": 1, "limit": 3, "ai_used": 0, "ai_limit": 1000})
        await self.get("", "stranger", expect=404, params={"workspace_id": self.ws})
        personal = await self.get("")
        self.assertEqual([s["slug"] for s in personal["sites"]], ["mine"])
        s = (await self.get("", params={"workspace_id": self.ws}))["sites"][0]
        self.assertEqual((s["page_count"], s["preset"], s["in_review"], s["status"]), (1, "clean", False, "draft"))
        # Viewers read the site; strangers can't tell it exists.
        got = await self.get(f"/{a['id']}", "viewer")
        self.assertEqual(got["your_role"], "viewer")
        await self.get(f"/{a['id']}", "stranger", expect=404)
        await self.get("/not-an-id", expect=404)

    async def test_ai_answers_counted_per_site(self):
        a = await self.create("acme")
        from datetime import datetime, timezone

        ts = datetime.now(timezone.utc)
        await self.db["ai_requests"].insert_many([
            {"feature": "docs_ask", "site": a["id"], "ts": ts, "outcome": "answered"},
            {"feature": "docs_ask", "site": a["id"], "ts": ts, "outcome": "no_answer"},
            {"feature": "docs_ask", "site": a["id"], "ts": ts, "outcome": "limit"},
            {"feature": "docs_ask", "site": "markdrop", "ts": ts, "outcome": "answered"},
        ])
        res = await self.get("", params={"workspace_id": self.ws})
        self.assertEqual((res["usage"]["ai_used"], res["sites"][0]["ai_used"]), (2, 2))
        got = await self.get(f"/{a['id']}")
        self.assertEqual(got["counts"]["ai_answers_this_month"], 2)


class Settings(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme")
        self.sid = self.site["id"]

    async def patch(self, body: dict, who: str = "owner", expect: int = 200) -> dict:
        return await self.call("PATCH", f"/{self.sid}", who, expect, json=body)

    async def test_only_admins_change_settings(self):
        await self.patch({"name": "x"}, "editor", 403)
        await self.patch({"name": "x"}, "viewer", 403)
        await self.patch({"name": "x"}, "stranger", 404)
        got = await self.patch({"name": "New name"}, "admin")
        self.assertEqual(got["name"], "New name")

    async def test_theme_validation_and_deep_merge(self):
        got = await self.patch({"settings": {"theme": {"preset": "editorial", "mode": "dark", "corners": "round",
                                                       "brand": {"enabled": True, "colors": ["#ABC", "#0f766e"],
                                                                 "accent": "#0F766E",
                                                                 "logo_url": "/docs-assets/x.png"}}}})
        theme = got["settings"]["theme"]
        self.assertEqual((theme["preset"], theme["mode"], theme["corners"]), ("editorial", "dark", "round"))
        self.assertEqual(theme["brand"]["colors"], ["#aabbcc", "#0f766e"])
        self.assertEqual(theme["brand"]["accent"], "#0f766e")
        # A partial patch keeps the rest.
        got = await self.patch({"settings": {"theme": {"fonts": {"heading": "newsreader"}}}})
        theme = got["settings"]["theme"]
        self.assertEqual((theme["preset"], theme["fonts"]["heading"], theme["brand"]["enabled"]),
                         ("editorial", "newsreader", True))
        got = await self.patch({"settings": {"theme": {"corners": None}}})
        self.assertIsNone(got["settings"]["theme"]["corners"])
        for bad in ({"preset": "fancy"}, {"mode": "sepia"}, {"corners": "pointy"},
                    {"fonts": {"body": "comic-sans"}}, {"brand": {"colors": ["red"]}},
                    {"brand": {"accent": "#12345"}}, {"brand": {"logo_url": "http://x.test/a.png"}},
                    {"brand": {"colors": ["#000"] * 7}}, {"unknown": 1}):
            r = await self.http.patch(f"{BASE}/{self.sid}", json={"settings": {"theme": bad}}, headers=self.h["owner"])
            self.assertEqual(r.status_code, 422, (bad, r.text))
        await self.patch({"settings": {"bogus": {}}}, expect=422)
        await self.patch({"settings": {"ai": {"enabled": True, "suggestions": ["a"] * 6}}}, expect=422)
        got = await self.patch({"settings": {"ai": {"enabled": True, "name": "Ask Acme",
                                                    "suggestions": ["How do I start?"]}, "seo": {"index": False},
                                             "review": {"required": True}}})
        self.assertEqual(got["settings"]["ai"], {"enabled": True, "name": "Ask Acme", "suggestions": ["How do I start?"]})
        self.assertEqual((got["settings"]["seo"], got["settings"]["review"]), ({"index": False}, {"required": True}))

    async def test_custom_css(self):
        ok = ".docs-callout { border-radius: 0; } .hero { background: url(\"https://cdn.acme.test/bg.png\") }"
        got = await self.patch({"settings": {"theme": {"custom_css": ok}}})
        self.assertEqual(got["settings"]["theme"]["custom_css"], ok)
        bad = [
            "@import url(https://x.test/a.css);",
            "@\\69mport 'x';",
            "a { background: url(http://x.test/a.png) }",
            "a { background: url(data:image/png;base64,AAAA) }",
            "a { width: expression(alert(1)) }",
            "a { width: expr/**/ession(alert(1)) }",
            "a { background: url(javascript:alert(1)) }",
            "</style><script>alert(1)</script>",
            "a { behavior: url(https://x.test/x.htc) }",
            "a { -moz-binding: url(https://x.test/x.xml) }",
            "a { background: image-set('http://x.test/a.png' 1x) }",
            "a{}" + " " * (20 * 1024),
        ]
        for css in bad:
            r = await self.http.patch(f"{BASE}/{self.sid}", json={"settings": {"theme": {"custom_css": css}}},
                                      headers=self.h["owner"])
            self.assertEqual(r.status_code, 422, (css[:40], r.text))
        got = await self.patch({"settings": {"theme": {"custom_css": None}}})
        self.assertIsNone(got["settings"]["theme"]["custom_css"])

    async def test_access_password_is_write_only(self):
        await self.patch({"settings": {"access": {"level": "password"}}}, expect=422)
        await self.patch({"settings": {"access": {"level": "password", "password": "short"}}}, expect=422)
        await self.patch({"settings": {"access": {"password_hash": "x"}}}, expect=422)
        got = await self.patch({"settings": {"access": {"level": "password", "password": "s3cret-pass"}}})
        self.assertEqual(got["settings"]["access"], {"level": "password", "has_password": True})
        raw = await self.db["docs_sites"].find_one({"_id": ObjectId(self.sid)})
        self.assertTrue(raw["settings"]["access"]["password_hash"].startswith("$2"))
        got = await self.patch({"settings": {"access": {"level": "members"}}})
        self.assertEqual(got["settings"]["access"]["level"], "members")

    async def test_nav_and_slug_via_patch(self):
        await self.patch({"settings": {"nav": []}}, expect=422)
        other = await self.create("other")
        await self.patch({"slug": "other"}, expect=409)
        await self.patch({"slug": "www"}, expect=422)
        got = await self.patch({"slug": "acme-2"})
        self.assertEqual((got["slug"], got["url"]), ("acme-2", "https://acme-2.docs.markdrop.in"))
        self.assertTrue(other["id"])


class Publish(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme", source={"kind": "template", "template": "product"})
        self.sid = self.site["id"]

    async def test_publish_snapshots_and_queues_a_build(self):
        await self.call("POST", f"/{self.sid}/publish", "viewer", 403, json={})
        b = await self.call("POST", f"/{self.sid}/publish", "editor", 202, json={"note": "First"})
        self.assertEqual((b["number"], b["status"], b["note"], b["requested_by"]),
                         (1, "queued", "First", self.uid["editor"]))
        self.assertEqual(b["requested_by_name"], "Editor")
        self.assertEqual((b["job"]["kind"], b["job"]["status"]), ("build", "queued"))
        self.assertEqual(b["job"]["payload"], {"build_id": b["id"], "snapshot_id": b["snapshot_id"], "number": 1})
        snap = await self.db["docs_snapshots"].find_one({"_id": ObjectId(b["snapshot_id"])})
        self.assertEqual(snap["site"]["slug"], "acme")
        self.assertEqual(len(snap["pages"]), 6)
        page = next(p for p in snap["pages"] if p["path"] == "/getting-started/quickstart")
        self.assertIn("::::steps", page["markdown"])
        self.assertEqual(set(page), {"page_id", "path", "title", "description", "icon", "hidden", "markdown",
                                     "frontmatter_extra", "rev", "hash"})
        self.assertEqual(snap["settings"]["nav"], self.site["settings"]["nav"])
        build = await self.db["docs_builds"].find_one({"_id": ObjectId(b["id"])})
        self.assertEqual((build["site_id"], build["snapshot_id"], build["job_id"]),
                         (ObjectId(self.sid), ObjectId(b["snapshot_id"]), ObjectId(b["job"]["id"])))
        b2 = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        self.assertEqual(b2["number"], 2)
        ev = await self.db["docs_events"].count_documents({"kind": "docs_published"})
        self.assertEqual(ev, 2)
        builds = await self.get(f"/{self.sid}/builds")
        self.assertEqual([x["number"] for x in builds], [2, 1])

    async def test_review_required_blocks_editors_not_admins(self):
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"review": {"required": True}}})
        r = await self.http.post(f"{BASE}/{self.sid}/publish", json={}, headers=self.h["editor"])
        self.assertEqual((r.status_code, r.json()), (409, {"detail": "review required"}))
        await self.call("POST", f"/{self.sid}/publish", "admin", 202, json={})

    async def test_daily_build_cap(self):
        with mock.patch.object(settings, "docs_builds_per_day", 2):
            await self.call("POST", f"/{self.sid}/publish", expect=202)
            await self.call("POST", f"/{self.sid}/publish", expect=202)
            r = await self.http.post(f"{BASE}/{self.sid}/publish", headers=self.h["owner"])
            self.assertEqual(r.status_code, 429)

    async def test_changes_since_publish(self):
        ch = await self.get(f"/{self.sid}/changes")
        self.assertEqual((ch["ever_published"], ch["live_build"], len(ch["pages"])), (False, None, 6))
        self.assertEqual({p["change"] for p in ch["pages"]}, {"added"})
        b = await self.call("POST", f"/{self.sid}/publish", expect=202)
        # Queued, not live yet: still everything.
        self.assertEqual(len((await self.get(f"/{self.sid}/changes"))["pages"]), 6)
        await self.mark_live(b["id"])
        ch = await self.get(f"/{self.sid}/changes")
        self.assertEqual((ch["count"], ch["live_build"]["number"]), (0, 1))
        listing = await self.get(f"/{self.sid}/pages")
        self.assertFalse(any(p["has_changes"] for p in listing["pages"]))

        home = await self.home(self.sid)
        await self.call("PUT", f"/{self.sid}/pages/{home['id']}", json={
            "base_rev": home["rev"], "markdown": home["markdown"] + "One more line.\n"})
        new = await self.call("POST", f"/{self.sid}/pages", json={"path": "/guides/new", "title": "New"}, expect=201)
        gone = next(p for p in listing["pages"] if p["path"] == "/help/faq")
        await self.call("DELETE", f"/{self.sid}/pages/{gone['id']}")
        await self.call("PATCH", f"/{self.sid}", json={"name": "Renamed", "settings": {"theme": {"preset": "minimal"}}})
        ch = await self.get(f"/{self.sid}/changes")
        by_id = {p["id"]: p for p in ch["pages"]}
        self.assertEqual(by_id[home["id"]]["change"], "modified")
        self.assertEqual(by_id[home["id"]]["lines_changed"], 1)
        self.assertEqual(by_id[home["id"]]["updated_by_name"], "Owner")
        self.assertEqual(by_id[new["id"]]["change"], "added")
        self.assertEqual((by_id[gone["id"]]["change"], by_id[gone["id"]]["path"]), ("deleted", "/help/faq"))
        self.assertEqual(sorted(ch["settings_changed"]), ["name", "nav", "theme"])
        self.assertEqual(ch["count"], 6)
        listing = await self.get(f"/{self.sid}/pages")
        changed = {p["path"] for p in listing["pages"] if p["has_changes"]}
        self.assertEqual(changed, {"/", "/guides/new"})


class Reviews(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme")
        self.sid = self.site["id"]
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"review": {"required": True}}})

    async def test_submit_approve(self):
        await self.call("POST", f"/{self.sid}/reviews", "viewer", 403, json={"note": "x"})
        rv = await self.call("POST", f"/{self.sid}/reviews", "editor", 201, json={"note": "Please look"})
        self.assertEqual((rv["status"], rv["note"], rv["requested_by_name"]), ("open", "Please look", "Editor"))
        self.assertEqual(len(rv["page_ids"]), 1)
        r = await self.http.post(f"{BASE}/{self.sid}/reviews", json={"note": "again"}, headers=self.h["admin"])
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["review"]["id"], rv["id"])
        site = await self.get(f"/{self.sid}")
        self.assertEqual((site["in_review"], site["open_review_id"]), (True, rv["id"]))

        await self.call("POST", f"/{self.sid}/reviews/{rv['id']}/approve", "editor", 403, json={})
        out = await self.call("POST", f"/{self.sid}/reviews/{rv['id']}/approve", "admin", 202, json={"comment": "LGTM"})
        self.assertEqual((out["review"]["status"], out["review"]["decided_by_name"], out["review"]["comment"]),
                         ("approved", "Admin", "LGTM"))
        self.assertEqual(out["build"]["review_id"], rv["id"])
        self.assertEqual(out["review"]["build_id"], out["build"]["id"])
        self.assertEqual(out["build"]["requested_by"], self.uid["admin"])
        self.assertEqual(out["build"]["job"]["kind"], "build")
        await self.call("POST", f"/{self.sid}/reviews/{rv['id']}/approve", "admin", 409, json={})
        kinds = sorted(e["kind"] for e in await self.db["docs_events"].find({}).to_list(length=20))
        self.assertEqual(kinds, ["docs_published", "docs_review_approved", "docs_review_submitted", "docs_site_created"])
        open_ = await self.get(f"/{self.sid}/reviews", params={"status": "open"})
        self.assertEqual(open_, [])
        all_ = await self.get(f"/{self.sid}/reviews", "viewer")
        self.assertEqual([x["status"] for x in all_], ["approved"])

    async def test_request_changes_and_withdraw(self):
        rv = await self.call("POST", f"/{self.sid}/reviews", "editor", 201, json={"note": "v1"})
        await self.call("POST", f"/{self.sid}/reviews/{rv['id']}/request-changes", "editor", 403, json={})
        out = await self.call("POST", f"/{self.sid}/reviews/{rv['id']}/request-changes", "owner",
                              json={"comment": "Fix the intro"})
        self.assertEqual((out["status"], out["comment"]), ("changes_requested", "Fix the intro"))
        rv2 = await self.call("POST", f"/{self.sid}/reviews", "editor", 201, json={})
        # Another editor can't withdraw it; the submitter or an admin can.
        await self.db["memberships"].insert_one({"workspace_id": self.ws, "user_id": self.uid["stranger"],
                                                 "role": "member"})
        await self.call("POST", f"/{self.sid}/reviews/{rv2['id']}/withdraw", "stranger", 403)
        out = await self.call("POST", f"/{self.sid}/reviews/{rv2['id']}/withdraw", "editor")
        self.assertEqual(out["status"], "withdrawn")
        await self.call("POST", f"/{self.sid}/reviews/{rv2['id']}/withdraw", "editor", 409)
        await self.call("POST", f"/{self.sid}/reviews/{ObjectId()}/withdraw", "editor", 404)

    async def test_nothing_to_review_after_publish(self):
        b = await self.call("POST", f"/{self.sid}/publish", "admin", 202)
        await self.mark_live(b["id"])
        await self.call("POST", f"/{self.sid}/reviews", "editor", 422, json={})

    async def test_approval_that_cannot_publish_keeps_review_open(self):
        rv = await self.call("POST", f"/{self.sid}/reviews", "editor", 201, json={})
        with mock.patch.object(settings, "docs_builds_per_day", 0):
            await self.call("POST", f"/{self.sid}/reviews/{rv['id']}/approve", "admin", 429)
        got = await self.get(f"/{self.sid}/reviews", params={"status": "open"})
        self.assertEqual([x["id"] for x in got], [rv["id"]])


class BuildsAndRestore(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme")
        self.sid = self.site["id"]

    async def test_restore_and_unpublish(self):
        b1 = await self.call("POST", f"/{self.sid}/publish", expect=202)
        await self.call("POST", f"/{self.sid}/builds/{b1['id']}/restore", expect=409)  # never went live
        await self.mark_live(b1["id"], "a" * 64)
        await self.call("POST", f"/{self.sid}/builds/{b1['id']}/restore", expect=409)  # already live
        b2 = await self.call("POST", f"/{self.sid}/publish", expect=202)
        await self.mark_live(b2["id"], "b" * 64)
        builds = await self.get(f"/{self.sid}/builds", "viewer")
        self.assertEqual([(x["number"], x["status"], x["live"]) for x in builds],
                         [(2, "live", True), (1, "superseded", False)])
        await self.call("POST", f"/{self.sid}/builds/{b1['id']}/restore", "editor", 403)
        out = await self.call("POST", f"/{self.sid}/builds/{b1['id']}/restore", "admin", 202)
        self.assertEqual((out["job"]["kind"], out["job"]["payload"]["build_id"], out["job"]["payload"]["manifest_hash"]),
                         ("restore", b1["id"], "a" * 64))
        await self.call("POST", f"/{self.sid}/builds/{b1['id']}/restore", "admin", 409)  # one at a time
        job = await self.get(f"/{self.sid}/jobs/{out['job']['id']}", "viewer")
        self.assertEqual(job["status"], "queued")
        other = await self.create("other")
        await self.get(f"/{other['id']}/jobs/{out['job']['id']}", expect=404)
        await self.call("POST", f"/{self.sid}/builds/{ObjectId()}/restore", expect=404)

        await self.call("POST", f"/{self.sid}/unpublish", "editor", 403)
        site = await self.call("POST", f"/{self.sid}/unpublish", "admin")
        self.assertEqual((site["status"], site["live_build_id"], site["job"]["kind"]),
                         ("unpublished", None, "unpublish"))
        self.assertEqual(site["job"]["payload"], {"reason": "unpublish", "slug": "acme"})
        await self.call("POST", f"/{self.sid}/unpublish", "admin", 409)
        b = await self.db["docs_builds"].find_one({"_id": ObjectId(b2["id"])})
        self.assertEqual(b["status"], "superseded")

    async def test_delete_site(self):
        b = await self.call("POST", f"/{self.sid}/publish", expect=202)
        await self.mark_live(b["id"])
        queued = await self.call("POST", f"/{self.sid}/publish", expect=202)
        await self.call("DELETE", f"/{self.sid}", "editor", 403)
        out = await self.call("DELETE", f"/{self.sid}", "admin")
        self.assertEqual((out["deleted"], out["job"]["kind"], out["job"]["payload"]["reason"]),
                         (True, "unpublish", "delete"))
        await self.get(f"/{self.sid}", expect=404)
        job = await self.db["docs_jobs"].find_one({"_id": ObjectId(queued["job"]["id"])})
        self.assertEqual(job["status"], "failed")
        raw = await self.db["docs_sites"].find_one({"_id": ObjectId(self.sid)})
        self.assertEqual((raw.get("slug"), raw["deleted_slug"]), (None, "acme"))
        r = await self.get("/slug-available", params={"slug": "acme"})
        self.assertTrue(r["available"])
        listing = await self.get("", params={"workspace_id": self.ws})
        self.assertEqual(listing["sites"], [])


class Assets(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme")
        self.sid = self.site["id"]

    async def upload(self, data: bytes, name: str = "a.png", who: str = "editor", expect: int = 201) -> dict:
        r = await self.http.post(f"{BASE}/{self.sid}/assets", files={"file": (name, data, "image/png")},
                                 headers=self.h[who])
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def test_upload_dedupes_and_previews(self):
        import hashlib

        out = await self.upload(PNG, "Logo.PNG")
        digest = hashlib.sha256(PNG).hexdigest()
        self.assertEqual(out, {"url": f"/docs-assets/{digest}.png", "name": f"{digest}.png", "size": len(PNG),
                               "content_type": "image/png", "sha256": digest})
        key = f"sites/{self.sid}/assets/{digest}.png"
        self.assertEqual(self.bucket.objects[key]["content_type"], "image/png")
        again = await self.upload(PNG, "copy.png")
        self.assertEqual(again["url"], out["url"])
        self.assertEqual(await self.db["docs_assets"].count_documents({}), 1)
        site = await self.get(f"/{self.sid}")
        self.assertEqual(site["counts"]["storage_bytes"], len(PNG))
        # The editor's preview: no sign-in, a redirect to a short-lived link.
        r = await self.http.get(f"{BASE}/{self.sid}/assets/{digest}.png")
        self.assertEqual((r.status_code, r.headers["location"]), (302, f"https://r2.example/{key}?sig=1"))
        r = await self.http.get(f"{BASE}/{self.sid}/assets/{'0' * 64}.png")
        self.assertEqual(r.status_code, 404)
        r = await self.http.get(f"{BASE}/{self.sid}/assets/..%2Fsecret")
        self.assertEqual(r.status_code, 404)

    async def test_rejections(self):
        await self.upload(PNG, who="viewer", expect=403)
        await self.upload(b"<html><script>alert(1)</script></html>", "x.html", expect=415)
        await self.upload(b"MZ\x90\x00binary", "x.exe", expect=415)
        await self.upload(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "x.svg",
                          expect=415)
        await self.upload(b"<svg xmlns='http://www.w3.org/2000/svg' onload='x()'></svg>", "x.svg", expect=415)
        ok = await self.upload(b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>",
                               "ok.svg")
        self.assertTrue(ok["url"].endswith(".svg"))
        await self.upload(b"", "empty.png", expect=422)
        with mock.patch.object(settings, "docs_asset_max_bytes", 32):
            await self.upload(PNG, expect=413)
        with mock.patch.object(settings, "docs_site_storage_bytes", 100):
            await self.upload(PNG + b"\x01" * 40, "big.png", expect=413)
        self.bucket.configured = False
        await self.upload(PNG + b"\x02", "c.png", expect=503)
        self.bucket.configured = True
        self.bucket.fail = True
        await self.upload(PNG + b"\x03", "d.png", expect=502)
        self.assertEqual(await self.db["docs_assets"].count_documents({"sha256": {"$exists": True}}), 1)

    async def test_text_files(self):
        out = await self.upload(b"a,b\n1,2\n", "data.csv")
        self.assertTrue(out["url"].endswith(".csv"))
        await self.upload(b"\xff\xfe\x00bad", "bad.txt", expect=415)
        pdf = await self.upload(b"%PDF-1.7\n...", "doc.pdf")
        self.assertEqual(pdf["content_type"], "application/pdf")


class SettingsUnit(unittest.TestCase):
    def test_css_problem_allows_ordinary_css(self):
        for css in (".a > .b { color: #fff }", "@media (max-width: 600px) { .x { display: none } }",
                    ".a::before { content: \"→\" }", "@font-face { font-family: X; src: url(https://f.test/x.woff2) }"):
            self.assertIsNone(site_settings.css_problem(css), css)

    def test_defaults_validate(self):
        self.assertEqual(site_settings.validate(site_settings.default_settings()), site_settings.default_settings())

    def test_public_view_hides_hash(self):
        out = site_settings.public_view({"access": {"level": "password", "password_hash": "$2b$x"}})
        self.assertEqual(out["access"], {"level": "password", "has_password": True})


class Indexes(DocsSitesCase):
    async def test_indexes(self):
        from app.services import docs_site_store

        await docs_site_store.ensure_indexes(self.db)  # idempotent
        names = {i["name"] for i in await self.db["docs_sites"].list_indexes().to_list(length=20)}
        self.assertIn("slug_unique", names)
        for coll in ("docs_pages", "docs_page_versions", "docs_builds", "docs_snapshots", "docs_reviews",
                     "docs_jobs", "docs_assets", "docs_events"):
            idx = await self.db[coll].list_indexes().to_list(length=20)
            self.assertGreater(len(idx), 1, coll)
